/**
 * Session-owned mutable state must never leave a handler by reference.
 *
 * `session.caveats` (an array) and `session.conventions` (an object) are handed
 * back on nearly every tool response. Before adapter.snapshotCaveats /
 * snapshotConventions, all but export_plan returned the LIVE values, so a
 * programmatic consumer that pushed onto a returned `caveats` array silently
 * rewrote the session — and two responses shared one array.
 *
 * These tests mutate what each handler returned and assert the session did not
 * move. They are about identity, not JSON: the serialized payload is unchanged,
 * which is why tests/protocolBaseline.test.ts is unaffected.
 */

import { describe, expect, it } from 'vitest'
import { createSession, type ConventionKnobs, type SessionState } from '../src/session.js'
import * as adapter from '../src/adapter.js'
import { getTool } from '../src/toolTable.js'
import { mfjHousehold, mfjPolicy, singleHousehold, singlePolicy } from './fixtures.js'

/**
 * A session whose caveats are non-empty and whose conventions carry a knob, so a
 * leak has something to corrupt. `traditional-first` ordering is what puts a
 * build-time caveat on the session.
 */
function seededSession(): SessionState {
  const session = createSession(2026)
  const built = adapter.setPlanFromBuild(session, {
    household: singleHousehold,
    policy: { ...singlePolicy, ordering: 'traditional-first' },
    // `irmaaLookbackMagis` is the ONLY reference-typed knob in ConventionKnobs,
    // so it is the only thing that can tell a deep copy from a shallow one.
    // Seeded here so every conventions case below exercises it.
    conventions: { lawSunsetFreezeYear: 2030, irmaaLookbackMagis: [111000, 222000] },
  })
  expect(built.ok).toBe(true)
  expect(session.caveats.length).toBeGreaterThan(0)
  expect(session.conventions.lawSunsetFreezeYear).toBe(2030)
  expect(session.conventions.irmaaLookbackMagis).toEqual([111000, 222000])
  return session
}

/**
 * Assert a returned conventions object is a DEEP copy.
 *
 * The scalar check alone is not enough: `{ ...session.conventions }` passes
 * both `not.toBe` and a top-level reassignment, so a suite that only mutates
 * `lawSunsetFreezeYear` would stay green if `snapshotConventions` were ever
 * "tidied up" from `structuredClone` to a spread — while consumers quietly
 * regained the ability to rewrite the session's MAGI tuple. Mutating the nested
 * tuple is what actually pins the deep clone.
 */
function expectConventionsIsolated(session: SessionState, returned: ConventionKnobs): void {
  expect(returned).not.toBe(session.conventions)
  expect(returned).toEqual(session.conventions)

  returned.lawSunsetFreezeYear = 1999
  expect(session.conventions.lawSunsetFreezeYear).toBe(2030)

  expect(returned.irmaaLookbackMagis).not.toBe(session.conventions.irmaaLookbackMagis)
  returned.irmaaLookbackMagis![0] = -1
  expect(session.conventions.irmaaLookbackMagis).toEqual([111000, 222000])
}

/** Push onto a returned caveats array and assert the session's own is untouched. */
function expectCaveatsIsolated(session: SessionState, returned: string[]): void {
  const before = [...session.caveats]
  expect(returned).toEqual(before)
  expect(returned).not.toBe(session.caveats)
  returned.push('MUTATED BY THE CALLER')
  expect(session.caveats).toEqual(before)
}

describe('handlers return copies of session.caveats', () => {
  it('runProjection (summary)', () => {
    const session = seededSession()
    const res = adapter.runProjection(session)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expectCaveatsIsolated(session, res.caveats)
  })

  it('runProjection (years detail)', () => {
    const session = seededSession()
    const res = adapter.runProjection(session, { detail: 'years' })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expectCaveatsIsolated(session, res.caveats)
  })

  it('runMonteCarlo', () => {
    const session = seededSession()
    const res = adapter.runMonteCarlo(session, { pathCount: 5, seed: 1 })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expectCaveatsIsolated(session, res.caveats)
  })

  it('runOptimizer', async () => {
    const session = seededSession()
    const res = await adapter.runOptimizer(session)
    // Success and failure both carry caveats; either way they must be a copy.
    expect('caveats' in res).toBe(true)
    expectCaveatsIsolated(session, (res as { caveats: string[] }).caveats)
  })

  it('solveMaxSpending', () => {
    const session = seededSession()
    const res = adapter.solveMaxSpending(session)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expectCaveatsIsolated(session, res.caveats)
  })

  it('exportPlan', () => {
    const session = seededSession()
    const res = adapter.exportPlan(session)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expectCaveatsIsolated(session, res.caveats)
  })

  it('explainModeledResult', () => {
    const session = seededSession()
    const res = adapter.explainModeledResult(session)
    expectCaveatsIsolated(session, res.caveats)
  })

  it('updatePlan', () => {
    const session = seededSession()
    const res = adapter.updatePlan(session, [
      { op: 'set_assumption', field: 'inflationPct', value: 3 },
    ])
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expectCaveatsIsolated(session, res.caveats)
  })

  it('get_session tool handler', () => {
    const session = seededSession()
    const entry = getTool('get_session')!
    const res = entry.handler(session, {}) as { caveats: string[] }
    expectCaveatsIsolated(session, res.caveats)
  })
})

