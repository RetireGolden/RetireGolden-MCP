/**
 * WS2.5 / WS1.3 GOLDEN-NUMBER TESTS — the numeric contract with the engine/adapter.
 *
 * TWO golden sets:
 *
 *  1. LEGACY bench-convention goldens (`describe('golden numbers — … [legacy …]')`).
 *     The SAME exact literals captured from unmodified `main` under RetireBench
 *     conventions (0% inflation, state KY, zero state tax, June-15 dobs, sex
 *     'average', qualifiedRatio 0.85). After the WS1.3 default flip these no longer
 *     reproduce from a bare build — the typed-path defaults now follow the ENGINE
 *     (2.5% inflation, matchInflation SS COLA, etc.). To keep the literals frozen we
 *     now pass every bench convention EXPLICITLY through the `assumptions` block
 *     (`BENCH_ASSUMPTIONS`) plus the now-required `state: 'KY'`. That these unchanged
 *     numbers still reproduce PROVES the override path preserves legacy behavior.
 *
 *  2. NEW-DEFAULT goldens (`describe('golden numbers — … [new defaults]')`). Built
 *     with NO `assumptions` block, so the engine defaults flow through (real
 *     inflation etc.). Fresh literals generated on this branch. These prove the flip
 *     actually changed the modeled outcome (inflation-adjusted, non-zero SS COLA).
 *
 * Both sets exist to catch engine/adapter NUMERIC DRIFT. Refresh DELIBERATELY on an
 * engine bump — never casually to make a red test go green. If a LEGACY golden fails
 * and the engine version has not changed, a feature agent altered how an explicit
 * override reaches the engine — a BLOCKING regression, not a golden to adjust.
 *
 * Generation recipe (scratchpad/gen-goldens.mjs on this branch):
 *   session = createSession()
 *   setPlanFromBuild(session, { household, policy, startYear: 2026, assumptions? })
 *   proj  = runProjection(session, { detail: 'years' })  // detail:'years' is REQUIRED
 *                                                         // for the per-year ledger; the
 *                                                         // default 'summary' omits years[]
 *   mc    = runMonteCarlo(session, { pathCount: 300, seed: 7 })
 *   batch = batchEvaluate(session,
 *             [policy, { ...policy, conversion_bracket: null, conversion_years: 0 }],
 *             'after_tax_estate')
 *   totalTax         = sum of years[].tax
 *   totalConversions = sum of years[].rothConversion
 */

import { describe, expect, it } from 'vitest'
import { createSession } from '../src/session.js'
import * as adapter from '../src/adapter.js'
import type { AssumptionsInput, HouseholdParams, PolicyParams } from '../src/buildPlan.js'

/**
 * Every RetireBench convention stated explicitly. Passing this reproduces the
 * pre-WS1.3 typed-path defaults exactly (the values the old hardcode forced), so
 * the legacy golden literals below stay frozen through the default flip.
 */
const BENCH_ASSUMPTIONS: AssumptionsInput = {
  inflationPct: 0,
  healthcareExtraInflationPct: 0,
  defaultReturnPct: 0,
  ssColaPct: 0,
  state: 'KY',
  stateEffectiveTaxPct: 0,
  localIncomeTaxPct: 0,
  qualifiedRatio: 0.85,
  dobMonthDay: '06-15',
  sex: 'average',
}

// --- Fixture SINGLE ---------------------------------------------------------
const singleHousehold: HouseholdParams = {
  filing: 'single',
  state: 'KY',
  persons: [{ birth_year: 1960, trad: 900_000, roth: 150_000, pia: 2800 }],
  taxable: 300_000,
  taxable_basis: 200_000,
  spending: 90_000,
  horizon: 25,
  growth: { trad: 0.05, roth: 0.05, taxable: 0.04 },
  heir_ordinary_rate: 0.24,
}
const singlePolicy: PolicyParams = {
  claim_ages: [70],
  conversion_bracket: 0.22,
  conversion_years: 8,
  ordering: 'taxable-first',
}

// --- Fixture MFJ ------------------------------------------------------------
const mfjHousehold: HouseholdParams = {
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
  pre_horizon_magi: [110_000, 115_000],
  heir_ordinary_rate: 0.22,
}
const mfjPolicy: PolicyParams = {
  claim_ages: [70, 67],
  conversion_bracket: 0.24,
  conversion_years: 6,
  ordering: 'proportional',
}

