/**
 * Parity for the three figures this adapter used to compute itself (packet
 * B2-P1 of the calculation-validation program): `batch_evaluate`'s
 * `cumulative_tax` and `ending_trad` objectives and `compare_scenarios`'
 * after-tax-estate delta. Each is now a value the engine publishes, which the
 * adapter only selects. These tests hold that in two ways:
 *
 * - each reported figure is exactly the engine's published value (so local
 *   arithmetic cannot creep back in unnoticed), and
 * - it agrees, to the cent, with the arithmetic the adapter used to do on the
 *   projection, recomputed here from the ledger, so the switch moved no number
 *   beyond floating-point association.
 */
import { describe, expect, it } from 'vitest'
import { simulatePlan } from '@retiregolden/engine'
import { compareScenarioPlans } from '@retiregolden/engine/scenarios/comparison'
import { createSession } from '../src/session.js'
import * as adapter from '../src/adapter.js'
import { buildPlanFromParams, type HouseholdParams, type PolicyParams } from '../src/buildPlan.js'
import { builtOk, mfjHousehold, mfjPolicy, singleHousehold, singlePolicy } from './fixtures.js'

const CENT = 0.01

const CASES: ReadonlyArray<{ name: string; household: HouseholdParams; policy: PolicyParams }> = [
  { name: 'married, two people with a pension', household: mfjHousehold, policy: mfjPolicy },
  { name: 'single', household: singleHousehold, policy: singlePolicy },
]

function sessionFor(household: HouseholdParams, policy: PolicyParams) {
  const session = createSession(2026)
  const built = adapter.setPlanFromBuild(session, { household, policy, startYear: 2026 })
  expect(built.ok).toBe(true)
  return session
}

/** The session plan's projection, with its year ledger and the engine's summary. */
function projectionOf(session: ReturnType<typeof createSession>) {
  const proj = adapter.runProjection(session, { detail: 'years' })
  expect(proj.ok).toBe(true)
  if (!proj.ok || !('years' in proj)) throw new Error('expected a projection with its year ledger')
  return proj
}

function objectiveOf(
  session: ReturnType<typeof createSession>,
  policy: PolicyParams,
  objective: 'after_tax_estate' | 'cumulative_tax' | 'ending_trad',
): number {
  const batch = adapter.batchEvaluate(session, [policy], objective)
  expect(batch.ok).toBe(true)
  if (!batch.ok) throw new Error('expected a batch result')
  const row = batch.results[0]!
  expect(row.ok, row.error).toBe(true)
  return row.objective as number
}

describe('batch_evaluate objectives are the engine summary values', () => {
  for (const { name, household, policy } of CASES) {
    it(`cumulative_tax is summary.lifetimeTaxesAndPenalties (${name})`, () => {
      const session = sessionFor(household, policy)
      const proj = projectionOf(session)
      const value = objectiveOf(session, policy, 'cumulative_tax')
      expect(value).toBe(proj.summary.lifetimeTaxesAndPenalties)
      // The adapter's former arithmetic: tax plus penalties, year by year.
      const ledgerSum = proj.years.reduce((sum, year) => sum + year.tax + year.penalties, 0)
      expect(Math.abs(value - ledgerSum)).toBeLessThan(CENT)
      expect(value).toBeGreaterThan(0)
    })

    it(`ending_trad is summary.endingByCategory.traditional (${name})`, () => {
      const session = sessionFor(household, policy)
      const proj = projectionOf(session)
      const value = objectiveOf(session, policy, 'ending_trad')
      expect(value).toBe(proj.summary.endingByCategory.traditional)
      // The adapter's former arithmetic: the last year's balances of the
      // plan's traditional accounts, once per account id. The tool's year rows
      // omit balances, so the ledger comes from projecting the session plan with
      // the adapter's own tax stack.
      const plan = session.plan!
      const ledger = simulatePlan(plan, { startYear: session.startYear, taxCalculator: adapter.taxCalc(plan) })
      const last = ledger.years[ledger.years.length - 1]!
      const ledgerSum = Object.entries(last.balances).reduce((sum, [id, balance]) => {
        const account = plan.accounts.find((entry) => entry.id === id)
        return account?.type === 'traditional' ? sum + balance : sum
      }, 0)
      expect(Math.abs(value - ledgerSum)).toBeLessThan(CENT)
    })

    it(`after_tax_estate is summary.endingAfterTaxEstate (${name})`, () => {
      const session = sessionFor(household, policy)
      const proj = projectionOf(session)
      expect(objectiveOf(session, policy, 'after_tax_estate')).toBe(proj.summary.endingAfterTaxEstate)
    })
  }
})

/** A built plan as the JSON document a compare_scenarios caller sends. */
function planDocument(household: HouseholdParams, policy: PolicyParams, flatStatePct?: number) {
  const plan = JSON.parse(JSON.stringify(builtOk(buildPlanFromParams({ household, policy })).plan))
  if (flatStatePct !== undefined) plan.assumptions.stateEffectiveTaxPct = flatStatePct
  return plan
}

describe('compare_scenarios delta is the engine comparison', () => {
  // Pairs that price differently: two modeled states, and two flat state-rate
  // overrides on otherwise identical plans (the override is what the adapter's
  // own tax stack reads, so a comparison that priced both sides with one
  // calculator, or ignored the adapter's, would disagree with the summaries).
  const PAIRS = [
    { name: 'two modeled states', a: planDocument(mfjHousehold, mfjPolicy), b: planDocument({ ...mfjHousehold, state: 'CA' }, mfjPolicy) },
    { name: 'two flat state-rate overrides', a: planDocument(mfjHousehold, mfjPolicy, 2), b: planDocument(mfjHousehold, mfjPolicy, 6) },
  ]

  for (const pair of PAIRS) {
    it(`is the engine comparison's delta, and proposal minus baseline of the reported summaries (${pair.name})`, () => {
      const session = sessionFor(mfjHousehold, mfjPolicy)
      const cmp = adapter.compareScenarios(session, pair.a, pair.b)
      expect(cmp.ok).toBe(true)
      if (!cmp.ok) return
      expect(cmp.deltaEndingAfterTaxEstate).not.toBe(0)
      // Exactly the engine's published comparison, priced with the adapter's stack.
      const engine = compareScenarioPlans(pair.a, pair.b, { startYear: session.startYear, taxCalculatorForPlan: adapter.taxCalc })
      expect(cmp.deltaEndingAfterTaxEstate).toBe(engine.headline.endingAfterTaxEstate.delta)
      expect(engine.headline.endingAfterTaxEstate.baseline).toBe(cmp.a.endingAfterTaxEstate)
      expect(engine.headline.endingAfterTaxEstate.proposal).toBe(cmp.b.endingAfterTaxEstate)
      // And the adapter's former arithmetic, on the summaries it still reports.
      const subtraction = cmp.b.endingAfterTaxEstate - cmp.a.endingAfterTaxEstate
      expect(Math.abs(cmp.deltaEndingAfterTaxEstate - subtraction)).toBeLessThan(CENT)
    })
  }

  it('is zero, not negative zero, for two identical plans', () => {
    const session = sessionFor(mfjHousehold, mfjPolicy)
    const plan = planDocument(mfjHousehold, mfjPolicy)
    const cmp = adapter.compareScenarios(session, plan, plan)
    expect(cmp.ok).toBe(true)
    if (cmp.ok) expect(Object.is(cmp.deltaEndingAfterTaxEstate, 0)).toBe(true)
  })
})