describe('batchEvaluate rows return copies of session.caveats', () => {
  /**
   * The error rows are the ones that used to push `session.caveats` itself, so
   * two failing rows shared one array with the session. Force two failures with
   * a plan that has two Social Security incomes and policies that name one
   * claim age.
   */
  function mfjSession(): SessionState {
    const session = createSession(2026)
    const built = adapter.setPlanFromBuild(session, {
      household: mfjHousehold,
      policy: { ...mfjPolicy, ordering: 'traditional-first' },
      startYear: 2026,
    })
    expect(built.ok).toBe(true)
    expect(session.caveats.length).toBeGreaterThan(0)
    return session
  }

  it('error rows do not alias the session (or each other)', () => {
    const session = mfjSession()
    const shortPolicy = { ...mfjPolicy, claim_ages: [67], ordering: 'proportional' as const }
    const res = adapter.batchEvaluate(session, [shortPolicy, shortPolicy])
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.results).toHaveLength(2)
    for (const row of res.results) expect(row.ok).toBe(false)
    expect(res.results[0]!.caveats).not.toBe(res.results[1]!.caveats)
    expectCaveatsIsolated(session, res.results[0]!.caveats)
    expectCaveatsIsolated(session, res.results[1]!.caveats)
  })

  it('success rows do not alias the session', () => {
    const session = mfjSession()
    const res = adapter.batchEvaluate(session, [
      { ...mfjPolicy, ordering: 'proportional' as const },
    ])
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const row = res.results[0]!
    expect(row.ok).toBe(true)
    expectCaveatsIsolated(session, row.caveats)
  })
})

describe('handlers return DEEP copies of session.conventions', () => {
  it('explainModeledResult', () => {
    const session = seededSession()
    expectConventionsIsolated(session, adapter.explainModeledResult(session).conventions)
  })

  it('exportPlan', () => {
    const session = seededSession()
    const res = adapter.exportPlan(session)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expectConventionsIsolated(session, res.conventions)
  })

  it('get_session tool handler', () => {
    const session = seededSession()
    const entry = getTool('get_session')!
    const res = entry.handler(session, {}) as { conventions: ConventionKnobs }
    expectConventionsIsolated(session, res.conventions)
  })

  it('build_plan does not keep the caller conventions object it was handed', () => {
    // The mirror of the handler cases: isolation has to hold on the way IN too,
    // or a caller that holds onto its own tuple can rewrite live session
    // conventions after the build and change every later modeled result.
    const session = createSession(2026)
    const callerConventions: ConventionKnobs = {
      lawSunsetFreezeYear: 2030,
      irmaaLookbackMagis: [111000, 222000],
    }
    expect(
      adapter.setPlanFromBuild(session, {
        household: singleHousehold,
        policy: singlePolicy,
        conventions: callerConventions,
      }).ok,
    ).toBe(true)

    expect(session.conventions).not.toBe(callerConventions)
    expect(session.conventions.irmaaLookbackMagis).not.toBe(callerConventions.irmaaLookbackMagis)

    callerConventions.lawSunsetFreezeYear = 1999
    callerConventions.irmaaLookbackMagis![0] = -1
    expect(session.conventions.lawSunsetFreezeYear).toBe(2030)
    expect(session.conventions.irmaaLookbackMagis).toEqual([111000, 222000])
  })
})

/**
 * The two remaining session-owned objects: the live plan's `assumptions`
 * sub-object, and the projection summary cached on `session.lastProjection`.
 * Neither is a caveat or a convention, so nothing above would catch them.
 */
describe('handlers return copies of the plan assumptions and the cached summary', () => {
  it('runProjection does not hand out the summary it cached on the session', () => {
    const session = seededSession()
    const res = adapter.runProjection(session)
    expect(res.ok).toBe(true)
    if (!res.ok) return

    expect(session.lastProjection).not.toBeNull()
    const cached = session.lastProjection!.summary.endingAfterTaxEstate
    expect(res.summary).not.toBe(session.lastProjection!.summary)

    res.summary.endingAfterTaxEstate = -12345
    expect(session.lastProjection!.summary.endingAfterTaxEstate).toBe(cached)
    // And the next explain must report the session's number, not the caller's.
    expect(
      (adapter.explainModeledResult(session).lastProjectionSummary as { endingAfterTaxEstate: number })
        .endingAfterTaxEstate,
    ).toBe(cached)
  })

  it('explainModeledResult does not hand out the live plan assumptions', () => {
    const session = seededSession()
    const before = session.plan!.assumptions.inflationPct
    const res = adapter.explainModeledResult(session)

    expect(res.assumptions).not.toBe(session.plan!.assumptions)
    res.assumptions!.inflationPct = 99
    // Mutating the response must not steer the next projection behind
    // update_plan's back — that bypass is exactly what update_plan's staleness
    // caveat exists to make visible.
    expect(session.plan!.assumptions.inflationPct).toBe(before)
  })

  it('explainModeledResult does not hand out the cached summary', () => {
    const session = seededSession()
    expect(adapter.runProjection(session).ok).toBe(true)
    const res = adapter.explainModeledResult(session)

    expect(res.lastProjectionSummary).not.toBe(session.lastProjection!.summary)
    const cached = session.lastProjection!.summary.endingAfterTaxEstate
    ;(res.lastProjectionSummary as { endingAfterTaxEstate: number }).endingAfterTaxEstate = -1
    expect(session.lastProjection!.summary.endingAfterTaxEstate).toBe(cached)
  })
})
