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
import { createSession, type SessionState } from '../src/session.js'
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
    conventions: { lawSunsetFreezeYear: 2030 },
  })
  expect(built.ok).toBe(true)
  expect(session.caveats.length).toBeGreaterThan(0)
  expect(session.conventions.lawSunsetFreezeYear).toBe(2030)
  return session
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

describe('handlers return copies of session.conventions', () => {
  it('explainModeledResult', () => {
    const session = seededSession()
    const res = adapter.explainModeledResult(session)
    expect(res.conventions).not.toBe(session.conventions)
    res.conventions.lawSunsetFreezeYear = 1999
    expect(session.conventions.lawSunsetFreezeYear).toBe(2030)
  })

  it('exportPlan', () => {
    const session = seededSession()
    const res = adapter.exportPlan(session)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.conventions).not.toBe(session.conventions)
    res.conventions.lawSunsetFreezeYear = 1999
    expect(session.conventions.lawSunsetFreezeYear).toBe(2030)
  })

  it('get_session tool handler', () => {
    const session = seededSession()
    const entry = getTool('get_session')!
    const res = entry.handler(session, {}) as {
      conventions: { lawSunsetFreezeYear?: number | null }
    }
    expect(res.conventions).not.toBe(session.conventions)
    res.conventions.lawSunsetFreezeYear = 1999
    expect(session.conventions.lawSunsetFreezeYear).toBe(2030)
  })
})
