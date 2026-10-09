/**
 * The MCP must answer the SAME question the RetireGolden web app answers.
 *
 * Through 0.4.2 it did not: `taxCalc()` returned `createFederalTaxCalculator()`
 * alone, while the app runs federal COMBINED WITH the state calculator
 * (`taxCalculatorFor` in planner-ui/src/planTaxCalculator.ts, which
 * planner/useProjection.ts only re-exports). Nothing in this
 * suite noticed, because every test here compared the MCP against itself. That is
 * the gap this file closes: it reconstructs the app's stack from the engine and
 * asserts the adapter agrees with IT, not with its own past output.
 *
 * Why reconstruct rather than import: this file must keep working on the engine
 * alone. `@retiregolden/planner-ui` is now a dev dependency (see
 * planForAiRoundtrip.test.ts), but it is the PUBLISHED package, so importing
 * `taxCalculatorFor` from it would make this file agree with whatever the last
 * release shipped instead of with the stack the app is specified to run — a
 * parity test that imports its own oracle proves nothing. The cost of the copy is
 * that it can drift, so `taxCalculatorFor` below is a literal transcription, and
 * the divergence test at the bottom proves the assertion has teeth by showing the
 * old stack failing it.
 *
 * A modeled state is essential to all of this. In a state with no income tax the
 * two stacks agree trivially and every assertion here would pass against the bug.
 */
import { describe, expect, it } from 'vitest'

import { simulatePlan, summarizeProjection, type Plan } from '@retiregolden/engine'
import { conversionFreeRun } from '@retiregolden/engine/projection/compare'
import {
  combineTaxCalculators,
  createFederalTaxCalculator,
} from '@retiregolden/engine/tax/federalTax'
import { createStateTaxCalculator } from '@retiregolden/engine/tax/stateTax'
import { headlineMonteCarloOptions } from '@retiregolden/engine/montecarlo/headline'
import { createLognormalModel, createMarketModel } from '@retiregolden/engine/montecarlo/marketModels'
import { DEFAULT_MONTE_CARLO_SEED } from '@retiregolden/engine/montecarlo/rng'
import { aggregateMonteCarlo, runMonteCarloPaths } from '@retiregolden/engine/montecarlo/run'
import { comparePlanHeadlines } from '@retiregolden/engine/scenarios/planHeadlines'

import * as adapter from '../src/adapter.js'
import { createSession } from '../src/session.js'
import type { HouseholdParams, PolicyParams } from '../src/buildPlan.js'

/** Transcribed verbatim from planner-ui/src/planTaxCalculator.ts. */
function taxCalculatorFor(plan: Plan) {
  return combineTaxCalculators(
    createFederalTaxCalculator(),
    createStateTaxCalculator({
      overridePct: plan.assumptions.stateEffectiveTaxPct,
      localPct: plan.assumptions.localIncomeTaxPct,
    }),
  )
}

const START_YEAR = 2026

/** KY: a real income-tax state, and the one the RetireGolden example couple lives in. */
const household: HouseholdParams = {
  filing: 'mfj',
  state: 'KY',
  persons: [
    { birth_year: 1959, trad: 1_200_000, roth: 200_000, pia: 3100, pension: 18_000 },
    { birth_year: 1962, trad: 400_000, roth: 80_000, pia: 1900 },
  ],
  taxable: 500_000,
  taxable_basis: 350_000,
  spending: 130_000,
  horizon: 30,
  growth: { trad: 0.05, roth: 0.06, taxable: 0.04 },
  heir_ordinary_rate: 0.22,
}
const policy: PolicyParams = {
  claim_ages: [70, 67],
  conversion_bracket: 0.24,
  conversion_years: 6,
  ordering: 'proportional',
}

function seeded() {
  const session = createSession()
  const build = adapter.setPlanFromBuild(session, { household, policy, startYear: START_YEAR })
  expect(build.ok).toBe(true)
  return session
}

/**
 * What the app would show for this plan. The summary call is transcribed from
 * planner-ui/src/projection.ts's `projectPlan`: the FI figures are priced from
 * the conversion-free run of the same plan on the same options. This file's
 * policy converts for six years, so a summary priced any other way would differ
 * in `fiNumber`, `coastFireNumber` and `fiBasis`, and the whole-summary
 * equalities below would fail.
 */
function asTheAppWouldRunIt(plan: Plan) {
  const simulateOptions = { startYear: START_YEAR, taxCalculator: taxCalculatorFor(plan) }
  const result = simulatePlan(plan, simulateOptions)
  return {
    result,
    summary: summarizeProjection(plan, result, {
      conversionFreeRun: conversionFreeRun(plan, simulateOptions),
    }),
  }
}

