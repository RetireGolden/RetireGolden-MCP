/**
 * Guards against drift between the declarative tool table (src/toolTable.ts) and
 * the versioned contract file (schemas/tools.v1.json). The table is the source
 * of truth; this test asserts the JSON mirrors its tool names and arm groupings
 * exactly, in declaration order.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { TOOL_TABLE, ARM_JSON_KEY, type ArmName } from '../src/toolTable.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const contractPath = path.resolve(here, '../schemas/tools.v1.json')
const contract = JSON.parse(readFileSync(contractPath, 'utf8')) as {
  tools: string[]
  calculator_arm: string[]
  optimizer_arm: string[]
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
