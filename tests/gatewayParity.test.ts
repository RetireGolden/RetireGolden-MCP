/**
 * Gateway-exposure parity: the HTTP gateway must reach exactly the tools flagged
 * httpExposed in the declarative table and reject every other tool as
 * UNKNOWN_TOOL. Driven from TOOL_TABLE so adding a tool cannot silently drift
 * the transport surface. (schemas/tools.v1.json name/arm parity lives in
 * tests/registry-parity.test.ts.)
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TOOL_TABLE } from '../src/toolTable.js'
import { startTestGateway, type TestGateway } from './helpers/gateway.js'

let gateway: TestGateway

function post(tool: string): Promise<Response> {
  return gateway.post({ tool, arguments: {} }, { 'x-session-id': 'parity' })
}

describe('gateway exposure parity', () => {
  beforeAll(async () => {
    gateway = await startTestGateway()
  })

  afterAll(async () => {
    await gateway.close()
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
