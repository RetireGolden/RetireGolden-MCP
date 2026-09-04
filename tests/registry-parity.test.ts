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