describe('run_projection agrees with the web app, year for year', () => {
  it('reproduces the app summary exactly', () => {
    const session = seeded()
    const viaMcp = adapter.runProjection(session, { detail: 'years' })
    expect(viaMcp.ok).toBe(true)
    if (!viaMcp.ok) return

    const app = asTheAppWouldRunIt(session.plan!)
    // Whole summary, not just the headline: a stack difference can hide in
    // lifetime taxes or the estate breakdown while ending net worth coincides.
    expect(viaMcp.summary).toEqual(app.summary)
    expect(viaMcp.startYear).toBe(app.result.startYear)
    expect(viaMcp.endYear).toBe(app.result.endYear)
  })

  it('reproduces the app ledger year for year', () => {
    const session = seeded()
    const viaMcp = adapter.runProjection(session, { detail: 'years' })
    if (!viaMcp.ok || !('years' in viaMcp)) throw new Error('projection missing years')

    const app = asTheAppWouldRunIt(session.plan!)
    expect(viaMcp.years).toHaveLength(app.result.years.length)
    for (const [i, mcpYear] of viaMcp.years.entries()) {
      const appYear = app.result.years[i]!
      expect(mcpYear.year).toBe(appYear.year)
      expect(mcpYear.tax).toBe(appYear.tax)
      expect(mcpYear.magi).toBe(appYear.magi)
      expect(mcpYear.rothConversion).toBe(appYear.rothConversion)
      expect(mcpYear.shortfall).toBe(appYear.shortfall)
    }
  })

  it('taxes this KY household MORE than a federal-only stack would', () => {
    // The assertion with teeth. Without it the two tests above would still pass if
    // someone reverted taxCalc() to federal-only AND this file's transcription
    // drifted with it. Pins the direction and the materiality of the bug that was:
    // federal-only overstated ending net worth by ~13% on the example couple.
    const session = seeded()
    const plan = session.plan!
    const viaMcp = adapter.runProjection(session)
    if (!viaMcp.ok) throw new Error('projection failed')

    const federalOnly = simulatePlan(plan, {
      startYear: START_YEAR,
      taxCalculator: createFederalTaxCalculator(),
    })
    // Only tax and net-worth figures are read, so the FI basis is not priced.
    const federalOnlySummary = summarizeProjection(plan, federalOnly, { conversionFreeRun: null })

    expect(viaMcp.summary.lifetimeTaxesAndPenalties).toBeGreaterThan(
      federalOnlySummary.lifetimeTaxesAndPenalties,
    )
    expect(viaMcp.summary.endingNetWorth).toBeLessThan(federalOnlySummary.endingNetWorth)
    expect(viaMcp.summary.endingNetWorth).not.toBeCloseTo(federalOnlySummary.endingNetWorth, 2)
  })

  it('honors a flat override above 0 instead of the modeled pack', () => {
    // The override path must still reach the engine — and must actually differ from
    // the modeled-pack result, or "override" would be a no-op nobody noticed.
    const session = createSession()
    const build = adapter.setPlanFromBuild(session, {
      household,
      policy,
      startYear: START_YEAR,
      assumptions: { stateEffectiveTaxPct: 9 },
    })
    expect(build.ok).toBe(true)
    const viaMcp = adapter.runProjection(session)
    if (!viaMcp.ok) throw new Error('projection failed')

    expect(viaMcp.summary).toEqual(asTheAppWouldRunIt(session.plan!).summary)
    // 9% flat is well above KY's modeled ~3.5%, so it must bite harder.
    const modeled = adapter.runProjection(seeded())
    if (!modeled.ok) throw new Error('projection failed')
    expect(viaMcp.summary.lifetimeTaxesAndPenalties).toBeGreaterThan(
      modeled.summary.lifetimeTaxesAndPenalties,
    )
  })
})

