/**
 * The start year and the clock (0.11.0, the host follow-ups engine 0.4.0 assigns
 * this package): the default start year follows an injected clock, a build and
 * an update are stamped from it, both are checked against the start year with
 * the engine's `asOfIssues`, every projecting tool echoes the year it ran from,
 * and the four tools that publish something other than the projection forward
 * its warnings.
 */

import { describe, expect, it } from 'vitest'
import type { Plan } from '@retiregolden/engine'
import * as adapter from '../src/adapter.js'
import { buildPlanFromParams } from '../src/buildPlan.js'
import { getTool } from '../src/toolTable.js'
import { clockStartYear, createSession, type SessionState } from '../src/session.js'
import { builtOk, singleHousehold, singlePolicy } from './fixtures.js'

/** The engine's warning for an unelected lump-sum offer whose year has passed. */
const PASSED_OFFER_WARNING =
  'A pension lump-sum offer on record has an election year that has already passed, so no rollover is modeled and the pension pays its annuity. Update the election year to compare taking the lump sum again.'

/**
 * The single fixture as a full plan document, plus a pension with a lump-sum
 * offer dated `electionYear`, elected into the person's own traditional IRA
 * when `elected`.
 */
function planWithLumpSumOffer(electionYear: number, elected: boolean): Plan {
  const typed = buildPlanFromParams({ household: singleHousehold, policy: singlePolicy, startYear: 2026 })
  const plan = structuredClone(builtOk(typed).plan)
  const ira = plan.accounts.find((account) => account.type === 'traditional')!
  plan.accounts.push({
    type: 'pension',
    id: 'pension-1',
    name: 'Company pension',
    ownerPersonId: ira.ownerPersonId,
    annualReturnPct: null,
    startAge: 65,
    monthlyAmount: 1_500,
    colaPct: 0,
    survivorPct: 0,
    lumpSumOffer: { amount: 250_000, electionYear },
    ...(elected ? { lumpSumElection: { rolloverAccountId: ira.id } } : {}),
  } as unknown as Plan['accounts'][number])
  return plan
}

describe('the default start year follows the injected clock', () => {
  it('reads the local calendar year, either side of New Year', () => {
    // Local-time constructors, so the assertion holds in every time zone.
    expect(clockStartYear(() => new Date(2030, 11, 31, 23, 30))).toBe(2030)
    expect(clockStartYear(() => new Date(2031, 0, 1, 0, 30))).toBe(2031)
    expect(createSession(undefined, { clock: () => new Date(2031, 0, 1, 0, 30) }).startYear).toBe(2031)
  })

  it('runs on the system clock when none is injected', () => {
    const before = new Date().getFullYear()
    const year = createSession().startYear
    const after = new Date().getFullYear()
    expect([before, after]).toContain(year)
  })

  it('a build that names no year reads the clock at the build, and is stamped from it', () => {
    let now = new Date(2030, 5, 1)
    const session = createSession(undefined, { clock: () => now })
    expect(session.startYear).toBe(2030)

    // The session was created in 2030; the build happens in 2032.
    now = new Date(2032, 2, 3, 4, 5, 6)
    const built = adapter.setPlanFromBuild(session, { household: singleHousehold, policy: singlePolicy })
    expect(built.ok).toBe(true)
    expect(built.startYear).toBe(2032)
    expect(session.startYear).toBe(2032)
    expect(session.plan!.createdAtIso).toBe(now.toISOString())
    expect(session.plan!.updatedAtIso).toBe(now.toISOString())
  })

  it('an explicit startYear wins over the clock', () => {
    const session = createSession(undefined, { clock: () => new Date(2032, 5, 1) })
    const built = adapter.setPlanFromBuild(session, {
      household: singleHousehold,
      policy: singlePolicy,
      startYear: 2029,
    })
    expect(built.startYear).toBe(2029)
    expect(session.startYear).toBe(2029)
  })

  it('update_plan re-stamps updatedAtIso from the session clock, not the wall clock', () => {
    const later = new Date('2040-02-03T04:05:06.000Z')
    let now = new Date('2026-06-15T12:00:00.000Z')
    const session = createSession(undefined, { clock: () => now })
    adapter.setPlanFromBuild(session, { household: singleHousehold, policy: singlePolicy, startYear: 2026 })
    now = later
    const res = adapter.updatePlan(session, [{ op: 'set_expense', field: 'baseAnnual', value: 61_000 }])
    expect(res.ok).toBe(true)
    expect(session.plan!.updatedAtIso).toBe(later.toISOString())
  })
})

