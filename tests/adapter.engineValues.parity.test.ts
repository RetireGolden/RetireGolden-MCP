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
import { combineTaxCalculators, createFederalTaxCalculator } from '@retiregolden/engine/tax/federalTax'
import { createStateTaxCalculator } from '@retiregolden/engine/tax/stateTax'
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
      // the same federal and state calculators the adapter builds.
      const plan = session.plan!
      const ledger = simulatePlan(plan, {
        startYear: session.startYear,
        taxCalculator: combineTaxCalculators(
          createFederalTaxCalculator(),
          createStateTaxCalculator({
            overridePct: plan.assumptions.stateEffectiveTaxPct,
            localPct: plan.assumptions.localIncomeTaxPct,
          }),
        ),
      })
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

describe('compare_scenarios delta is the engine comparison', () => {
  it('equals proposal minus baseline of the two reported summaries, for two different plans', () => {
    const session = sessionFor(mfjHousehold, mfjPolicy)
    const planA = JSON.parse(JSON.stringify(builtOk(buildPlanFromParams({ household: mfjHousehold, policy: mfjPolicy })).plan))
    const planB = JSON.parse(
      JSON.stringify(
        builtOk(buildPlanFromParams({ household: { ...mfjHousehold, state: 'CA' }, policy: mfjPolicy })).plan,
      ),
    )
    const cmp = adapter.compareScenarios(session, planA, planB)
    expect(cmp.ok).toBe(true)
    if (!cmp.ok) return
    // Different states price the same plan differently, so the delta is not zero.
    expect(cmp.deltaEndingAfterTaxEstate).not.toBe(0)
    // The adapter's former arithmetic, on the summaries it still reports.
    const subtraction = cmp.b.endingAfterTaxEstate - cmp.a.endingAfterTaxEstate
    expect(Math.abs(cmp.deltaEndingAfterTaxEstate - subtraction)).toBeLessThan(CENT)
  })

  it('is zero, not negative zero, for two identical plans', () => {
    const session = sessionFor(mfjHousehold, mfjPolicy)
    const plan = JSON.parse(JSON.stringify(builtOk(buildPlanFromParams({ household: mfjHousehold, policy: mfjPolicy })).plan))
    const cmp = adapter.compareScenarios(session, plan, plan)
    expect(cmp.ok).toBe(true)
    if (cmp.ok) expect(Object.is(cmp.deltaEndingAfterTaxEstate, 0)).toBe(true)
  })
})