describe('every simulating path runs the same stack', () => {
  // run_projection was the visible symptom, but taxCalc() fed six call sites. A fix
  // that reached only the projection would leave the optimizer and the spending
  // solver quietly answering the federal-only question.
  it('compare_plans prices each side with its OWN state', () => {
    const session = seeded()
    const ky = session.plan!
    const fl = structuredClone(ky) as Plan
    fl.household.state = 'FL' // no state income tax

    const cmp = adapter.compareScenarios(session, ky, fl, START_YEAR)
    expect(cmp.ok).toBe(true)
    if (!cmp.ok) return
    // FL keeps more, precisely because it is not taxed at KY's rates. A shared
    // calculator built from one side would have made these two agree.
    expect(cmp.b.lifetimeTaxesAndPenalties).toBeLessThan(cmp.a.lifetimeTaxesAndPenalties)
    expect(cmp.deltaEndingAfterTaxEstateNominal).toBeGreaterThan(0)
    expect(cmp.headline.endingAfterTaxEstate.delta).toBeGreaterThan(0)
    expect(cmp.a).toEqual(asTheAppWouldRunIt(ky).summary)
    expect(cmp.b).toEqual(asTheAppWouldRunIt(fl).summary)
  })

  it('max sustainable spending is solved against the state-taxed plan', () => {
    const session = seeded()
    const solved = adapter.solveMaxSpending(session)
    expect(solved.ok).toBe(true)
    if (!solved.ok) return

    // Sanity: a KY household paying state income tax cannot sustain MORE spending
    // than the same household paying none, so the solver must sit below the FL twin.
    const flSession = createSession()
    adapter.setPlanFromBuild(flSession, {
      household: { ...household, state: 'FL' },
      policy,
      startYear: START_YEAR,
    })
    const flSolved = adapter.solveMaxSpending(flSession)
    if (!flSolved.ok) throw new Error('solver failed')
    expect(typeof solved.maxBaseAnnual).toBe('number')
    expect(typeof flSolved.maxBaseAnnual).toBe('number')
    expect(solved.maxBaseAnnual!).toBeLessThan(flSolved.maxBaseAnnual!)
  })

  it('batch evaluation prices policies through the state stack', () => {
    const session = seeded()
    const batch = adapter.batchEvaluate(session, [policy], 'after_tax_estate')
    expect(batch.ok).toBe(true)
    if (!batch.ok) return
    // The single-policy batch restates the session plan, so it must land exactly
    // on the app's number for it.
    expect(batch.results[0]!.objective).toBe(
      asTheAppWouldRunIt(session.plan!).summary.endingAfterTaxEstate,
    )
  })
})

/**
 * The Compare page's comparison of two plans. Transcribed from
 * planner-ui/src/planner/ComparePlansPage.tsx: each side is `projectPlan`'s
 * result and summary (`asTheAppWouldRunIt` above) from one start year, and the
 * page prints the engine's `comparePlanHeadlines` of the two, Plan A the
 * baseline and Plan B the proposal.
 */
function asTheComparePageWouldCompareThem(planA: Plan, planB: Plan) {
  const left = asTheAppWouldRunIt(planA)
  const right = asTheAppWouldRunIt(planB)
  return comparePlanHeadlines(
    { plan: planA, result: left.result, summary: left.summary },
    { plan: planB, result: right.result, summary: right.summary },
  )
}

describe("compare_scenarios' headline is the app's Compare page", () => {
  function expectTheComparePage(planA: Plan, planB: Plan) {
    const cmp = adapter.compareScenarios(seeded(), planA, planB, START_YEAR)
    expect(cmp.ok).toBe(true)
    if (!cmp.ok) throw new Error('comparison failed')
    const page = asTheComparePageWouldCompareThem(planA, planB)
    expect(cmp.headline).toEqual({
      moneyBasis: page.moneyBasis,
      endYear: page.endYear,
      endingAfterTaxEstate: page.endingAfterTaxEstate,
    })
    return cmp
  }

  it('in nominal dollars when the plans end in the same year', () => {
    const ky = seeded().plan!
    const fl = structuredClone(ky) as Plan
    fl.household.state = 'FL'
    const cmp = expectTheComparePage(ky, fl)
    expect(cmp.headline.moneyBasis).toBe('nominal')
    expect(cmp.headline.endingAfterTaxEstate.delta).toBe(cmp.deltaEndingAfterTaxEstateNominal)
  })

  it("in today's dollars when they end in different years, where the nominal field differs", () => {
    const shorter = seeded().plan!
    const longerSession = createSession()
    expect(
      adapter.setPlanFromBuild(longerSession, {
        household: { ...household, horizon: household.horizon + 5 },
        policy,
        startYear: START_YEAR,
      }).ok,
    ).toBe(true)
    const cmp = expectTheComparePage(shorter, longerSession.plan!)
    expect(cmp.headline.moneyBasis).toBe('today')
    expect(cmp.headline.endYear.delta).toBe(5)
    expect(cmp.headline.endingAfterTaxEstate.delta).not.toBe(cmp.deltaEndingAfterTaxEstateNominal)
  })
})