describe('build_plan and update_plan check the plan against the start year', () => {
  it('build_plan refuses an elected lump sum dated before the start year, with the engine text', () => {
    const res = buildPlanFromParams({ plan: planWithLumpSumOffer(2028, true), startYear: 2031 })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.startYear).toBe(2031)
    expect(res.issues).toHaveLength(1)
    expect(res.issues[0]).toMatch(/^accounts\.\d+\.lumpSumOffer\.electionYear: /)
    expect(res.issues[0]).toContain('The lump-sum election is dated 2028, before this plan starts in 2031.')
  })

  it('build_plan accepts the same election in its own year, and an unelected offer that has passed', () => {
    expect(buildPlanFromParams({ plan: planWithLumpSumOffer(2031, true), startYear: 2031 }).ok).toBe(true)
    expect(buildPlanFromParams({ plan: planWithLumpSumOffer(2028, false), startYear: 2031 }).ok).toBe(true)
  })

  it('build_plan judges the year a build without startYear starts in: the clock year', () => {
    const plan = planWithLumpSumOffer(2030, true)
    expect(buildPlanFromParams({ plan }, { clock: () => new Date(2030, 6, 1) }).ok).toBe(true)
    expect(buildPlanFromParams({ plan }, { clock: () => new Date(2031, 6, 1) }).ok).toBe(false)
  })

  it('update_plan refuses an edit that dates an election before the session start year, leaving the plan as it was', () => {
    const session = createSession(2031)
    const built = adapter.setPlanFromBuild(session, { plan: planWithLumpSumOffer(2032, true), startYear: 2031 })
    expect(built.ok).toBe(true)
    const before = structuredClone(session.plan)
    const pension = session.plan!.accounts.find((account) => account.id === 'pension-1')!
    const res = adapter.updatePlan(session, [
      {
        op: 'replace_account',
        id: 'pension-1',
        account: { ...pension, lumpSumOffer: { amount: 250_000, electionYear: 2029 } } as Record<string, unknown>,
      },
    ])
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toBe('INVALID_PLAN')
    expect((res as { issues?: string[] }).issues?.join(' ') ?? '').toContain(
      'The lump-sum election is dated 2029, before this plan starts in 2031.',
    )
    expect(session.plan).toEqual(before)
  })
})

describe('compare_scenarios and validate_plan run the same start-year check', () => {
  it('compare_scenarios refuses a side with an election dated before the year it projects from', () => {
    const session = createSession(2026)
    const passed = planWithLumpSumOffer(2028, true)
    const fine = planWithLumpSumOffer(2032, true)

    const sideB = adapter.compareScenarios(session, fine, passed, 2031)
    expect(sideB.ok).toBe(false)
    if (sideB.ok) return
    expect(sideB.error).toBe('INVALID_PLAN_B')
    expect((sideB as { issues?: string[] }).issues?.join(' ') ?? '').toContain(
      'The lump-sum election is dated 2028, before this plan starts in 2031.',
    )
    const sideA = adapter.compareScenarios(session, passed, fine, 2031)
    expect(sideA.ok).toBe(false)
    if (!sideA.ok) expect(sideA.error).toBe('INVALID_PLAN_A')

    // The same documents compare from a year the election has not passed;
    // without an argument the session's year (2026) is the one judged.
    expect(adapter.compareScenarios(session, fine, passed, 2028).ok).toBe(true)
    expect(adapter.compareScenarios(session, fine, passed).ok).toBe(true)
  })

  it('validate_plan reports the issue against the year it is given, or the session year', () => {
    const validate = getTool('validate_plan')!
    const session = createSession(2026)
    const doc = planWithLumpSumOffer(2028, true)

    const given = validate.handler(session, { plan: doc, startYear: 2031 }) as {
      ok: boolean
      issues?: string[]
      startYear?: number
    }
    expect(given.ok).toBe(false)
    expect(given.startYear).toBe(2031)
    expect(given.issues?.join(' ')).toContain('The lump-sum election is dated 2028, before this plan starts in 2031.')

    const sessionYear = validate.handler(session, { plan: doc }) as { ok: boolean; startYear?: number }
    expect(sessionYear.ok).toBe(true)
    expect(sessionYear.startYear).toBe(2026)

    const later = createSession(2030)
    const fromSession = validate.handler(later, { plan: doc }) as { ok: boolean; issues?: string[] }
    expect(fromSession.ok).toBe(false)
    expect(fromSession.issues?.join(' ')).toContain('before this plan starts in 2030.')
  })
})

