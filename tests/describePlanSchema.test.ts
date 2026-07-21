/**
 * describe_plan_schema: serves the engine's versioned Plan JSON Schema (full and
 * sliced), stamps the schemaVersion, and errors on an unknown path. The same
 * schema is also reachable as an MCP resource — exercised end-to-end over an
 * in-memory client/server pair so the registration wiring is genuinely covered.
 */

import { describe, expect, it } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { planJsonSchema, PLAN_SCHEMA_VERSION, PLAN_SCHEMA_ID } from '@retiregolden/engine/schema'
import * as adapter from '../src/adapter.js'
import { registerResources } from '../src/tools.js'

describe('describe_plan_schema tool', () => {
  it('returns the full schema plus schemaVersion when no path is given', () => {
    const res = adapter.describePlanSchema()
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.schemaVersion).toBe(PLAN_SCHEMA_VERSION)
    expect(res.path).toBeNull()
    expect(res.schema).toEqual(planJsonSchema)
    // Top-level plan properties are present, so a client can author against it.
    const schema = res.schema as unknown as { properties: Record<string, unknown> }
    expect(schema.properties).toHaveProperty('accounts')
    expect(schema.properties).toHaveProperty('assumptions')
  })

  it('slices a subtree via a dotted path', () => {
    const res = adapter.describePlanSchema({ path: 'properties.accounts.items' })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.path).toBe('properties.accounts.items')
    expect(res.schema).toEqual(
      (planJsonSchema as unknown as { properties: { accounts: { items: unknown } } }).properties
        .accounts.items,
    )
    // The subtree is strictly smaller than the whole document.
    expect(JSON.stringify(res.schema).length).toBeLessThan(JSON.stringify(planJsonSchema).length)
  })

  it('slices the same subtree via an equivalent JSON pointer', () => {
    const dotted = adapter.describePlanSchema({ path: 'properties.accounts.items' })
    const pointer = adapter.describePlanSchema({ path: '/properties/accounts/items' })
    expect(pointer.ok).toBe(true)
    if (!pointer.ok || !dotted.ok) return
    expect(pointer.schema).toEqual(dotted.schema)
  })

  it('errors with PATH_NOT_FOUND on an unknown path (still stamping version + id)', () => {
    const res = adapter.describePlanSchema({ path: 'properties.nope.missing' })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toBe('PATH_NOT_FOUND')
    expect(res.path).toBe('properties.nope.missing')
    expect(res.schemaVersion).toBe(PLAN_SCHEMA_VERSION)
    expect(res.schemaId).toBe(PLAN_SCHEMA_ID)
  })

  it('returns a clone: mutating the response does not corrupt later responses', () => {
    const first = adapter.describePlanSchema()
    expect(first.ok).toBe(true)
    if (!first.ok) return
    // A programmatic consumer mutates the returned schema in place.
    ;(first.schema as { properties: Record<string, unknown> }).properties.__hacked = true
    const second = adapter.describePlanSchema()
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect((second.schema as { properties: Record<string, unknown> }).properties.__hacked).toBeUndefined()
    // The engine's shared constant is likewise untouched.
    expect((planJsonSchema as { properties: Record<string, unknown> }).properties.__hacked).toBeUndefined()
  })
})

describe('plan-schema MCP resource', () => {
  it('serves the same planJsonSchema document over resources/read', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' })
    registerResources(server)
    const client = new Client({ name: 'test-client', version: '0.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const listed = await client.listResources()
    const entry = listed.resources.find((r) => r.uri === PLAN_SCHEMA_ID)
    expect(entry).toBeDefined()
    expect(entry?.name).toBe('plan-schema')

    const read = await client.readResource({ uri: PLAN_SCHEMA_ID })
    expect(read.contents).toHaveLength(1)
    const content = read.contents[0] as { mimeType?: string; text: string }
    expect(content.mimeType).toBe('application/json')
    expect(JSON.parse(content.text)).toEqual(planJsonSchema)

    await client.close()
    await server.close()
  })
})