/**
 * The app's headline Monte Carlo run at `pathCount` paths. Transcribed from
 * planner-ui: `useMcSuccessRate.ts#headlineMcRunOptions` takes the engine's
 * `headlineMonteCarloOptions` whole, `mc/runRequest.ts#runMcRequest` runs them
 * with `createMarketModel` and the plan's own tax stack (no stochastic
 * longevity, no care shock), and `mc/pool.ts` aggregates the paths with
 * `aggregateMonteCarlo`. The app runs 1,000 paths; the tests below run fewer,
 * because path i is the same market at any count (the full count's own
 * wiring is pinned in tests/monteCarloHeadline.wiring.test.ts).
 */
function asTheAppsHeadlineRunWouldRunIt(plan: Plan, pathCount: number) {
  const options = headlineMonteCarloOptions(plan, START_YEAR, pathCount)
  return aggregateMonteCarlo(
    runMonteCarloPaths(plan, {
      startYear: options.startYear,
      taxCalculator: taxCalculatorFor(plan),
      model: createMarketModel(options.model),
      seed: options.seed,
      pathCount: options.pathCount,
    }),
  )
}

const MC_PATHS = 40

// Each case runs two or three Monte Carlo batches of 40 thirty-year paths: under
// a second apiece locally, several on a hosted runner.
describe("run_monte_carlo's defaults are the app's headline run", { timeout: 60_000 }, () => {
  function expectTheHeadline(session: ReturnType<typeof seeded>) {
    const mc = adapter.runMonteCarlo(session, { pathCount: MC_PATHS })
    expect(mc.ok).toBe(true)
    if (!mc.ok) throw new Error('monte carlo failed')
    const app = asTheAppsHeadlineRunWouldRunIt(session.plan!, MC_PATHS)
    expect(mc.successRate).toBe(app.successRate)
    expect(mc.requiredFloorSuccessRate).toBe(app.requiredFloorSuccessRate)
    const p = app.endingInvestable.percentiles
    expect(mc.percentiles).toEqual({ p10: p.p10, p25: p.p25, p50: p.p50, p75: p.p75, p90: p.p90 })
    return mc
  }

  it('draws the same markets for a single-return plan', () => {
    const mc = expectTheHeadline(seeded())
    expect(mc.seed).toBe(DEFAULT_MONTE_CARLO_SEED)
    expect(mc.returnVolPct).toBe(12)
    // The 0.11.x default seed draws other markets, so the default is not inert.
    const seed42 = adapter.runMonteCarlo(seeded(), { pathCount: MC_PATHS, seed: 42 })
    if (!seed42.ok) throw new Error('monte carlo failed')
    expect(seed42.percentiles).not.toEqual(mc.percentiles)
  })

  it("draws per-class shocks for a plan with an allocated account, as the app's model does", () => {
    const allocated = structuredClone(seeded().plan!) as Plan
    const account = allocated.accounts.find((a) => a.type === 'traditional')!
    Object.assign(account, {
      allocation: { mode: 'static', rebalancing: 'annual', weights: { usStocks: 60, intlStocks: 10, bonds: 30, cash: 0 } },
    })
    const session = createSession()
    expect(adapter.setPlanFromBuild(session, { plan: allocated, startYear: START_YEAR }).ok).toBe(true)
    const mc = expectTheHeadline(session)
    // The plain lognormal model 0.11.x ran, on the same seed: without the class
    // shocks an allocated plan draws different markets.
    const plain = aggregateMonteCarlo(
      runMonteCarloPaths(session.plan!, {
        startYear: START_YEAR,
        taxCalculator: taxCalculatorFor(session.plan!),
        model: createLognormalModel({
          type: 'lognormal',
          inflationMeanPct: session.plan!.assumptions.inflationPct,
          returnVolPct: 12,
        }),
        seed: DEFAULT_MONTE_CARLO_SEED,
        pathCount: MC_PATHS,
      }),
    )
    const q = plain.endingInvestable.percentiles
    expect(mc.percentiles).not.toEqual({ p10: q.p10, p25: q.p25, p50: q.p50, p75: q.p75, p90: q.p90 })
  })
})

describe('explain_modeled_result describes the stack it actually ran', () => {
  it('names the combined federal + state stack and the app-parity claim', () => {
    const session = seeded()
    const explained = adapter.explainModeledResult(session)
    expect(explained.taxStack).toContain('Federal')
    expect(explained.taxStack).toContain('state')
    expect(explained.taxStack).toContain('RetireGolden web app')
  })

  it('warns that a 0 override is not a disabled state tax', () => {
    const session = seeded()
    const explained = adapter.explainModeledResult(session)
    expect(
      explained.limitations.some(
        (l) => l.includes('stateEffectiveTaxPct') && l.includes('not "no state income tax"'),
      ),
    ).toBe(true)
  })
})
