/**
 * Guards against drift between the declarative tool table (src/toolTable.ts) and
 * the versioned contract file (schemas/tools.v1.json). The table is the source
 * of truth; this test asserts the JSON mirrors its tool names, arm groupings and
 * per-tool argument schemas exactly, in declaration order.
 *
 * The `inputSchemas` assertion is what makes the contract a contract: names and
 * arms alone let an argument shape change without moving a byte of the committed
 * file. Regenerate with `pnpm run contract:generate` when the change is
 * intentional, so the new shape lands in the PR diff.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { TOOL_TABLE, ARM_JSON_KEY, type ArmName, type ToolEntry } from '../src/toolTable.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const contractPath = path.resolve(here, '../schemas/tools.v1.json')
const contract = JSON.parse(readFileSync(contractPath, 'utf8')) as {
  contractVersion: number
  $schema?: unknown
  tools: string[]
  calculator_arm: string[]
  optimizer_arm: string[]
  inputSchemas: Record<string, unknown>
}

/**
 * The recorded `tools/list` response — a real `client.listTools()` round trip
 * captured by scripts/capture-protocol-baseline.mjs, i.e. the schemas the SDK
 * actually advertises rather than anything this repo re-derives. It is what the
 * contract is held against below.
 */
const baselinePath = path.resolve(here, './protocol-baseline/baseline.json')
const wireInputSchemas = new Map<string, unknown>(
  (
    JSON.parse(readFileSync(baselinePath, 'utf8')) as {
      inventory: { canonical: { tools: { name: string; inputSchema: unknown }[] } }
    }
  ).inventory.canonical.tools.map((tool) => [tool.name, tool.inputSchema]),
)

/**
 * The generator is plain `.mjs` with no declarations, so it is loaded the same
 * way tests/protocolBaseline.test.ts loads the baseline capture: a runtime URL
 * import narrowed by an explicit interface. Sharing the function (rather than
 * re-deriving the schemas here) is the point — a test with its own copy of the
 * conversion options could pass while `contract:generate` writes something else.
 */
const generatorUrl = new URL('../scripts/gen-tool-contract.mjs', import.meta.url).href
interface ContractGenerator {
  buildInputSchemas: (toolTable: readonly ToolEntry[]) => Record<string, unknown>
}

function armMembers(arm: ArmName): string[] {
  return TOOL_TABLE.filter((t) => t.arms.includes(arm)).map((t) => t.name)
}

describe('tool registry / contract parity', () => {
  it('lists every table tool, in order, in schemas/tools.v1.json', () => {
    expect(contract.tools).toEqual(TOOL_TABLE.map((t) => t.name))
  })

  it('has no duplicate tool names in the table', () => {
    const names = TOOL_TABLE.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('mirrors each arm grouping between the table and the contract', () => {
    for (const arm of Object.keys(ARM_JSON_KEY) as ArmName[]) {
      const key = ARM_JSON_KEY[arm]
      expect(contract[key as 'calculator_arm' | 'optimizer_arm']).toEqual(armMembers(arm))
    }
  })

  it('references only known tools from every contract arm', () => {
    const known = new Set(TOOL_TABLE.map((t) => t.name))
    for (const key of Object.values(ARM_JSON_KEY)) {
      for (const name of contract[key as 'calculator_arm' | 'optimizer_arm']) {
        expect(known.has(name)).toBe(true)
      }
    }
  })

  it('publishes one input schema per table tool, in order', () => {
    expect(Object.keys(contract.inputSchemas)).toEqual(TOOL_TABLE.map((t) => t.name))
  })

  it('matches the committed input schemas to the live table', async () => {
    const generator = (await import(generatorUrl)) as ContractGenerator
    expect(contract.inputSchemas).toEqual(generator.buildInputSchemas(TOOL_TABLE))
  })

  /**
   * The assertion above only proves the committed file agrees with the
   * generator. That leaves the question the contract actually exists to answer:
   * does the published schema match what a client is SENT? A generator option
   * (or an SDK conversion change) could move one and not the other, and the
   * table-side check would stay green.
   *
   * So hold the block against the recorded `tools/list` inventory as well. The
   * two are deep-equal today, and that is not a coincidence of formatting — it
   * is why `JSON_SCHEMA_OPTIONS` sets `io: 'input'`. Zod's default output mode
   * appends `additionalProperties: false`, which the wire schema does not carry
   * (`z.object` strips unknown keys instead of rejecting them), and under it
   * every one of the 14 blocks disagreed with the SDK's own rendering.
   *
   * A failure here is a real contract defect, not a stale golden: fix whichever
   * side moved. Note this reads baseline.json rather than writing it — the
   * baseline is regenerated only by a deliberate `pnpm run baseline:capture`.
   */
  it('publishes the same schemas tools/list advertises', () => {
    expect(wireInputSchemas.size).toBe(TOOL_TABLE.length)
    for (const entry of TOOL_TABLE) {
      expect(wireInputSchemas.has(entry.name)).toBe(true)
      expect(contract.inputSchemas[entry.name]).toEqual(wireInputSchemas.get(entry.name))
    }
  })

  it('does not claim the contract document is itself a JSON Schema', () => {
    // The document has no `type`/`properties` of its own — it is a manifest that
    // CARRIES JSON Schemas. `contractVersion` versions the tool contract; the
    // per-tool entries under `inputSchemas` are the real schemas and carry their
    // own `$schema`.
    expect(contract.$schema).toBeUndefined()
    expect(contract.contractVersion).toBe(1)
  })

  it('exposes exactly the five HTTP-gateway tools', () => {
    const exposed = TOOL_TABLE.filter((t) => t.httpExposed).map((t) => t.name)
    expect(exposed).toEqual([
      'build_plan',
      'run_projection',
      'batch_evaluate',
      'run_optimizer',
      'explain_modeled_result',
    ])
  })
})
