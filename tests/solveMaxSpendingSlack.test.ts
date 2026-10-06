/**
 * solve_max_spending publishes the engine's whole answer (engine 0.4.0, owner
 * decision R4 in the engine CHANGELOG): the published amount rounded down to
 * $100, the level that passed, how the two relate, and the engine's verdict on
 * today's base spending. The slack is measured from the rounded amount, so it
 * can read between -$100 and 0 beside a base the plan sustains; this package
 * then withholds it, as the app's spending page shows "Under $100/yr", and says
 * why. The figures are the engine's; the adapter only chooses which to show.
 */

import { describe, expect, it } from 'vitest'
import { simulatePlan, summarizeProjection } from '@retiregolden/engine'
import { solveMaxSustainableSpending } from '@retiregolden/engine/decisions/spendingSolver'
import * as adapter from '../src/adapter.js'
import { createSession } from '../src/session.js'
import { singleHousehold, singlePolicy } from './fixtures.js'

function sessionSpending(spending: number) {
  const session = createSession(2026)
  const built = adapter.setPlanFromBuild(session, {
    household: { ...singleHousehold, spending },
    policy: singlePolicy,
    startYear: 2026,
  })
  expect(built.ok).toBe(true)
  return session
}

/** The engine's own answer for the session plan, solved as the adapter solves it. */
function engineAnswer(spending: number) {
  const session = sessionSpending(spending)
  const plan = session.plan!
  const simulateOptions = { startYear: 2026, taxCalculator: adapter.taxCalc(plan) }
  const baselineResult = simulatePlan(plan, simulateOptions)
  return solveMaxSustainableSpending(
    {
      plan,
      baselineResult,
      baselineSummary: summarizeProjection(plan, baselineResult, { conversionFreeRun: null }),
      simulateOptions,
    },
    {},
  )
}

describe('solve_max_spending', () => {
  it('withholds the -$50 slack the engine reports beside a sustained base (published as is before this fix)', () => {
    // $121,450 of base spending passes (the solve's first probe), but the
    // published answer is the passing level rounded down to $100, $121,400, so
    // the engine's slack reads -$50 on a plan that sustains its spending.
    const engine = engineAnswer(121_450)
    expect(engine.sustainsCurrentBase).toBe(true)
    expect(engine.spendingSlackDollars).toBe(-50)
    expect(engine.maxBaseAnnual).toBe(121_400)
    expect(engine.feasibleBaseAnnual).toBe(121_450)
    expect(engine.maxBaseAnnualRounding).toBe('down-to-hundred')

    const res = adapter.solveMaxSpending(sessionSpending(121_450))
    if (!res.ok) throw new Error('solver failed')
    expect(res.maxBaseAnnual).toBe(121_400)
    expect(res.feasibleBaseAnnual).toBe(121_450)
    expect(res.maxBaseAnnualRounding).toBe('down-to-hundred')
    expect(res.maxBaseAnnualNote).toBeNull()
    expect(res.sustainsCurrentBase).toBe(true)
    expect(res.spendingSlackDollars).toBeNull()
    expect(res.spendingSlackNote).toContain('less than $100 a year to spare')
    expect(res.spendingSlackNote).toContain('rounded down to the nearest $100')
  })

  it('publishes the slack as the engine computes it otherwise', () => {
    const headroom = adapter.solveMaxSpending(sessionSpending(60_000))
    if (!headroom.ok) throw new Error('solver failed')
    expect(headroom.sustainsCurrentBase).toBe(true)
    expect(headroom.spendingSlackDollars).toBe(61_400)
    expect(headroom.spendingSlackNote).toBeNull()

    // A base the plan cannot sustain keeps its negative slack: that one is real.
    const engine = engineAnswer(130_000)
    expect(engine.sustainsCurrentBase).toBe(false)
    const short = adapter.solveMaxSpending(sessionSpending(130_000))
    if (!short.ok) throw new Error('solver failed')
    expect(short.sustainsCurrentBase).toBe(false)
    expect(short.spendingSlackDollars).toBe(engine.spendingSlackDollars)
    expect(short.spendingSlackDollars!).toBeLessThan(0)
    expect(short.spendingSlackNote).toBeNull()
  })

  it("carries the engine's sentence when it publishes the exact amount", () => {
    // A required spending floor of $121,450: the solve passes at exactly that
    // level, and rounded down to $100 the answer would fall below the floor, so
    // the engine publishes $121,450 (`maxBaseAnnualRounding: 'none'`) and says
    // why in one of its diagnostics, a string.
    const session = sessionSpending(121_450)
    const floor = adapter.updatePlan(session, [{ op: 'set_expense', field: 'requiredAnnual', value: 121_450 }])
    expect(floor.ok).toBe(true)
    const res = adapter.solveMaxSpending(session)
    if (!res.ok) throw new Error('solver failed')
    expect(res.maxBaseAnnualRounding).toBe('none')
    expect(res.maxBaseAnnual).toBe(121_450)
    expect(res.feasibleBaseAnnual).toBe(121_450)
    expect(res.maxBaseAnnualNote).toBe(
      'The answer is the exact amount that passed ($121,450/yr): rounded down to the nearest $100 it would fall below the required spending floor ($121,450/yr).',
    )
    expect(res.sustainsCurrentBase).toBe(true)
    expect(res.spendingSlackDollars).toBe(0)
    expect(res.spendingSlackNote).toBeNull()
  })
})
