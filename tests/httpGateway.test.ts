import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import { singleHousehold, singlePolicy } from './fixtures.js'

// A fixed ephemeral-ish port for the stub; the gateway reads PORT at import time,
// so it must be set before the dynamic import below.
const PORT = 8794
const BASE = `http://127.0.0.1:${PORT}`

let server: Server | undefined

async function waitForHealth(tries = 100): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${BASE}/health`)
      if (r.ok) return
    } catch {
      // server not up yet
    }
    await new Promise((res) => setTimeout(res, 20))
  }
  throw new Error('http gateway did not become healthy')
}

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
    process.env.PORT = String(PORT)
    process.env.RETIREGOLDEN_HTTP_HOST = '127.0.0.1'
    const { startHttpGateway } = await import('../src/http/gateway.js')
    await startHttpGateway()
    await waitForHealth()
    // Capture the listening http.Server so it can be closed in afterAll (the
    // gateway does not return a handle). A listening server exposes both
    // `.close()` and `.listening === true`, distinguishing it from the
    // accepted connection sockets that share the same local port.
    const handles = (process as unknown as { _getActiveHandles(): unknown[] })._getActiveHandles()
    for (const h of handles) {
      const s = h as Server & { listening?: boolean }
      if (typeof s.close === 'function' && s.listening === true) {
        const addr = s.address?.()
        if (addr && typeof addr === 'object' && (addr as { port?: number }).port === PORT) {
          server = s
        }
      }
    }
  })

  afterAll(async () => {
    if (server) await new Promise<void>((res) => server!.close(() => res()))
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

  it('rejects an oversized request body (413 or connection reset)', async () => {
    // Well over the 1 MiB cap. The gateway destroys the socket on overflow, so
    // the client may observe either a clean 413 or a connection reset — both
    // prove the body was refused rather than processed.
    const big = 'x'.repeat(2 * 1024 * 1024)
    let outcome: number | 'threw' = 'threw'
    try {
      const r = await post(
        { tool: 'explain_modeled_result', arguments: { pad: big } },
        { 'x-session-id': 'oversize' },
      )
      outcome = r.status
    } catch {
      outcome = 'threw'
    }
    expect(outcome === 413 || outcome === 'threw').toBe(true)
    expect(outcome).not.toBe(200)
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

  it('routes unknown tools to a 400', async () => {
    const r = await post({ tool: 'no_such_tool' }, { 'x-session-id': 'A' })
    expect(r.status).toBe(400)
    expect(((await r.json()) as { error: string }).error).toBe('UNKNOWN_TOOL')
  })
})
