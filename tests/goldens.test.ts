/**
 * WS2.5 / WS1.3 GOLDEN-NUMBER TESTS — the numeric contract with the engine/adapter.
 *
 * TWO golden sets:
 *
 *  1. LEGACY bench-convention goldens (`describe('golden numbers — … [legacy …]')`).
 *     The RetireBench conventions (0% inflation, state KY, zero state tax, June-15
 *     DOBs, sex 'average', qualifiedRatio 0.85) built via the `assumptions` block,
 *     NOT via bare typed-path defaults. After the WS1.3 default flip a bare build
 *     no longer reproduces these — the typed-path defaults now follow the ENGINE
 *     (2.5% inflation, matchInflation SS COLA, etc.) — so every bench convention is
 *     passed EXPLICITLY through `BENCH_ASSUMPTIONS` plus the now-required
 *     `state: 'KY'`. These literals are frozen RELATIVE TO THE PINNED ENGINE, not
 *     bit-identical to the historical 0.1.1 numbers: they are regenerated whenever
 *     the pinned engine bumps (they moved for engine 0.1.2's tax-solver fix). That
 *     the SAME explicit conventions reproduce them under the pinned engine PROVES
 *     the override path preserves legacy behavior across the default flip.
 *
 *  2. NEW-DEFAULT goldens (`describe('golden numbers — … [new defaults]')`). Built
 *     with NO `assumptions` block, so the engine defaults flow through (real
 *     inflation etc.). Fresh literals generated on this branch. These prove the flip
 *     actually changed the modeled outcome (inflation-adjusted, non-zero SS COLA).
 *
 * Both sets exist to catch engine/adapter NUMERIC DRIFT. Refresh DELIBERATELY on an
 * engine bump (as was done for engine 0.1.2) — never casually to make a red test go
 * green. If a LEGACY golden fails and the pinned engine version has NOT changed, a
 * feature agent altered how an explicit override reaches the engine — a BLOCKING
 * regression, not a golden to adjust.
 *
 * REGENERATED FOR 0.5.0 — the one refresh so far that was not an engine bump. The
 * adapter moved from a federal-only tax stack to the app's federal+state stack, so
 * every literal here moved: both fixtures live in KY, which taxes income. The
 * LEGACY set moved too, and that does NOT contradict the paragraph above — the
 * explicit-override path is intact. What changed is that the bench convention
 * `stateEffectiveTaxPct: 0` never meant what it looked like: the engine reads 0 as
 * "use the modeled KY pack", so the bench was getting zero state tax only because
 * the MCP was not consulting the state calculator at all. No knob restores it, and
 * the pre-0.5.0 numbers are reproducible only on a pre-0.5.0 package — which the
 * bench harness pins. See CHANGELOG 0.5.0.
 *
 * Regenerated for engine 0.1.9 (execution-source integrity, inherited-IRA,
 * exempt-interest, per-donor QCD engine wave). Verified UNCHANGED under engine
 * 0.1.10 (advisor-cockpit scenario surfaces only; no projection-behavior change)
 * and under engine 0.1.11 (insight governance, detector catalog, and published
 * entity facts — observation-only; no projection-behavior change).
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
 * the legacy golden literals below hold through the default flip — frozen relative
 * to the pinned engine and regenerated deliberately on an engine bump.
 *
 * One convention no longer does what it says: `stateEffectiveTaxPct: 0` reads as
 * "no state income tax" but the engine treats 0 as "use the modeled pack for
 * `state`", and since 0.5.0 the adapter actually consults that calculator. So this
 * block now models KY's real income tax, and the growth-neutral intent of the
 * bench holds for inflation/COLA/returns but NOT for state tax. Kept verbatim
 * anyway: its job is to prove the explicit-override path still reaches the engine
 * unchanged, and pinning a convention that quietly changed meaning is exactly the
 * drift these goldens exist to catch.
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
    expect(s!.lifetimeTaxesAndPenalties).toBe(250388.2838890143)
    expect(s!.lifetimeRothConversions).toBe(651410.5572395471)
    expect(s!.endingInvestable).toBe(668917.7285081611)
    expect(s!.endingNetWorth).toBe(668917.7285081611)
    expect(s!.endingAfterTaxEstate).toBe(668917.7285081611)
    expect(s!.endingEstateHeirTax).toBe(0)
    expect(s!.endingEstateToCharity).toBe(0)
    expect(s!.endingByCategory.cash).toBe(0)
    expect(s!.endingByCategory.taxable).toBe(0)
    expect(s!.endingByCategory.traditional).toBe(0)
    expect(s!.endingByCategory.roth).toBe(668917.7285081611)
    expect(s!.endingByCategory.hsa).toBe(0)
    expect(s!.depletionYear).toBeNull()
    expect(s!.averagePreRetirementSavingsRatePct).toBe(0)
    expect(s!.fiNumber).toBe(3072179.647177051)
    expect(s!.coastFireNumber).toBe(3072179.647177051)
  })

  it('first projection year', () => {
    const y = g.firstYear
    expect(y.year).toBe(2026)
    expect(y.tax).toBe(30452.385887082044)
    expect(y.penalties).toBe(0)
    expect(y.magi).toBe(167707.67584712929)
    expect(y.medicarePremiums).toBe(2434.8)
    expect(y.irmaaTier).toBe(0)
    expect(y.rothConversion).toBe(126745.28136849403)
    expect(y.withdrawals.cash).toBe(0)
    expect(y.withdrawals.taxable).toBe(122887.18343590572)
    expect(y.withdrawals.traditional).toBe(0)
    expect(y.withdrawals.roth).toBe(0)
    expect(y.withdrawals.hsa).toBe(0)
    expect(y.withdrawals.total).toBe(122887.18343590572)
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
    expect(g.totalTax).toBe(250388.2838890143)
    expect(g.totalConversions).toBe(651410.5572395471)
  })

  it('monte carlo (pathCount 300, seed 7)', () => {
    expect(g.mc.successRate).toBe(0.6733333333333333)
    expect(g.mc.requiredFloorSuccessRate).toBe(0.6733333333333333)
  })

  it('batch objectives (base policy, then no-conversion policy)', () => {
    expect(g.batch.results.map((r) => r.objective)).toEqual([
      668917.7285081611, 833828.4656568047,
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
    expect(s!.lifetimeTaxesAndPenalties).toBe(447253.2197470774)
    expect(s!.lifetimeRothConversions).toBe(1465361.931736874)
    expect(s!.endingInvestable).toBe(5217056.354866119)
    expect(s!.endingNetWorth).toBe(5217056.354866119)
    expect(s!.endingAfterTaxEstate).toBe(5217056.354866119)
    expect(s!.endingEstateHeirTax).toBe(0)
    expect(s!.endingEstateToCharity).toBe(0)
    expect(s!.endingByCategory.cash).toBe(0)
    expect(s!.endingByCategory.taxable).toBe(687678.1433585073)
    expect(s!.endingByCategory.traditional).toBe(0)
    expect(s!.endingByCategory.roth).toBe(4529378.211507612)
    expect(s!.endingByCategory.hsa).toBe(0)
    expect(s!.depletionYear).toBeNull()
    expect(s!.averagePreRetirementSavingsRatePct).toBe(0)
    expect(s!.fiNumber).toBe(6931783.7683923105)
    expect(s!.coastFireNumber).toBe(6931783.7683923105)
  })

  it('first projection year', () => {
    const y = g.firstYear
    expect(y.year).toBe(2026)
    expect(y.tax).toBe(144836.55073569246)
    expect(y.penalties).toBe(0)
    expect(y.magi).toBe(582352.2935296915)
    expect(y.medicarePremiums).toBe(2434.8)
    expect(y.irmaaTier).toBe(0)
    expect(y.rothConversion).toBe(419400)
    expect(y.withdrawals.cash).toBe(0)
    expect(y.withdrawals.taxable).toBe(54468.77105429562)
    expect(y.withdrawals.traditional).toBe(128611.66221340286)
    expect(y.withdrawals.roth).toBe(76190.91695074874)
    expect(y.withdrawals.hsa).toBe(0)
    expect(y.withdrawals.total).toBe(259271.35021844722)
    expect(y.shortfall).toBe(0)
  })

  it('last projection year', () => {
    const y = g.lastYear
    expect(y.year).toBe(2055)
    expect(y.tax).toBe(584.3276188169453)
    expect(y.penalties).toBe(0)
    expect(y.magi).toBe(40639.90079009457)
    expect(y.medicarePremiums).toBe(4869.6)
    expect(y.irmaaTier).toBe(0)
    expect(y.rothConversion).toBe(0)
    expect(y.withdrawals.cash).toBe(0)
    expect(y.withdrawals.taxable).toBe(6436.424102663116)
    expect(y.withdrawals.traditional).toBe(0)
    expect(y.withdrawals.roth).toBe(41593.502396800206)
    expect(y.withdrawals.hsa).toBe(0)
    expect(y.withdrawals.total).toBe(48029.92649946332)
    expect(y.shortfall).toBeCloseTo(0, 6)
  })

  it('totalTax and totalConversions', () => {
    expect(g.totalTax).toBe(447253.2197470774)
    expect(g.totalConversions).toBe(1465361.931736874)
  })

  it('monte carlo (pathCount 300, seed 7)', () => {
    expect(g.mc.successRate).toBe(0.9766666666666667)
    expect(g.mc.requiredFloorSuccessRate).toBe(0.9766666666666667)
  })

  it('batch objectives (base policy, then no-conversion policy)', () => {
    expect(g.batch.results.map((r) => r.objective)).toEqual([
      5217056.354866119, 4517886.078238976,
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

  it('bare build says KY\'s modeled income tax applies, and emits no wage caveat', () => {
    // No assumptions block → household.state ('KY') selects KY's modeled pack. The
    // caveat must say the tax APPLIES; before 0.5.0 it claimed the opposite
    // ("modeled at 0%"), which was the visible half of the federal-only bug.
    const stateCaveat = g.caveats.find((c) => c.includes('stateEffectiveTaxPct'))
    expect(stateCaveat).toBeTruthy()
    expect(stateCaveat).toContain('state=KY')
    expect(stateCaveat).toContain('modeled KY income tax applies')
    expect(stateCaveat).not.toContain('modeled at 0%')
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
    expect(s!.lifetimeTaxesAndPenalties).toBe(248916.78354709756)
    expect(s!.lifetimeRothConversions).toBe(620061.0887504726)
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
    expect(s!.depletionYear).toBe(2049)
    expect(s!.fiNumber).toBe(3072179.647177051)
    expect(s!.coastFireNumber).toBe(3072179.647177051)
  })

  it('first projection year matches legacy (year one, pre-compounding)', () => {
    const y = g.firstYear
    expect(y.year).toBe(2026)
    expect(y.tax).toBe(30452.385887082044)
    expect(y.magi).toBe(167707.67584712929)
    expect(y.medicarePremiums).toBe(2434.8)
    expect(y.rothConversion).toBe(126745.28136849403)
    expect(y.withdrawals.taxable).toBe(122887.18343590572)
    expect(y.withdrawals.total).toBe(122887.18343590572)
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
    expect(y.withdrawals.roth).toBe(0)
    expect(y.withdrawals.total).toBe(0)
    expect(y.shortfall).toBe(96227.3809970545)
  })

  it('totalTax and totalConversions', () => {
    expect(g.totalTax).toBe(248916.78354709756)
    expect(g.totalConversions).toBe(620061.0887504726)
  })

  it('monte carlo (pathCount 300, seed 7) — lower success under real inflation', () => {
    expect(g.mc.successRate).toBe(0.32)
    expect(g.mc.requiredFloorSuccessRate).toBe(0.32)
  })

  it('batch objectives (base policy, then no-conversion policy)', () => {
    expect(g.batch.results.map((r) => r.objective)).toEqual([
      0, 31600.027693781307,
    ])
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
    expect(s!.lifetimeTaxesAndPenalties).toBe(449374.109909662)
    expect(s!.lifetimeRothConversions).toBe(1465223.7879358295)
    expect(s!.endingInvestable).toBe(3258662.956607575)
    expect(s!.endingNetWorth).toBe(3258662.956607575)
    expect(s!.endingAfterTaxEstate).toBe(3258662.956607575)
    expect(s!.endingEstateHeirTax).toBe(0)
    expect(s!.endingEstateToCharity).toBe(0)
    expect(s!.endingByCategory.cash).toBe(0)
    expect(s!.endingByCategory.taxable).toBe(429441.7945980932)
    expect(s!.endingByCategory.traditional).toBe(0)
    expect(s!.endingByCategory.roth).toBe(2829221.162009482)
    expect(s!.endingByCategory.hsa).toBe(0)
    expect(s!.depletionYear).toBeNull()
    expect(s!.fiNumber).toBe(6931783.7683923105)
    expect(s!.coastFireNumber).toBe(6931783.7683923105)
  })

  it('first projection year matches legacy (year one, pre-compounding)', () => {
    const y = g.firstYear
    expect(y.year).toBe(2026)
    expect(y.tax).toBe(144836.55073569246)
    expect(y.magi).toBe(582352.2935296915)
    expect(y.medicarePremiums).toBe(2434.8)
    expect(y.rothConversion).toBe(419400)
    expect(y.withdrawals.total).toBe(259271.35021844722)
  })

  it('last projection year (inflation-grown Medicare)', () => {
    const y = g.lastYear
    expect(y.year).toBe(2055)
    expect(y.tax).toBe(978.2955747547762)
    expect(y.penalties).toBe(0)
    expect(y.magi).toBe(87258.9125895717)
    expect(y.medicarePremiums).toBe(23004.59639238729)
    expect(y.irmaaTier).toBe(0)
    expect(y.rothConversion).toBe(0)
    expect(y.withdrawals.taxable).toBe(17410.100298930305)
    expect(y.withdrawals.roth).toBe(112535.9641080237)
    expect(y.withdrawals.total).toBe(129946.06440695401)
    expect(y.shortfall).toBe(0)
  })

  it('totalTax and totalConversions', () => {
    expect(g.totalTax).toBe(449374.109909662)
    expect(g.totalConversions).toBe(1465223.7879358295)
  })

  it('monte carlo (pathCount 300, seed 7)', () => {
    expect(g.mc.successRate).toBe(0.8266666666666667)
    expect(g.mc.requiredFloorSuccessRate).toBe(0.8266666666666667)
  })

  it('batch objectives (base policy, then no-conversion policy)', () => {
    expect(g.batch.results.map((r) => r.objective)).toEqual([
      3258662.956607575, 2929503.5432079323,
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
