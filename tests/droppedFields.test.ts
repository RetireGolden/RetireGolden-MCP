/**
 * Fields the engine's `parsePlan` drops from a supplied document are named,
 * whatever the document's version siblings say. Engine 0.3.0 dropped
 * `incomes[].disability.onsetMonth` that way, and nothing said so. A skew
 * caveat that fires names them itself; otherwise a `fields dropped:` caveat
 * does. They are never reported twice.
 */

import { describe, expect, it } from 'vitest'
import { buildPlanFromParams, droppedFields } from '../src/buildPlan.js'
import { getVersions } from '../src/versions.js'
import { PLAN_SCHEMA_VERSION } from '@retiregolden/engine/schema/current'
import { builtOk, mfjHousehold, mfjPolicy } from './fixtures.js'

/** A real v7 export with two fields this engine does not read planted in it. */
function documentWithUnknownFields() {
  const built = buildPlanFromParams({ household: mfjHousehold, policy: mfjPolicy, startYear: 2026 })
  const doc = JSON.parse(JSON.stringify(builtOk(built).plan)) as Record<string, unknown> & {
    incomes: Array<Record<string, unknown>>
    assumptions: Record<string, unknown>
  }
  const ss = doc.incomes.findIndex((income) => income.type === 'socialSecurity')
  doc.incomes[ss]!.futureField = 1
  doc.assumptions.newKnob = true
  return { doc, paths: [`incomes.${ss}.futureField`, 'assumptions.newKnob'] }
}

const droppedCaveats = (caveats: string[]) => caveats.filter((c) => c.startsWith('fields dropped:'))
const skewCaveats = (caveats: string[]) => caveats.filter((c) => c.includes(' skew: '))

describe('fields the engine drops from a supplied document', () => {
  it('are named with no version siblings at all', () => {
    const { doc, paths } = documentWithUnknownFields()
    const res = buildPlanFromParams({ plan: doc, startYear: 2026 })
    expect(res.ok).toBe(true)
    const [caveat, ...rest] = droppedCaveats(res.caveats)
    expect(rest).toEqual([])
    expect(caveat).toContain("2 fields this build's engine does not read, which it dropped")
    for (const path of paths) expect(caveat).toContain(path)
    expect(skewCaveats(res.caveats)).toEqual([])
  })

  it('are named when the siblings match this build', () => {
    const { doc, paths } = documentWithUnknownFields()
    const res = buildPlanFromParams({
      plan: doc,
      startYear: 2026,
      schemaVersion: PLAN_SCHEMA_VERSION,
      engineVersion: getVersions().engineVersion,
    })
    const dropped = droppedCaveats(res.caveats)
    expect(dropped).toHaveLength(1)
    for (const path of paths) expect(dropped[0]).toContain(path)
  })

  it('are named by the skew caveat on the skew path, and not again', () => {
    const { doc, paths } = documentWithUnknownFields()
    const res = buildPlanFromParams({ plan: doc, startYear: 2026, engineVersion: '9.9.9' })
    const skew = res.caveats.filter((c) => c.startsWith('engineVersion skew:'))
    expect(skew).toHaveLength(1)
    expect(skew[0]).toContain("imported without 2 fields this build's engine does not read")
    expect(skew[0]).not.toContain('imported unchanged')
    for (const path of paths) expect(skew[0]).toContain(path)
    expect(droppedCaveats(res.caveats)).toEqual([])
  })

  it('names five paths and counts the rest', () => {
    const { doc } = documentWithUnknownFields()
    for (let i = 0; i < 6; i++) doc.assumptions[`extra${i}`] = i
    const res = buildPlanFromParams({ plan: doc, startYear: 2026 })
    const [caveat] = droppedCaveats(res.caveats)
    expect(caveat).toContain("8 fields this build's engine does not read")
    expect(caveat).toContain('and 3 more')
  })

  it('a document the engine reads whole gets no such caveat', () => {
    const built = buildPlanFromParams({ household: mfjHousehold, policy: mfjPolicy, startYear: 2026 })
    const doc = JSON.parse(JSON.stringify(builtOk(built).plan)) as unknown
    const res = buildPlanFromParams({ plan: doc, startYear: 2026 })
    expect(droppedCaveats(res.caveats)).toEqual([])
  })
})

describe('droppedFields', () => {
  it('names nested keys, and array items past the end of the kept array by index', () => {
    const supplied = {
      kept: 1,
      gone: 2,
      nested: { a: 1, b: 2 },
      accounts: [{ id: 'a', extra: true }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
    }
    const kept = { kept: 1, nested: { a: 1 }, accounts: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }
    expect(droppedFields(supplied, kept)).toEqual(['gone', 'nested.b', 'accounts.0.extra', 'accounts.3'])
  })

  it('ignores values the parse replaced with another shape, and undefined keys', () => {
    expect(droppedFields({ a: { b: 1 }, c: undefined }, { a: null })).toEqual([])
    expect(droppedFields([1, 2], { not: 'an array' })).toEqual([])
  })
})