/** Rebuild the exact baseline pipeline for a fixture and return raw outputs. */
function runFixture(
  household: HouseholdParams,
  policy: PolicyParams,
  assumptions?: AssumptionsInput,
) {
  const session = createSession()
  const build = adapter.setPlanFromBuild(session, {
    household,
    policy,
    startYear: 2026,
    ...(assumptions ? { assumptions } : {}),
  })
  expect(build.ok).toBe(true)
  const proj = adapter.runProjection(session, { detail: 'years' })
  expect(proj.ok).toBe(true)
  if (!proj.ok || !('years' in proj)) throw new Error('projection missing years')
  const mc = adapter.runMonteCarlo(session, { pathCount: 300, seed: 7 })
  expect(mc.ok).toBe(true)
  const batch = adapter.batchEvaluate(
    session,
    [policy, { ...policy, conversion_bracket: null, conversion_years: 0 }],
    'after_tax_estate',
  )
  expect(batch.ok).toBe(true)
  const years = proj.years
  const totalTax = years.reduce((s, y) => s + y.tax, 0)
  const totalConversions = years.reduce((s, y) => s + y.rothConversion, 0)
  return {
    build,
    caveats: build.caveats,
    proj,
    years,
    firstYear: years[0]!,
    lastYear: years[years.length - 1]!,
    totalTax,
    totalConversions,
    mc: mc as Extract<typeof mc, { ok: true }>,
    batch: batch as Extract<typeof batch, { ok: true }>,
  }
}

describe('golden numbers — SINGLE fixture [legacy bench conventions via explicit assumptions]', () => {
  const g = runFixture(singleHousehold, singlePolicy, BENCH_ASSUMPTIONS)

  it('projection window', () => {
    expect(g.proj.startYear).toBe(2026)
    expect(g.proj.endYear).toBe(2050)
    expect(g.years).toHaveLength(25)
  })

  it('projection summary headline numbers', () => {
    const s = g.proj.ok ? g.proj.summary : null
    expect(s).toBeTruthy()
    expect(s!.lifetimeTaxesAndPenalties).toBe(213050.6699287244)
    expect(s!.lifetimeRothConversions).toBe(680957.0281863213)
    expect(s!.endingInvestable).toBe(784144.4259322027)
    expect(s!.endingNetWorth).toBe(784144.4259322027)
    expect(s!.endingAfterTaxEstate).toBe(784144.4259322027)
    expect(s!.endingEstateHeirTax).toBe(0)
    expect(s!.endingEstateToCharity).toBe(0)
    expect(s!.endingByCategory.cash).toBe(0)
    expect(s!.endingByCategory.taxable).toBe(0)
    expect(s!.endingByCategory.traditional).toBe(0)
    expect(s!.endingByCategory.roth).toBe(784144.4259322027)
    expect(s!.endingByCategory.hsa).toBe(0)
    expect(s!.depletionYear).toBeNull()
    expect(s!.averagePreRetirementSavingsRatePct).toBe(0)
    expect(s!.fiNumber).toBe(2920038.075168321)
    expect(s!.coastFireNumber).toBe(2920038.075168321)
  })

  it('first projection year', () => {
    const y = g.firstYear
    expect(y.year).toBe(2026)
    expect(y.tax).toBe(24366.723006732842)
    expect(y.penalties).toBe(0)
    expect(y.magi).toBe(165679.1221628247)
    expect(y.medicarePremiums).toBe(2434.8)
    expect(y.irmaaTier).toBe(0)
    expect(y.rothConversion).toBe(126745.28136849403)
    expect(y.withdrawals.cash).toBe(0)
    expect(y.withdrawals.taxable).toBe(116801.522382992)
    expect(y.withdrawals.traditional).toBe(0)
    expect(y.withdrawals.roth).toBe(0)
    expect(y.withdrawals.hsa).toBe(0)
    expect(y.withdrawals.total).toBe(116801.522382992)
    expect(y.shortfall).toBe(0)
  })

  it('last projection year', () => {
    const y = g.lastYear
    expect(y.year).toBe(2050)
    expect(y.tax).toBe(0)
    expect(y.penalties).toBe(0)
    expect(y.magi).toBe(0)
    expect(y.medicarePremiums).toBe(2434.8)
    expect(y.irmaaTier).toBe(0)
    expect(y.rothConversion).toBe(0)
    expect(y.withdrawals.roth).toBe(50770.8)
    expect(y.withdrawals.total).toBe(50770.8)
    expect(y.shortfall).toBe(0)
  })

  it('totalTax and totalConversions', () => {
    expect(g.totalTax).toBe(213050.6699287244)
    expect(g.totalConversions).toBe(680957.0281863213)
  })

  it('monte carlo (pathCount 300, seed 7)', () => {
    expect(g.mc.successRate).toBe(0.7233333333333334)
    expect(g.mc.requiredFloorSuccessRate).toBe(0.7233333333333334)
  })

  it('batch objectives (base policy, then no-conversion policy)', () => {
    expect(g.batch.results.map((r) => r.objective)).toEqual([
      784144.4259322027, 886944.3888095352,
    ])
  })
})

