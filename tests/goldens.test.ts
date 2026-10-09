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
 * entity facts — observation-only; no projection-behavior change). Verified
 * UNCHANGED again under engine 0.2.0 (plan schema v5; the one-time-income
 * election cannot reach these fixtures) and under engine 0.3.0 (two additive
 * `YearResult` fields and a smaller export map; no projection-behavior change
 * for these fixtures — the protocol baseline's engine-numeric steps were
 * byte-identical across both bumps).
 *
 * Regenerated for engine 0.4.0. These fixtures were replayed on every engine
 * commit from 0.3.0 to 0.4.0, and every moved literal traces to one of three
 * engine changes, or to the FI basis this package now asks for (CHANGELOG
 * 0.11.0 has the figures):
 *  - Kentucky (engine #710, which the engine CHANGELOG records from 0.4.1): the
 *    $31,110 retirement exclusion now applies to each owner's own IRA
 *    distributions, Roth conversions included, where engine 0.3.0 applied the
 *    household's combined cap to traditional withdrawals only; and the standard
 *    deduction is $3,360 once per joint return, not $6,720.
 *    The single fixtures pay $1,102.46 less KY tax in 2026 (3.5% of the
 *    $31,110 excluded and of the $388.79 less gain sold to pay); in the MFJ
 *    fixtures the halved deduction adds $117.60 a year (3.5% of $3,360).
 *  - Medicare IRMAA from CMS's published table (engine #770): 4 or 8 cents a
 *    month a person at four of the five tiers, so cents to tens of dollars here.
 *  - The FI number (engine #765, with the conversion-free run this package now
 *    passes `summarizeProjection`, as the app does): a Roth conversion's one-off
 *    tax is no longer priced as FI spending, which moves `fiNumber` and
 *    `coastFireNumber` on all four fixtures by far the most.
 * Monte Carlo success moves only on the single new-defaults fixture (0.32 to
 * 0.33, from the Kentucky change).
 *
 * Verified UNCHANGED under engine 0.4.1 (state income tax corrections in
 * Virginia, Kansas, Maine, Pennsylvania, South Carolina, Michigan, New York,
 * Connecticut and New Jersey; these fixtures are Kentucky plans, and Kentucky
 * does not change): the goldens pass without regeneration.
 *
 * Verified UNCHANGED under engine 0.4.3, which contains 0.4.2 (state military
 * retirement, Utah's credits, New Jersey's personal exemptions, pooled
 * spousal-election RMDs, and part-year pricing of a year split between states,
 * Kentucky's part-year cap included): these fixtures are full-year Kentucky
 * plans with an untagged pension, no state move and no inherited IRA, so none
 * of those reaches them, and `pnpm run goldens:print` prints every literal
 * below unchanged.
 *
 * Generation recipe — `pnpm run goldens:print` (scripts/gen-goldens.mjs) prints
 * these literals from a fresh build; it never edits this file:
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
import { builtOk } from './fixtures.js'

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
    expect(s!.lifetimeTaxesAndPenalties).toBe(246942.47617152243)
    expect(s!.lifetimeRothConversions).toBe(658146.6108525584)
    expect(s!.endingInvestable).toBe(685126.9476692764)
    expect(s!.endingNetWorth).toBe(685126.9476692764)
    expect(s!.endingAfterTaxEstate).toBe(685126.9476692764)
    expect(s!.endingEstateHeirTax).toBe(0)
    expect(s!.endingEstateToCharity).toBe(0)
    expect(s!.endingByCategory.cash).toBe(0)
    expect(s!.endingByCategory.taxable).toBe(0)
    expect(s!.endingByCategory.traditional).toBe(0)
    expect(s!.endingByCategory.roth).toBe(685126.9476692764)
    expect(s!.endingByCategory.hsa).toBe(0)
    expect(s!.depletionYear).toBeNull()
    expect(s!.averagePreRetirementSavingsRatePct).toBe(0)
    expect(s!.fiNumber).toBe(2335173.6926357476)
    expect(s!.coastFireNumber).toBe(2335173.6926357476)
  })

  it('first projection year', () => {
    const y = g.firstYear
    expect(y.year).toBe(2026)
    expect(y.tax).toBe(29286.01083127988)
    expect(y.penalties).toBe(0)
    expect(y.magi).toBe(167318.88419315655)
    expect(y.medicarePremiums).toBe(2434.8)
    expect(y.irmaaTier).toBe(0)
    expect(y.rothConversion).toBe(126745.28136849403)
    expect(y.withdrawals.cash).toBe(0)
    expect(y.withdrawals.taxable).toBe(121720.80847398753)
    expect(y.withdrawals.traditional).toBe(0)
    expect(y.withdrawals.roth).toBe(0)
    expect(y.withdrawals.hsa).toBe(0)
    expect(y.withdrawals.total).toBe(121720.80847398753)
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
    expect(g.totalTax).toBe(246942.47617152243)
    expect(g.totalConversions).toBe(658146.6108525584)
  })

  it('monte carlo (pathCount 300, seed 7)', () => {
    expect(g.mc.successRate).toBe(0.6733333333333333)
    expect(g.mc.requiredFloorSuccessRate).toBe(0.6733333333333333)
  })

  it('batch objectives (base policy, then no-conversion policy)', () => {
    expect(g.batch.results.map((r) => r.objective)).toEqual([
      685126.9476692764, 833828.4656568047,
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
    expect(s!.lifetimeTaxesAndPenalties).toBe(447275.41652856366)
    expect(s!.lifetimeRothConversions).toBe(1465384.4101757968)
    expect(s!.endingInvestable).toBe(5223715.316928832)
    expect(s!.endingNetWorth).toBe(5223715.316928832)
    expect(s!.endingAfterTaxEstate).toBe(5223715.316928832)
    expect(s!.endingEstateHeirTax).toBe(0)
    expect(s!.endingEstateToCharity).toBe(0)
    expect(s!.endingByCategory.cash).toBe(0)
    expect(s!.endingByCategory.taxable).toBe(688555.4888558467)
    expect(s!.endingByCategory.traditional).toBe(0)
    expect(s!.endingByCategory.roth).toBe(4535159.828072986)
    expect(s!.endingByCategory.hsa).toBe(0)
    expect(s!.depletionYear).toBeNull()
    expect(s!.averagePreRetirementSavingsRatePct).toBe(0)
    expect(s!.fiNumber).toBe(3527917.0011233026)
    expect(s!.coastFireNumber).toBe(3527917.0011233026)
  })

  it('first projection year', () => {
    const y = g.firstYear
    expect(y.year).toBe(2026)
    expect(y.tax).toBe(144984.4825407516)
    expect(y.penalties).toBe(0)
    expect(y.magi).toBe(582435.0006429022)
    expect(y.medicarePremiums).toBe(2434.8)
    expect(y.irmaaTier).toBe(0)
    expect(y.rothConversion).toBe(419400)
    expect(y.withdrawals.cash).toBe(0)
    expect(y.withdrawals.taxable).toBe(54499.84993345193)
    expect(y.withdrawals.traditional).toBe(128685.0456628667)
    expect(y.withdrawals.roth).toBe(76234.39008691256)
    expect(y.withdrawals.hsa).toBe(0)
    expect(y.withdrawals.total).toBe(259419.2856832312)
    expect(y.shortfall).toBe(0)
  })

  it('last projection year', () => {
    const y = g.lastYear
    expect(y.year).toBe(2055)
    expect(y.tax).toBe(703.412444520821)
    expect(y.penalties).toBe(0)
    expect(y.magi).toBe(40662.791853029325)
    expect(y.medicarePremiums).toBe(4869.6)
    expect(y.irmaaTier).toBe(0)
    expect(y.rothConversion).toBe(0)
    expect(y.withdrawals.cash).toBe(0)
    expect(y.withdrawals.taxable).toBe(6452.378771098813)
    expect(y.withdrawals.traditional).toBe(0)
    expect(y.withdrawals.roth).toBe(41696.63232594861)
    expect(y.withdrawals.hsa).toBe(0)
    expect(y.withdrawals.total).toBe(48149.01109704742)
    expect(y.shortfall).toBeCloseTo(0, 6)
  })

  it('totalTax and totalConversions', () => {
    expect(g.totalTax).toBe(447275.41652856366)
    expect(g.totalConversions).toBe(1465384.4101757968)
  })

  it('monte carlo (pathCount 300, seed 7)', () => {
    expect(g.mc.successRate).toBe(0.9766666666666667)
    expect(g.mc.requiredFloorSuccessRate).toBe(0.9766666666666667)
  })

  it('batch objectives (base policy, then no-conversion policy)', () => {
    expect(g.batch.results.map((r) => r.objective)).toEqual([
      5223715.316928832, 4491786.426559193,
    ])
  })
})

