/**
 * Keys the typed `build_plan` inputs strip are named, not lost.
 *
 * `HouseholdParamsSchema`, `PolicyParamsSchema`, `AssumptionsSchema` and
 * `ConversionSchema` are plain `z.object`s: parsing strips a key they do not
 * declare instead of refusing the call, so `onsetMonth` on a person vanished
 * without a word. They stay non-strict (`.strict()` would change the published
 * input schema and refuse calls that work today); the build names every
 * stripped key in a `fields dropped:` caveat instead, on each path a call can
 * take: programmatic, stdio (the SDK parses first) and the HTTP gateway.
 */

import { describe, expect, it } from 'vitest'
import { McpServer, InMemoryTransport } from '@modelcontextprotocol/server'
import { Client } from '@modelcontextprotocol/client'
import * as adapter from '../src/adapter.js'
import { buildPlanFromParams, typedArgumentsDropped } from '../src/buildPlan.js'
import { createSession } from '../src/session.js'
import { registerTools } from '../src/tools.js'
import { getTool, parseToolArgs } from '../src/toolTable.js'
import { singleHousehold, singlePolicy } from './fixtures.js'

/** A typed call carrying three keys the typed schemas do not declare. */
const withUnknownKeys = {
  household: {
    ...singleHousehold,
    persons: [{ ...singleHousehold.persons[0]!, onsetMonth: 3 }],
  },
  policy: { ...singlePolicy, claimAge: 67 },
  assumptions: { inflationPct: 2.5, inflation: 3 },
  startYear: 2026,
}
const PATHS = ['household.persons.0.onsetMonth', 'policy.claimAge', 'assumptions.inflation']

const dropped = (caveats: string[]) => caveats.filter((c) => c.startsWith('fields dropped:'))

function expectNamed(caveats: string[]) {
  const [caveat, ...rest] = dropped(caveats)
  expect(rest).toEqual([])
  expect(caveat).toContain("the build_plan arguments carried 3 fields build_plan's typed inputs do not read")
  for (const path of PATHS) expect(caveat).toContain(path)
}

describe('typed build_plan arguments', () => {
  it('names each stripped key, at any depth, without refusing (programmatic)', () => {
    expect(typedArgumentsDropped(withUnknownKeys)).toEqual(PATHS)
    const res = buildPlanFromParams(withUnknownKeys as never)
    expect(res.ok).toBe(true)
    expect('issues' in res ? res.issues : []).toEqual([])
    expectNamed(res.caveats)
  })

  it('a clean typed call drops nothing', () => {
    const res = buildPlanFromParams({ household: singleHousehold, policy: singlePolicy, startYear: 2026 })
    expect(res.ok).toBe(true)
    expect(dropped(res.caveats)).toEqual([])
    expect(typedArgumentsDropped({ household: singleHousehold, policy: singlePolicy })).toEqual([])
  })

  it('names them over stdio, where the SDK hands the handler the parsed arguments', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' })
    const session = createSession(2026)
    registerTools(server, session)
    const client = new Client({ name: 'test-client', version: '0.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport as Parameters<Client['connect']>[0]),
    ])
    try {
      const result = await client.callTool({ name: 'build_plan', arguments: withUnknownKeys })
      const content = (result as { content: Array<{ type: string; text: string }> }).content
      const payload = JSON.parse(content.find((c) => c.type === 'text')!.text) as {
        ok: boolean
        caveats: string[]
      }
      expect(payload.ok).toBe(true)
      expectNamed(payload.caveats)
      // The parsed arguments still reached the session: no stripped key did.
      const person = session.plan!.household.people[0] as unknown as Record<string, unknown>
      expect('onsetMonth' in person).toBe(false)

      const clean = await client.callTool({
        name: 'build_plan',
        arguments: { household: singleHousehold, policy: singlePolicy, startYear: 2026 },
      })
      const cleanPayload = JSON.parse(
        (clean as { content: Array<{ type: string; text: string }> }).content[0]!.text,
      ) as { caveats: string[] }
      expect(dropped(cleanPayload.caveats)).toEqual([])
    } finally {
      await client.close()
      await server.close()
    }
  })

  it('names them through the gateway path, which parses before the handler runs', () => {
    const entry = getTool('build_plan')!
    const parsed = parseToolArgs(entry, withUnknownKeys as unknown as Record<string, unknown>)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const res = entry.handler(createSession(2026), parsed.args) as { ok: boolean; caveats: string[] }
    expect(res.ok).toBe(true)
    expectNamed(res.caveats)
  })

  it('leaves typed fields alone when full plan JSON takes precedence', () => {
    const built = buildPlanFromParams({ household: singleHousehold, policy: singlePolicy, startYear: 2026 })
    if (!built.ok) throw new Error('build failed')
    const res = adapter.setPlanFromBuild(createSession(2026), {
      ...(withUnknownKeys as object),
      plan: JSON.parse(JSON.stringify(built.plan)),
    } as never)
    expect(res.ok).toBe(true)
    expect(dropped(res.caveats)).toEqual([])
  })
})
