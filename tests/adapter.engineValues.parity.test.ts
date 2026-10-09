/**
 * Parity for the three figures this adapter used to compute itself (packet
 * B2-P1 of the calculation-validation program): `batch_evaluate`'s
 * `cumulative_tax` and `ending_trad` objectives and `compare_scenarios`'
 * nominal after-tax-estate delta (`deltaEndingAfterTaxEstateNominal`, named
 * `deltaEndingAfterTaxEstate` through 0.11.x). Each is now a value the engine
 * publishes, which the adapter only selects; so is the app's Compare-page
 * comparison the tool publishes beside it (`headline`, from
 * `comparePlanHeadlines`). These tests hold that in two ways:
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

describe('compare_scenarios deltas are the engine comparisons', () => {
  // Pairs that price differently: two modeled states, and two flat state-rate
  // overrides on otherwise identical plans (the override is what the adapter's
  // own tax stack reads, so a comparison that priced both sides with one
  // calculator, or ignored the adapter's, would disagree with the summaries).
  // Both pairs end in one year, so the app's basis is nominal and the two
  // published deltas are one number.
  const PAIRS = [
    { name: 'two modeled states', a: planDocument(mfjHousehold, mfjPolicy), b: planDocument({ ...mfjHousehold, state: 'CA' }, mfjPolicy) },
    { name: 'two flat state-rate overrides', a: planDocument(mfjHousehold, mfjPolicy, 2), b: planDocument(mfjHousehold, mfjPolicy, 6) },
  ]

  for (const pair of PAIRS) {
    it(`the nominal delta is the engine comparison's, and proposal minus baseline of the reported summaries (${pair.name})`, () => {
      const session = sessionFor(mfjHousehold, mfjPolicy)
      const cmp = adapter.compareScenarios(session, pair.a, pair.b)
      expect(cmp.ok).toBe(true)
      if (!cmp.ok) return
      expect(cmp.deltaEndingAfterTaxEstateNominal).not.toBe(0)
      // Exactly the engine's published comparison, priced with the adapter's stack.
      const engine = compareScenarioPlans(pair.a, pair.b, { startYear: session.startYear, taxCalculatorForPlan: adapter.taxCalc })
      expect(cmp.deltaEndingAfterTaxEstateNominal).toBe(engine.headline.endingAfterTaxEstate.delta)
      expect(engine.headline.endingAfterTaxEstate.baseline).toBe(cmp.a.endingAfterTaxEstate)
      expect(engine.headline.endingAfterTaxEstate.proposal).toBe(cmp.b.endingAfterTaxEstate)
      // And the adapter's former arithmetic, on the summaries it still reports.
      const subtraction = cmp.b.endingAfterTaxEstate - cmp.a.endingAfterTaxEstate
      expect(Math.abs(cmp.deltaEndingAfterTaxEstateNominal - subtraction)).toBeLessThan(CENT)
    })

    it(`the app's headline is nominal and equal to it when the plans end in one year (${pair.name})`, () => {
      const session = sessionFor(mfjHousehold, mfjPolicy)
      const cmp = adapter.compareScenarios(session, pair.a, pair.b)
      expect(cmp.ok).toBe(true)
      if (!cmp.ok) return
      expect(cmp.headline.moneyBasis).toBe('nominal')
      expect(cmp.headline.endYear.delta).toBe(0)
      expect(cmp.headline.endingAfterTaxEstate).toEqual({
        baseline: cmp.a.endingAfterTaxEstate,
        proposal: cmp.b.endingAfterTaxEstate,
        delta: cmp.deltaEndingAfterTaxEstateNominal,
      })
    })
  }

  it("compares two plans that end in different years in today's dollars, as the app does", () => {
    const session = sessionFor(mfjHousehold, mfjPolicy)
    const a = planDocument(mfjHousehold, mfjPolicy)
    const b = planDocument({ ...mfjHousehold, horizon: mfjHousehold.horizon + 5 }, mfjPolicy)
    const cmp = adapter.compareScenarios(session, a, b)
    expect(cmp.ok).toBe(true)
    if (!cmp.ok) return
    // Each side's ledger, priced with the adapter's own stack: its last row's
    // published inflation factor is what converts its estate to start-year dollars.
    const ledgerA = simulatePlan(a, { startYear: session.startYear, taxCalculator: adapter.taxCalc(a) })
    const ledgerB = simulatePlan(b, { startYear: session.startYear, taxCalculator: adapter.taxCalc(b) })
    expect(ledgerB.endYear).toBe(ledgerA.endYear + 5)
    expect(cmp.headline.moneyBasis).toBe('today')
    expect(cmp.headline.endYear).toEqual({ baseline: ledgerA.endYear, proposal: ledgerB.endYear, delta: 5 })
    const todayA = cmp.a.endingAfterTaxEstate / ledgerA.years.at(-1)!.inflationScale!
    const todayB = cmp.b.endingAfterTaxEstate / ledgerB.years.at(-1)!.inflationScale!
    expect(cmp.headline.endingAfterTaxEstate).toEqual({ baseline: todayA, proposal: todayB, delta: todayB - todayA })
    // The nominal field keeps its 0.11.x meaning: two different years' dollars,
    // subtracted as they are, which is a different number here.
    expect(cmp.deltaEndingAfterTaxEstateNominal).toBe(cmp.b.endingAfterTaxEstate - cmp.a.endingAfterTaxEstate)
    expect(cmp.headline.endingAfterTaxEstate.delta).not.toBe(cmp.deltaEndingAfterTaxEstateNominal)
  })

  it('is zero, not negative zero, for two identical plans', () => {
    const session = sessionFor(mfjHousehold, mfjPolicy)
    const plan = planDocument(mfjHousehold, mfjPolicy)
    const cmp = adapter.compareScenarios(session, plan, plan)
    expect(cmp.ok).toBe(true)
    if (!cmp.ok) return
    expect(Object.is(cmp.deltaEndingAfterTaxEstateNominal, 0)).toBe(true)
    expect(Object.is(cmp.headline.endingAfterTaxEstate.delta, 0)).toBe(true)
  })
})