describe('golden numbers — MFJ fixture [legacy bench conventions via explicit assumptions]', () => {
  const g = runFixture(mfjHousehold, mfjPolicy, BENCH_ASSUMPTIONS)

  it('projection window', () => {
    expect(g.proj.startYear).toBe(2026)
    expect(g.proj.endYear).toBe(2055)
    expect(g.years).toHaveLength(30)
  })

  it('projection summary headline numbers', () => {
    const s = g.proj.ok ? g.proj.summary : null
    expect(s).toBeTruthy()
    expect(s!.lifetimeTaxesAndPenalties).toBe(372987.01595847134)
    expect(s!.lifetimeRothConversions).toBe(1483986.5982225612)
    expect(s!.endingInvestable).toBe(5542574.950033693)
    expect(s!.endingNetWorth).toBe(5542574.950033693)
    expect(s!.endingAfterTaxEstate).toBe(5542574.950033693)
    expect(s!.endingEstateHeirTax).toBe(0)
    expect(s!.endingEstateToCharity).toBe(0)
    expect(s!.endingByCategory.cash).toBe(0)
    expect(s!.endingByCategory.taxable).toBe(730646.033678199)
    expect(s!.endingByCategory.traditional).toBe(0)
    expect(s!.endingByCategory.roth).toBe(4811928.9163554935)
    expect(s!.endingByCategory.hsa).toBe(0)
    expect(s!.depletionYear).toBeNull()
    expect(s!.averagePreRetirementSavingsRatePct).toBe(0)
    expect(s!.fiNumber).toBe(6380258.62772676)
    expect(s!.coastFireNumber).toBe(6380258.62772676)
  })

  it('first projection year', () => {
    const y = g.firstYear
    expect(y.year).toBe(2026)
    expect(y.tax).toBe(122775.5451090704)
    expect(y.penalties).toBe(0)
    expect(y.magi).toBe(570018.5218463398)
    expect(y.medicarePremiums).toBe(2434.8)
    expect(y.irmaaTier).toBe(0)
    expect(y.rothConversion).toBe(419399.9997228384)
    expect(y.withdrawals.cash).toBe(0)
    expect(y.withdrawals.taxable).toBe(49834.10570264438)
    expect(y.withdrawals.traditional).toBe(117668.2904127081)
    expect(y.withdrawals.roth).toBe(69707.94702923475)
    expect(y.withdrawals.hsa).toBe(0)
    expect(y.withdrawals.total).toBe(237210.34314458724)
    expect(y.shortfall).toBe(7.275957614183426e-12)
  })

  it('last projection year', () => {
    const y = g.lastYear
    expect(y.year).toBe(2055)
    expect(y.tax).toBe(9.775904483853083)
    expect(y.penalties).toBe(0)
    expect(y.magi).toBe(40530.181450530916)
    expect(y.medicarePremiums).toBe(4869.6)
    expect(y.irmaaTier).toBe(0)
    expect(y.rothConversion).toBe(0)
    expect(y.withdrawals.cash).toBe(0)
    expect(y.withdrawals.taxable).toBe(6359.951651876914)
    expect(y.withdrawals.traditional).toBe(0)
    expect(y.withdrawals.roth).toBe(41095.42349631257)
    expect(y.withdrawals.hsa).toBe(0)
    expect(y.withdrawals.total).toBe(47455.37514818949)
    expect(y.shortfall).toBe(0)
  })

  it('totalTax and totalConversions', () => {
    expect(g.totalTax).toBe(372987.01595847134)
    expect(g.totalConversions).toBe(1483986.5982225612)
  })

  it('monte carlo (pathCount 300, seed 7)', () => {
    expect(g.mc.successRate).toBe(0.9933333333333333)
    expect(g.mc.requiredFloorSuccessRate).toBe(0.9933333333333333)
  })

  it('batch objectives (base policy, then no-conversion policy)', () => {
    expect(g.batch.results.map((r) => r.objective)).toEqual([
      5542574.950033693, 4604197.066016462,
    ])
  })
})

