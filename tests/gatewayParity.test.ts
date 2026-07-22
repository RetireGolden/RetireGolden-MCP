/**
 * Gateway-exposure parity: the HTTP gateway must reach exactly the tools flagged
 * httpExposed in the declarative table and reject every other tool as
 * UNKNOWN_TOOL. Driven from TOOL_TABLE so adding a tool cannot silently drift
 * the transport surface. (schemas/tools.v1.json name/arm parity lives in
 * tests/registry-parity.test.ts.)
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { TOOL_TABLE } from '../src/toolTable.js'

let server: Server
let BASE = ''

function post(tool: string): Promise<Response> {
  return fetch(`${BASE}/tool`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session-id': 'parity' },
    body: JSON.stringify({ tool, arguments: {} }),
  })
}

describe('gateway exposure parity', () => {
  beforeAll(async () => {
    // The gateway is a fenced research surface and refuses to start without an
    // explicit opt-in; these suites are exercising it deliberately.
    process.env.RETIREGOLDEN_HTTP_GATEWAY = '1'
    const { startHttpGateway } = await import('../src/http/gateway.js')
    server = await startHttpGateway({ port: 0, host: '127.0.0.1' })
    const addr = server.address() as AddressInfo
    BASE = `http://127.0.0.1:${addr.port}`
  })

  afterAll(async () => {
    await new Promise<void>((res) => server.close(() => res()))
  })

  it('rejects every non-exposed tool with UNKNOWN_TOOL', async () => {
    for (const t of TOOL_TABLE.filter((e) => !e.httpExposed)) {
      const r = await post(t.name)
      expect(r.status).toBe(400)
      expect(((await r.json()) as { error: string }).error).toBe('UNKNOWN_TOOL')
    }
  })

  it('reaches every httpExposed tool (never UNKNOWN_TOOL)', async () => {
    for (const t of TOOL_TABLE.filter((e) => e.httpExposed)) {
      const r = await post(t.name)
      const body = (await r.json()) as { error?: string }
      // Empty args may yield INVALID_ARGS or a NO_PLAN result, but the tool must
      // be recognized by the transport — never routed to UNKNOWN_TOOL.
      expect(body.error).not.toBe('UNKNOWN_TOOL')
    }
  })
})