describe('every projecting tool echoes the start year it ran from', () => {
  async function echoes(session: SessionState) {
    const plan = structuredClone(session.plan)
    const projection = adapter.runProjection(session)
    const monteCarlo = adapter.runMonteCarlo(session, { pathCount: 20 })
    const batch = adapter.batchEvaluate(session, [singlePolicy])
    const optimizer = await adapter.runOptimizer(session)
    const spending = adapter.solveMaxSpending(session)
    const compare = adapter.compareScenarios(session, plan, plan)
    const explain = adapter.explainModeledResult(session)
    const update = adapter.updatePlan(session, [{ op: 'set_expense', field: 'baseAnnual', value: 60_500 }])
    return { projection, monteCarlo, batch, optimizer, spending, compare, explain, update }
  }

  it('all nine report the session year, and compare_scenarios its own argument', async () => {
    const session = createSession()
    const built = adapter.setPlanFromBuild(session, {
      household: singleHousehold,
      policy: singlePolicy,
      startYear: 2031,
    })
    expect(built.startYear).toBe(2031)
    const results = await echoes(session)
    for (const [tool, result] of Object.entries(results)) {
      expect(result.ok, tool).toBe(true)
      expect((result as { startYear?: number }).startYear, tool).toBe(2031)
    }
    const plan = session.plan
    const explicit = adapter.compareScenarios(session, plan, plan, 2033)
    expect(explicit.ok && explicit.startYear).toBe(2033)
  })
})

describe('the four tools that publish something else forward the projection warnings', () => {
  it('carry the passed lump-sum offer warning that run_projection reports', async () => {
    const session = createSession()
    const built = adapter.setPlanFromBuild(session, { plan: planWithLumpSumOffer(2028, false), startYear: 2031 })
    expect(built.ok).toBe(true)

    const projection = adapter.runProjection(session)
    if (!projection.ok) throw new Error('projection failed')
    expect(projection.summary.warnings).toContain(PASSED_OFFER_WARNING)

    const monteCarlo = adapter.runMonteCarlo(session, { pathCount: 20 })
    const batch = adapter.batchEvaluate(session, [singlePolicy])
    const optimizer = await adapter.runOptimizer(session)
    const spending = adapter.solveMaxSpending(session)
    for (const [tool, result] of Object.entries({ monteCarlo, batch, optimizer, spending })) {
      if (!result.ok) throw new Error(`${tool} failed`)
      expect((result as { warnings: string[] }).warnings, tool).toEqual(projection.summary.warnings)
    }
  })

  it('hands out a copy, so a caller cannot edit what a later call reports', () => {
    const session = createSession()
    adapter.setPlanFromBuild(session, { plan: planWithLumpSumOffer(2028, false), startYear: 2031 })
    const first = adapter.runMonteCarlo(session, { pathCount: 20 })
    if (!first.ok) throw new Error('monte carlo failed')
    first.warnings.length = 0
    const second = adapter.runMonteCarlo(session, { pathCount: 20 })
    if (!second.ok) throw new Error('monte carlo failed')
    expect(second.warnings).toContain(PASSED_OFFER_WARNING)
  })
})