// ===========================================================================
// NEW-DEFAULT goldens (WS1.3): the SAME two fixtures built with NO `assumptions`
// block, so the engine's createEmptyPlan defaults flow through — ~2.5% inflation,
// SS COLA tracking inflation, +3% healthcare inflation, 5.5% fallback return.
// Fresh literals generated on this branch (scripts/gen-goldens.mjs). These
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
    expect(s!.lifetimeTaxesAndPenalties).toBe(247155.9751336773)
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
    expect(s!.fiNumber).toBe(2335173.6926357476)
    expect(s!.coastFireNumber).toBe(2335173.6926357476)
  })

  it('first projection year matches legacy (year one, pre-compounding)', () => {
    const y = g.firstYear
    expect(y.year).toBe(2026)
    expect(y.tax).toBe(29286.01083127988)
    expect(y.magi).toBe(167318.88419315655)
    expect(y.medicarePremiums).toBe(2434.8)
    expect(y.rothConversion).toBe(126745.28136849403)
    expect(y.withdrawals.taxable).toBe(121720.80847398753)
    expect(y.withdrawals.total).toBe(121720.80847398753)
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
    expect(g.totalTax).toBe(247155.9751336773)
    expect(g.totalConversions).toBe(620061.0887504726)
  })

  it('monte carlo (pathCount 300, seed 7) — lower success under real inflation', () => {
    expect(g.mc.successRate).toBe(0.33)
    expect(g.mc.requiredFloorSuccessRate).toBe(0.33)
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
    expect(s!.lifetimeTaxesAndPenalties).toBe(449300.6066136307)
    expect(s!.lifetimeRothConversions).toBe(1465235.6550229397)
    expect(s!.endingInvestable).toBe(3265770.7778632487)
    expect(s!.endingNetWorth).toBe(3265770.7778632487)
    expect(s!.endingAfterTaxEstate).toBe(3265770.7778632487)
    expect(s!.endingEstateHeirTax).toBe(0)
    expect(s!.endingEstateToCharity).toBe(0)
    expect(s!.endingByCategory.cash).toBe(0)
    expect(s!.endingByCategory.taxable).toBe(430378.238848911)
    expect(s!.endingByCategory.traditional).toBe(0)
    expect(s!.endingByCategory.roth).toBe(2835392.5390143376)
    expect(s!.endingByCategory.hsa).toBe(0)
    expect(s!.depletionYear).toBeNull()
    expect(s!.fiNumber).toBe(3527917.0011233026)
    expect(s!.coastFireNumber).toBe(3527917.0011233026)
  })

  it('first projection year matches legacy (year one, pre-compounding)', () => {
    const y = g.firstYear
    expect(y.year).toBe(2026)
    expect(y.tax).toBe(144984.4825407516)
    expect(y.magi).toBe(582435.0006429022)
    expect(y.medicarePremiums).toBe(2434.8)
    expect(y.rothConversion).toBe(419400)
    expect(y.withdrawals.total).toBe(259419.2856832312)
  })

  it('last projection year (inflation-grown Medicare)', () => {
    const y = g.lastYear
    expect(y.year).toBe(2055)
    expect(y.tax).toBe(1097.3794407285868)
    expect(y.penalties).toBe(0)
    expect(y.magi).toBe(87281.78885666795)
    expect(y.medicarePremiums).toBe(23004.59639238729)
    expect(y.irmaaTier).toBe(0)
    expect(y.rothConversion).toBe(0)
    expect(y.withdrawals.taxable).toBe(17426.044654926674)
    expect(y.withdrawals.roth).toBe(112639.10339003305)
    expect(y.withdrawals.total).toBe(130065.14804495973)
    expect(y.shortfall).toBe(0)
  })

  it('totalTax and totalConversions', () => {
    expect(g.totalTax).toBe(449300.6066136307)
    expect(g.totalConversions).toBe(1465235.6550229397)
  })

  it('monte carlo (pathCount 300, seed 7)', () => {
    expect(g.mc.successRate).toBe(0.8266666666666667)
    expect(g.mc.requiredFloorSuccessRate).toBe(0.8266666666666667)
  })

  it('batch objectives (base policy, then no-conversion policy)', () => {
    expect(g.batch.results.map((r) => r.objective)).toEqual([
      3265770.7778632487, 2900010.70305771,
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
    const a = builtOk(build).plan.assumptions
    expect(a.inflationPct).toBe(2.5)
    expect(a.healthcareExtraInflationPct).toBe(3)
    expect(a.defaultReturnPct).toBe(5.5)
    expect(a.ssCola).toEqual({ mode: 'matchInflation' })
    // Tax rates the engine defaults to zero stay zero (not overridden away).
    expect(a.stateEffectiveTaxPct).toBe(0)
    expect(a.localIncomeTaxPct).toBe(0)
  })
})