// ===========================================================================
// NEW-DEFAULT goldens (WS1.3): the SAME two fixtures built with NO `assumptions`
// block, so the engine's createEmptyPlan defaults flow through — ~2.5% inflation,
// SS COLA tracking inflation, +3% healthcare inflation, 5.5% fallback return.
// Fresh literals generated on this branch (scratchpad/gen-goldens.mjs). These
// prove the flip actually moved the modeled outcome away from the growth-neutral
// bench numbers: the single household now DEPLETES under real inflation, and
// Medicare premiums grow year over year instead of staying flat.
//
// NOTE: the first projection year (2026 = startYear) matches the legacy numbers
// exactly — inflation has not compounded and SS is not yet claimed in year one —
// so divergence appears in the LATER years, the summary, and Monte Carlo.
// ===========================================================================

describe('golden numbers — SINGLE fixture [new engine defaults, no assumptions]', () => {
  const g = runFixture(singleHousehold, singlePolicy)

  it('bare build surfaces the state-tax footgun caveat and no wage caveat', () => {
    // No assumptions block → household.state ('KY') is set but stateEffectiveTaxPct
    // is not, so the state-income-tax footgun caveat fires on the happy path.
    const stateCaveat = g.caveats.find((c) => c.includes('stateEffectiveTaxPct'))
    expect(stateCaveat).toBeTruthy()
    expect(stateCaveat).toContain('state=KY')
    // Wages are a hard error, never a caveat — and no wage is set here.
    expect(g.caveats.some((c) => c.toLowerCase().includes('wage'))).toBe(false)
  })

  it('projection window', () => {
    expect(g.proj.startYear).toBe(2026)
    expect(g.proj.endYear).toBe(2050)
    expect(g.years).toHaveLength(25)
  })

  it('projection summary headline numbers', () => {
    const s = g.proj.ok ? g.proj.summary : null
    expect(s).toBeTruthy()
    expect(s!.lifetimeTaxesAndPenalties).toBe(216583.01689654737)
    expect(s!.lifetimeRothConversions).toBe(672626.8199622631)
    expect(s!.endingInvestable).toBe(0)
    expect(s!.endingNetWorth).toBe(0)
    expect(s!.endingAfterTaxEstate).toBe(0)
    expect(s!.endingEstateHeirTax).toBe(0)
    expect(s!.endingEstateToCharity).toBe(0)
    expect(s!.endingByCategory.cash).toBe(0)
    expect(s!.endingByCategory.taxable).toBe(0)
    expect(s!.endingByCategory.traditional).toBe(0)
    expect(s!.endingByCategory.roth).toBe(0)
    expect(s!.endingByCategory.hsa).toBe(0)
    // Real inflation depletes this household within the horizon — the sharpest
    // contrast with the legacy goldens, where depletionYear is null.
    expect(s!.depletionYear).toBe(2050)
    expect(s!.fiNumber).toBe(2920038.075168321)
    expect(s!.coastFireNumber).toBe(2920038.075168321)
  })

  it('first projection year matches legacy (year one, pre-compounding)', () => {
    const y = g.firstYear
    expect(y.year).toBe(2026)
    expect(y.tax).toBe(24366.723006732842)
    expect(y.magi).toBe(165679.1221628247)
    expect(y.medicarePremiums).toBe(2434.8)
    expect(y.rothConversion).toBe(126745.28136849403)
    expect(y.withdrawals.taxable).toBe(116801.522382992)
    expect(y.withdrawals.total).toBe(116801.522382992)
    expect(y.shortfall).toBe(0)
  })

  it('last projection year (inflation-grown Medicare, terminal shortfall)', () => {
    const y = g.lastYear
    expect(y.year).toBe(2050)
    expect(y.tax).toBe(0)
    expect(y.penalties).toBe(0)
    expect(y.magi).toBe(7627.472134448784)
    // Medicare premiums have grown with inflation — legacy holds these flat at 2434.8.
    expect(y.medicarePremiums).toBe(8800.803498030542)
    expect(y.irmaaTier).toBe(0)
    expect(y.rothConversion).toBe(0)
    expect(y.withdrawals.roth).toBe(66661.69405771773)
    expect(y.withdrawals.total).toBe(66661.69405771773)
    expect(y.shortfall).toBe(29565.686939336767)
  })

  it('totalTax and totalConversions', () => {
    expect(g.totalTax).toBe(216583.01689654737)
    expect(g.totalConversions).toBe(672626.8199622631)
  })

  it('monte carlo (pathCount 300, seed 7) — lower success under real inflation', () => {
    expect(g.mc.successRate).toBe(0.36)
    expect(g.mc.requiredFloorSuccessRate).toBe(0.36)
  })

  it('batch objectives (base policy, then no-conversion policy)', () => {
    expect(g.batch.results.map((r) => r.objective)).toEqual([0, 4196.413254324333])
  })
})

