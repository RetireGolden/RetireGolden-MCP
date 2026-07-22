/**
 * The authorization hook's contract, and the baseline it must not disturb.
 *
 * There was no test for registerTools before this file, so "public MCP behavior
 * is unchanged without the callback" had no baseline to re-run — it is authored
 * here. Every assertion is written so that a regression in the no-callback path
 * fails, not just a regression in the hook.
 */

import { describe, expect, it } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createSession } from '../src/session.js'
import { registerTools, type AuthorizeTool } from '../src/tools.js'
import { TOOL_TABLE } from '../src/toolTable.js'
import { singleHousehold, singlePolicy } from './fixtures.js'

async function connect(authorize?: AuthorizeTool) {
  const server = new McpServer({ name: 'test', version: '0.0.0' })
  const session = createSession()
  registerTools(server, session, authorize ? { authorize } : {})
  const client = new Client({ name: 'test-client', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return {
    client,
    session,
    async close() {
      await client.close()
      await server.close()
    },
  }
}

function payload(result: { content: unknown }): unknown {
  const text = (result.content as { type: string; text: string }[]).find(
    (c) => c.type === 'text',
  )?.text
  expect(text, 'tool returned no text content').toBeTruthy()
  return JSON.parse(text as string)
}

const seed = { household: singleHousehold, policy: singlePolicy, startYear: 2026 }

describe('registerTools — the no-callback path is unchanged', () => {
  it('advertises an identical inventory with no options, empty options, and an allowing callback', async () => {
    const bare = await connect()
    const empty = await connect(undefined)
    const allowing = await connect(() => ({ allow: true }))
    try {
      const names = TOOL_TABLE.map((t) => t.name)
      for (const [label, h] of [
        ['bare', bare],
        ['empty options', empty],
        ['allowing callback', allowing],
      ] as const) {
        const listed = (await h.client.listTools()).tools
        expect(listed.map((t) => t.name), label).toEqual(names)
      }
      // Descriptors, not just names — a hook must not perturb schemas either.
      const a = (await bare.client.listTools()).tools
      const b = (await allowing.client.listTools()).tools
      expect(b).toEqual(a)
    } finally {
      await Promise.all([bare.close(), empty.close(), allowing.close()])
    }
  })

  it('returns identical results with and without an allowing callback', async () => {
    const bare = await connect()
    const allowing = await connect(() => ({ allow: true }))
    try {
      for (const h of [bare, allowing]) {
        await h.client.callTool({ name: 'build_plan', arguments: seed })
      }
      for (const name of ['get_session', 'export_plan', 'describe_plan_schema']) {
        const x = payload(await bare.client.callTool({ name, arguments: {} }))
        const y = payload(await allowing.client.callTool({ name, arguments: {} }))
        expect(y, `${name} diverged under an allowing callback`).toEqual(x)
      }
    } finally {
      await Promise.all([bare.close(), allowing.close()])
    }
  })
})

describe('registerTools — refusal', () => {
  const deny = { ok: false, error: 'MCP_DISABLED', message: 'AI access is turned off.' }

  it('refuses every tool with the exact payload the callback supplied', async () => {
    const h = await connect(() => ({ allow: false, result: deny }))
    const schemaGated: string[] = []
    try {
      for (const tool of TOOL_TABLE) {
        const res = await h.client.callTool({ name: tool.name, arguments: {} })
        if (res.isError) {
          // The SDK validates the argument shape BEFORE invoking the handler, so
          // a tool with required arguments never reaches the gate when called
          // with none. That is safe — no handler runs and nothing is exposed —
          // but it means a denied caller sending malformed arguments sees a
          // protocol validation error rather than the policy refusal. Recorded,
          // not papered over; the next test covers the data-carrying tool with
          // VALID arguments, where the gate is genuinely what stands in the way.
          schemaGated.push(tool.name)
          continue
        }
        expect(payload(res), `${tool.name} was not refused`).toEqual(deny)
        // A refusal is a normal result, not a protocol error: an isError result
        // flattens to a message string and loses the code and the remedy.
        expect(res.isError, `${tool.name} refused via isError`).toBeFalsy()
      }
      // Every tool is accounted for, and most need no arguments at all.
      expect(schemaGated.length).toBeLessThan(TOOL_TABLE.length)
      expect(TOOL_TABLE.length - schemaGated.length).toBeGreaterThanOrEqual(5)
    } finally {
      await h.close()
    }
  })

  it('refuses a tool called with fully valid arguments', async () => {
    // The case that matters: build_plan passes schema validation, so the gate is
    // genuinely the thing standing between the caller and the handler.
    const h = await connect(() => ({ allow: false, result: deny }))
    try {
      const res = await h.client.callTool({ name: 'build_plan', arguments: seed })
      expect(payload(res)).toEqual(deny)
      expect(res.isError).toBeFalsy()
    } finally {
      await h.close()
    }
  })

  it('runs BEFORE the handler, so a denied call cannot mutate the session', async () => {
    // The property the whole permission model rests on. If the gate ran after
    // the handler, a denied build_plan would still have loaded the plan.
    const h = await connect(() => ({ allow: false, result: deny }))
    try {
      expect(payload(await h.client.callTool({ name: 'build_plan', arguments: seed }))).toEqual(deny)
      expect(h.session.plan, 'denied build_plan still mutated the session').toBeFalsy()
    } finally {
      await h.close()
    }
  })

  it('awaits an async callback rather than treating the promise as a decision', async () => {
    // A returned Promise is truthy, so a missing `await` would read
    // `decision.allow` as undefined and ALLOW every call. Fail-open, silently.
    const h = await connect(
      async () =>
        new Promise((resolve) => setTimeout(() => resolve({ allow: false, result: deny }), 5)),
    )
    try {
      expect(payload(await h.client.callTool({ name: 'get_session', arguments: {} }))).toEqual(deny)
    } finally {
      await h.close()
    }
  })

  it('is consulted per call, so a decision can change between calls', async () => {
    let allowed = true
    const h = await connect(() => (allowed ? { allow: true } : { allow: false, result: deny }))
    try {
      expect(payload(await h.client.callTool({ name: 'get_session', arguments: {} }))).not.toEqual(
        deny,
      )
      allowed = false
      expect(payload(await h.client.callTool({ name: 'get_session', arguments: {} }))).toEqual(deny)
    } finally {
      await h.close()
    }
  })

  it('tells the callback the tool name and entry, and never the arguments', async () => {
    // Withholding args is what keeps plan documents out of a host's policy and
    // logging surfaces. Assert it structurally, not by convention.
    const seen: Record<string, unknown>[] = []
    const h = await connect((req) => {
      seen.push(req as unknown as Record<string, unknown>)
      return { allow: true }
    })
    try {
      await h.client.callTool({ name: 'build_plan', arguments: seed })
      expect(seen).toHaveLength(1)
      expect(Object.keys(seen[0]!).sort()).toEqual(['entry', 'name'])
      expect(seen[0]!.name).toBe('build_plan')
      // Assert on argument VALUES, not field names: the entry legitimately
      // carries the input SCHEMA, whose keys include 'startYear'. What must
      // never appear is what the user actually supplied.
      const serialized = JSON.stringify(seen[0])
      expect(serialized).not.toContain('800000')
      expect(serialized).not.toContain('"KY"')
    } finally {
      await h.close()
    }
  })
})

describe('tool data scope', () => {
  it('classifies every table entry, with describe_plan_schema the only session-free tool', () => {
    for (const tool of TOOL_TABLE) {
      expect(['none', 'session'], `${tool.name} has an unknown dataScope`).toContain(tool.dataScope)
    }
    expect(TOOL_TABLE.filter((t) => t.dataScope === 'none').map((t) => t.name)).toEqual([
      'describe_plan_schema',
    ])
  })
})
