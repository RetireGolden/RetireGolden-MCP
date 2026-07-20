/**
 * WS2.5 GOLDEN-NUMBER TESTS — the numeric contract with the engine/adapter.
 *
 * These goldens are exact baseline outputs captured from unmodified `main` for
 * two fixture households (RetireBench conventions baked in: 0% inflation, state
 * KY, zero state tax, June-15 dobs, sex 'average', qualifiedRatio 0.85). They
 * exist to catch engine/adapter NUMERIC DRIFT. Refresh them DELIBERATELY on an
 * engine bump — never casually to make a red test go green.
 *
 * They also PROVE the WS1.1 byte-identical constraint for this phase: making
 * every RetireBench convention overridable must not change any default. A build
 * with no new fields must reproduce these numbers exactly. If a golden fails and
 * the engine version has not changed, a feature agent altered a default — that
 * is a BLOCKING regression, not a golden to adjust.
 *
 * Generation recipe (scratchpad/baseline-goldens.mjs, unmodified main):
 *   session = createSession()
 *   setPlanFromBuild(session, input)
 *   proj  = runProjection(session)                    // per-year ledger => detail:'years'
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
import type { HouseholdParams, PolicyParams } from '../src/buildPlan.js'

// --- Fixture SINGLE ---------------------------------------------------------
const singleHousehold: HouseholdParams = {
  filing: 'single',
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
function runFixture(household: HouseholdParams, policy: PolicyParams) {
  const session = createSession()
  const build = adapter.setPlanFromBuild(session, { household, policy, startYear: 2026 })
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

describe('golden numbers — SINGLE fixture', () => {
  const g = runFixture(singleHousehold, singlePolicy)

  it('projection window', () => {
    expect(g.proj.startYear).toBe(2026)
    expect(g.proj.endYear).toBe(2050)
    expect(g.years).toHaveLength(25)
  })

  it('projection summary headline numbers', () => {
    const s = g.proj.ok ? g.proj.summary : null
    expect(s).toBeTruthy()
    expect(s!.lifetimeTaxesAndPenalties).toBe(213039.20240565354)
    expect(s!.lifetimeRothConversions).toBe(680957.0281863213)
    expect(s!.endingInvestable).toBe(784178.8266268241)
    expect(s!.endingNetWorth).toBe(784178.8266268241)
    expect(s!.endingAfterTaxEstate).toBe(784178.8266268241)
    expect(s!.endingEstateHeirTax).toBe(0)
    expect(s!.endingEstateToCharity).toBe(0)
    expect(s!.endingByCategory.cash).toBe(0)
    expect(s!.endingByCategory.taxable).toBe(0)
    expect(s!.endingByCategory.traditional).toBe(0)
    expect(s!.endingByCategory.roth).toBe(784178.8266268241)
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
    expect(y.magi).toBe(165679.1223707383)
    expect(y.medicarePremiums).toBe(2434.8)
    expect(y.irmaaTier).toBe(0)
    expect(y.rothConversion).toBe(126745.28136849403)
    expect(y.withdrawals.cash).toBe(0)
    expect(y.withdrawals.taxable).toBe(116801.52300673284)
    expect(y.withdrawals.traditional).toBe(0)
    expect(y.withdrawals.roth).toBe(0)
    expect(y.withdrawals.hsa).toBe(0)
    expect(y.withdrawals.total).toBe(116801.52300673284)
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
    expect(g.totalTax).toBe(213039.20240565354)
    expect(g.totalConversions).toBe(680957.0281863213)
  })

  it('monte carlo (pathCount 300, seed 7)', () => {
    expect(g.mc.successRate).toBe(0.7233333333333334)
    expect(g.mc.requiredFloorSuccessRate).toBe(0.7233333333333334)
  })

  it('batch objectives (base policy, then no-conversion policy)', () => {
    expect(g.batch.results.map((r) => r.objective)).toEqual([
      784178.8266268241, 886946.7398806778,
    ])
  })
})

describe('golden numbers — MFJ fixture', () => {
  const g = runFixture(mfjHousehold, mfjPolicy)

  it('projection window', () => {
    expect(g.proj.startYear).toBe(2026)
    expect(g.proj.endYear).toBe(2055)
    expect(g.years).toHaveLength(30)
  })

  it('projection summary headline numbers', () => {
    const s = g.proj.ok ? g.proj.summary : null
    expect(s).toBeTruthy()
    expect(s!.lifetimeTaxesAndPenalties).toBe(372986.8785584255)
    expect(s!.lifetimeRothConversions).toBe(1483986.6765781217)
    expect(s!.endingInvestable).toBe(5542575.604402265)
    expect(s!.endingNetWorth).toBe(5542575.604402265)
    expect(s!.endingAfterTaxEstate).toBe(5542575.604402265)
    expect(s!.endingEstateHeirTax).toBe(0)
    expect(s!.endingEstateToCharity).toBe(0)
    expect(s!.endingByCategory.cash).toBe(0)
    expect(s!.endingByCategory.taxable).toBe(730646.1202639437)
    expect(s!.endingByCategory.traditional).toBe(0)
    expect(s!.endingByCategory.roth).toBe(4811929.484138321)
    expect(s!.endingByCategory.hsa).toBe(0)
    expect(s!.depletionYear).toBeNull()
    expect(s!.averagePreRetirementSavingsRatePct).toBe(0)
    expect(s!.fiNumber).toBe(6380254.690436714)
    expect(s!.coastFireNumber).toBe(6380254.690436714)
  })

  it('first projection year', () => {
    const y = g.firstYear
    expect(y.year).toBe(2026)
    expect(y.tax).toBe(122775.38761746862)
    expect(y.penalties).toBe(0)
    expect(y.magi).toBe(570018.4348949179)
    expect(y.medicarePremiums).toBe(2434.8)
    expect(y.irmaaTier).toBe(0)
    expect(y.rothConversion).toBe(419399.9997228384)
    expect(y.withdrawals.cash).toBe(0)
    expect(y.withdrawals.taxable).toBe(49834.07302887996)
    expect(y.withdrawals.traditional).toBe(117668.21326341553)
    expect(y.withdrawals.roth).toBe(69707.90132517311)
    expect(y.withdrawals.hsa).toBe(0)
    expect(y.withdrawals.total).toBe(237210.1876174686)
    expect(y.shortfall).toBe(1.4551915228366852e-11)
  })

  it('last projection year', () => {
    const y = g.lastYear
    expect(y.year).toBe(2055)
    expect(y.tax).toBe(9.77590467099226)
    expect(y.penalties).toBe(0)
    expect(y.magi).toBe(40530.1816000284)
    expect(y.medicarePremiums).toBe(4869.6)
    expect(y.irmaaTier).toBe(0)
    expect(y.rothConversion).toBe(0)
    expect(y.withdrawals.cash).toBe(0)
    expect(y.withdrawals.taxable).toBe(6359.9517560740405)
    expect(y.withdrawals.traditional).toBe(0)
    expect(y.withdrawals.roth).toBe(41095.42414859696)
    expect(y.withdrawals.hsa).toBe(0)
    expect(y.withdrawals.total).toBe(47455.375904671004)
    expect(y.shortfall).toBe(1.8189894035458565e-12)
  })

  it('totalTax and totalConversions', () => {
    expect(g.totalTax).toBe(372986.8785584255)
    expect(g.totalConversions).toBe(1483986.6765781217)
  })

  it('monte carlo (pathCount 300, seed 7)', () => {
    expect(g.mc.successRate).toBe(0.9933333333333333)
    expect(g.mc.requiredFloorSuccessRate).toBe(0.9933333333333333)
  })

  it('batch objectives (base policy, then no-conversion policy)', () => {
    expect(g.batch.results.map((r) => r.objective)).toEqual([
      5542575.604402265, 4604197.017339909,
    ])
  })
})
