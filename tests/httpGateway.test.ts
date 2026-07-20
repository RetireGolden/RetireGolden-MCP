import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { singleHousehold, singlePolicy } from './fixtures.js'

let server: Server
let BASE = ''

function post(
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${BASE}/tool`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

const buildBody = {
  tool: 'build_plan',
  arguments: { household: singleHousehold, policy: singlePolicy, startYear: 2026 },
}

describe('HTTP gateway (Phase 6 stub) integration', () => {
  beforeAll(async () => {
    const { startHttpGateway } = await import('../src/http/gateway.js')
    server = await startHttpGateway({ port: 0, host: '127.0.0.1' })
    const addr = server.address() as AddressInfo
    BASE = `http://127.0.0.1:${addr.port}`
  })

  afterAll(async () => {
    await new Promise<void>((res) => server.close(() => res()))
  })

  it('serves /health', async () => {
    const r = await fetch(`${BASE}/health`)
    expect(r.status).toBe(200)
    const body = (await r.json()) as { ok: boolean; transport: string }
    expect(body.ok).toBe(true)
    expect(body.transport).toBe('http-stub')
  })

  it('rejects a request with no x-session-id header (400)', async () => {
    const r = await post({ tool: 'explain_modeled_result' })
    expect(r.status).toBe(400)
    const body = (await r.json()) as { error: string }
    expect(body.error).toBe('MISSING_SESSION_ID')
  })

  it('rejects an over-long x-session-id (400)', async () => {
    const r = await post(
      { tool: 'explain_modeled_result' },
      { 'x-session-id': 'x'.repeat(200) },
    )
    expect(r.status).toBe(400)
    expect(((await r.json()) as { error: string }).error).toBe('INVALID_SESSION_ID')
  })

  it('rejects an oversized request body with a clean 413', async () => {
    const big = 'x'.repeat(2 * 1024 * 1024)
    const r = await post(
      { tool: 'explain_modeled_result', arguments: { pad: big } },
      { 'x-session-id': 'oversize' },
    )
    expect(r.status).toBe(413)
    expect(((await r.json()) as { error: string }).error).toBe('PAYLOAD_TOO_LARGE')
  })

  it('does not burn a session slot on an invalid request', async () => {
    const before = ((await (await fetch(`${BASE}/health`)).json()) as { sessions: number })
      .sessions
    await post('not json at all', { 'x-session-id': 'never-created-1' })
    await post({ tool: 'no_such_tool' }, { 'x-session-id': 'never-created-2' })
    await post(
      { tool: 'batch_evaluate', arguments: { policies: [] } },
      { 'x-session-id': 'never-created-3' },
    )
    const after = ((await (await fetch(`${BASE}/health`)).json()) as { sessions: number })
      .sessions
    expect(after).toBe(before)
  })

  it('isolates state between two different session ids', async () => {
    // Session A builds a plan; session B never does.
    const built = await post(buildBody, { 'x-session-id': 'A' })
    expect(built.status).toBe(200)
    expect(((await built.json()) as { ok: boolean }).ok).toBe(true)

    const projB = await post({ tool: 'run_projection' }, { 'x-session-id': 'B' })
    expect(projB.status).toBe(200)
    expect((await projB.json()) as unknown).toMatchObject({ ok: false, error: 'NO_PLAN' })

    const projA = await post({ tool: 'run_projection' }, { 'x-session-id': 'A' })
    expect(projA.status).toBe(200)
    expect(((await projA.json()) as { ok: boolean }).ok).toBe(true)
  })

  it('rejects a batch of more than 500 policies (400)', async () => {
    const policies = Array.from({ length: 501 }, () => ({
      claim_ages: [67],
      ordering: 'taxable-first',
    }))
    const r = await post(
      { tool: 'batch_evaluate', arguments: { policies } },
      { 'x-session-id': 'A' },
    )
    expect(r.status).toBe(400)
    const body = (await r.json()) as { error: string; message: string }
    expect(body.error).toBe('INVALID_ARGS')
    expect(body.message).toContain('500')
  })

  it('rejects an empty policies array and a bad ordering enum (400)', async () => {
    const empty = await post(
      { tool: 'batch_evaluate', arguments: { policies: [] } },
      { 'x-session-id': 'A' },
    )
    expect(empty.status).toBe(400)
    expect(((await empty.json()) as { error: string }).error).toBe('INVALID_ARGS')

    const badEnum = await post(
      {
        tool: 'batch_evaluate',
        arguments: { policies: [{ claim_ages: [67], ordering: 'roth-first' }] },
      },
      { 'x-session-id': 'A' },
    )
    expect(badEnum.status).toBe(400)
    expect(((await badEnum.json()) as { error: string }).error).toBe('INVALID_ARGS')
  })

  it('requires policy alongside household on build_plan (400)', async () => {
    const r = await post(
      { tool: 'build_plan', arguments: { household: singleHousehold } },
      { 'x-session-id': 'A' },
    )
    expect(r.status).toBe(400)
    const body = (await r.json()) as { error: string; message: string }
    expect(body.error).toBe('INVALID_ARGS')
    expect(body.message).toContain('household')
  })

  it('routes unknown tools to a 400', async () => {
    const r = await post({ tool: 'no_such_tool' }, { 'x-session-id': 'A' })
    expect(r.status).toBe(400)
    expect(((await r.json()) as { error: string }).error).toBe('UNKNOWN_TOOL')
  })
})
