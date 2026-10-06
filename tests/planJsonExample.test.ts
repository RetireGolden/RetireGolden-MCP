/**
 * The example plan document in skills/retiregolden/references/plan-json.md is
 * one the current engine writes and reads: it builds, nothing in it is
 * dropped, and nothing refuses it. A schema change that the example falls
 * behind fails here rather than in an agent's hands.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PLAN_SCHEMA_VERSION } from '@retiregolden/engine/schema/current'
import { buildPlanFromParams } from '../src/buildPlan.js'

const docPath = fileURLToPath(new URL('../skills/retiregolden/references/plan-json.md', import.meta.url))

function exampleDocument(): Record<string, unknown> {
  const markdown = readFileSync(docPath, 'utf8')
  const blocks = markdown.split('```json').slice(1)
  expect(blocks, 'plan-json.md has exactly one json block').toHaveLength(1)
  return JSON.parse(blocks[0]!.split('```')[0]!) as Record<string, unknown>
}

describe('plan-json.md example', () => {
  it('builds with build_plan, drops nothing, and is refused by nothing', () => {
    const doc = exampleDocument()
    expect(doc.schemaVersion).toBe(PLAN_SCHEMA_VERSION)
    const res = buildPlanFromParams({ plan: doc, startYear: 2026 })
    expect('issues' in res ? res.issues : []).toEqual([])
    expect(res.ok).toBe(true)
    expect(res.caveats.filter((c) => c.startsWith('fields dropped:'))).toEqual([])
    expect(res.caveats.filter((c) => c.includes('plan-schema migration:'))).toEqual([])
  })
})