describe('golden numbers — MFJ fixture [new engine defaults, no assumptions]', () => {
  const g = runFixture(mfjHousehold, mfjPolicy)

  it('projection window', () => {
    expect(g.proj.startYear).toBe(2026)
    expect(g.proj.endYear).toBe(2055)
    expect(g.years).toHaveLength(30)
  })

  it('projection summary headline numbers', () => {
    const s = g.proj.ok ? g.proj.summary : null
    expect(s).toBeTruthy()
    expect(s!.lifetimeTaxesAndPenalties).toBe(425608.812455453)
    expect(s!.lifetimeRothConversions).toBe(1481708.491565676)
    expect(s!.endingInvestable).toBe(3465081.4457688583)
    expect(s!.endingNetWorth).toBe(3465081.4457688583)
    expect(s!.endingAfterTaxEstate).toBe(3465081.4457688583)
    expect(s!.endingEstateHeirTax).toBe(0)
    expect(s!.endingEstateToCharity).toBe(0)
    expect(s!.endingByCategory.cash).toBe(0)
    expect(s!.endingByCategory.taxable).toBe(456780.12950036937)
    expect(s!.endingByCategory.traditional).toBe(0)
    expect(s!.endingByCategory.roth).toBe(3008301.3162684888)
    expect(s!.endingByCategory.hsa).toBe(0)
    expect(s!.depletionYear).toBeNull()
    expect(s!.fiNumber).toBe(6380258.62772676)
    expect(s!.coastFireNumber).toBe(6380258.62772676)
  })

  it('first projection year matches legacy (year one, pre-compounding)', () => {
    const y = g.firstYear
    expect(y.year).toBe(2026)
    expect(y.tax).toBe(122775.5451090704)
    expect(y.magi).toBe(570018.5218463398)
    expect(y.medicarePremiums).toBe(2434.8)
    expect(y.rothConversion).toBe(419399.9997228384)
    expect(y.withdrawals.total).toBe(237210.34314458724)
  })

  it('last projection year (inflation-grown Medicare)', () => {
    const y = g.lastYear
    expect(y.year).toBe(2055)
    expect(y.tax).toBe(4128.5997775709675)
    expect(y.penalties).toBe(0)
    expect(y.magi).toBe(87872.06328168415)
    expect(y.medicarePremiums).toBe(23004.59639238729)
    expect(y.irmaaTier).toBe(0)
    expect(y.rothConversion).toBe(0)
    expect(y.withdrawals.taxable).toBe(17837.455552011197)
    expect(y.withdrawals.roth).toBe(115258.91006322384)
    expect(y.withdrawals.total).toBe(133096.36561523503)
    expect(y.shortfall).toBe(0)
  })

  it('totalTax and totalConversions', () => {
    expect(g.totalTax).toBe(425608.812455453)
    expect(g.totalConversions).toBe(1481708.491565676)
  })

  it('monte carlo (pathCount 300, seed 7)', () => {
    expect(g.mc.successRate).toBe(0.85)
    expect(g.mc.requiredFloorSuccessRate).toBe(0.85)
  })

  it('batch objectives (base policy, then no-conversion policy)', () => {
    expect(g.batch.results.map((r) => r.objective)).toEqual([
      3465081.4457688583, 2602975.813224987,
    ])
  })
})

// The engine-default passthrough itself: a bare typed build must NOT force the
// old growth-neutral zeros — createEmptyPlan's defaults reach plan.assumptions.
describe('engine-default passthrough (WS1.3 decision a)', () => {
  it('a build with no assumptions block carries the engine defaults', () => {
    const session = createSession()
    const build = adapter.setPlanFromBuild(session, {
      household: singleHousehold,
      policy: singlePolicy,
      startYear: 2026,
    })
    expect(build.ok).toBe(true)
    const a = build.plan!.assumptions
    expect(a.inflationPct).toBe(2.5)
    expect(a.healthcareExtraInflationPct).toBe(3)
    expect(a.defaultReturnPct).toBe(5.5)
    expect(a.ssCola).toEqual({ mode: 'matchInflation' })
    // Tax rates the engine defaults to zero stay zero (not overridden away).
    expect(a.stateEffectiveTaxPct).toBe(0)
    expect(a.localIncomeTaxPct).toBe(0)
  })
})
