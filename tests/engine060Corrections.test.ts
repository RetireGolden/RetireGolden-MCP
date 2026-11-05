/**
 * Four engine 0.6.0 corrections, taken through the tool layer with a full plan
 * document: `build_plan({ plan })` then `run_projection`. The typed `household`
 * path reaches none of them (it refuses wages and writes no HSA, QCD or IRA
 * basis evidence), and the
 * goldens and the protocol baseline are retired Kentucky plans, so without this
 * suite nothing here would notice the corrections going unreachable.
 *
 * Each plan starts from the typed single fixture's shape, exported and then
 * edited, with every account's return set to 0 so a balance moves only by the
 * year's flows, and a one-year horizon (2026).
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import * as adapter from '../src/adapter.js'
import { createSession, type SessionState } from '../src/session.js'
import { TOOL_TABLE } from '../src/toolTable.js'
import type { HouseholdParams } from '../src/buildPlan.js'

type Json = Record<string, unknown>

/** Call a tool's handler with arguments parsed by its own input shape, as tools/call does. */
function callTool(session: SessionState, name: string, args: Json): unknown {
  const entry = TOOL_TABLE.find((t) => t.name === name)
  if (!entry) throw new Error(`no tool ${name}`)
  return entry.handler(session, z.object(entry.inputShape).parse(args) as Json)
}

/** A one-year, zero-return plan document for one person, from the typed path. */
function basePlan(state: string, birthYear: number): Json {
  const household: HouseholdParams = {
    filing: 'single',
    state,
    persons: [{ birth_year: birthYear, trad: 800_000, roth: 100_000, pia: 2500, fra_years: 67 }],
    taxable: 200_000,
    taxable_basis: 150_000,
    spending: 60_000,
    horizon: 1,
    growth: { trad: 0, roth: 0, taxable: 0 },
    pre_horizon_magi: [50_000, 52_000],
    heir_ordinary_rate: 0.24,
  }
  const s = createSession(2026)
  const built = adapter.setPlanFromBuild(s, {
    household,
    policy: { claim_ages: [70], conversion_bracket: null, conversion_years: 0, ordering: 'taxable-first' },
    startYear: 2026,
  })
  if (!built.ok) throw new Error(built.issues.join('; '))
  const exported = adapter.exportPlan(s)
  if (!exported.ok) throw new Error('export failed')
  return structuredClone(exported.plan) as unknown as Json
}

interface Projection {
  ok: true
  summary: { endingByCategory: { traditional: number }; warnings: string[] }
  years: { tax: number; withdrawals: { traditional: number; total: number } }[]
}

function project(plan: Json): Projection {
  const session = createSession(2026)
  const built = callTool(session, 'build_plan', { plan, startYear: 2026 }) as { ok: boolean; issues?: string[] }
  expect(built.ok, (built.issues ?? []).join('; ')).toBe(true)
  const proj = callTool(session, 'run_projection', { detail: 'years' }) as Projection
  expect(proj.ok).toBe(true)
  return proj
}

/**
 * A 66-year-old single Texas filer with `wages` of pay and the traditional
 * account turned into an employer plan deferring $24,500 (the 2026 IRC 402(g)
 * limit, Notice 2025-67) under a 100% match of deferrals up to 6% of pay.
 */
function matchPlan(wages: number, matchPct: number): Json {
  const plan = basePlan('TX', 1960)
  const incomes = plan.incomes as Json[]
  incomes.push({ type: 'wages', id: 'wages-1', personId: 'person-0', annualGross: wages, endAge: 70, realGrowthPct: 0 })
  const trad = (plan.accounts as Json[]).find((a) => a.type === 'traditional')!
  Object.assign(trad, {
    kind: 'employer',
    annualContribution: 24_500,
    employerMatch: { matchPct, capPctOfPay: 6 },
  })
  return plan
}

/** The employer match the year credited: the matched plan minus its no-match twin. */
function creditedMatch(wages: number): { match: number; endingTraditional: number } {
  const matched = project(matchPlan(wages, 100))
  const unmatched = project(matchPlan(wages, 0))
  // Nothing leaves the account in the year, so its ending balance is the
  // opening $800,000 plus the year's deferral and match.
  expect(matched.years[0]!.withdrawals.traditional).toBe(0)
  expect(unmatched.years[0]!.withdrawals.traditional).toBe(0)
  return {
    match: matched.summary.endingByCategory.traditional - unmatched.summary.endingByCategory.traditional,
    endingTraditional: matched.summary.endingByCategory.traditional,
  }
}

describe('engine 0.6.0: employer match on wages held to the IRC 401(a)(17) limit', () => {
  it('caps a $500,000 earner\'s match at 6% of the $360,000 limit', () => {
    // IRC 401(a)(17): a qualified plan may take into account at most the
    // year's compensation limit, $360,000 for 2026 (Notice 2025-67; the
    // engine's irc-401-a-17-plan-compensation-cap). The match is 100% of
    // deferrals up to 6% of that compensation:
    //   min($24,500 deferred, 6% x min($500,000, $360,000)) = min(24,500, 21,600)
    //   = $21,600 (engine 0.5.0 measured 6% of $500,000 and matched all $24,500).
    const { match, endingTraditional } = creditedMatch(500_000)
    expect(match).toBe(21_600)
    // $800,000 opening + $24,500 deferral + $21,600 match, at a 0% return.
    expect(endingTraditional).toBe(846_100)
  })

  it('leaves the match on pay under the limit uncapped', () => {
    // $300,000 is under the $360,000 limit, so the cap is 6% of all of it:
    //   min($24,500, 6% x $300,000) = min(24,500, 18,000) = $18,000.
    const { match, endingTraditional } = creditedMatch(300_000)
    expect(match).toBe(18_000)
    expect(endingTraditional).toBe(842_500)
  })
})

describe('engine 0.6.0: unmatched custodian QCD evidence is withheld, not priced', () => {
  it('names a custodian QCD row with no executed distribution in summary.warnings', () => {
    // RetireGolden#813: a custodian row with no runtime distribution is not an
    // IRC 408(d)(8)(A) transfer, so the state QCD collection stays incomplete
    // and the projection names the row. The plan runs no QCD
    // (strategies.qcdAnnual is 0) and asserts one New Jersey custodian row.
    const plan = basePlan('NJ', 1950)
    const trad = (plan.accounts as Json[]).find((a) => a.type === 'traditional')!
    ;(plan.stateTaxFacts as Json).qcdEventEvidence = [
      {
        eventId: 'custodian-qcd-1',
        taxYear: 2026,
        accountId: trad.id,
        ownerPersonId: trad.ownerPersonId,
        transactionKind: 'directQcd',
        grossIraDistribution: 5000,
        directCharityTransfer: 5000,
        federalExcludedAmount: 5000,
        federalTaxableAmount: 0,
        federalBasisAllocated: 0,
        residency: 'fullYearResident',
        directTransfer: true,
        provenance: { source: 'custodian 1099-R', asOf: '2027-01-31' },
      },
    ]
    const warnings = project(plan).summary.warnings
    const named = warnings.filter(
      (w) => w.includes('custodian-qcd-1') && w.includes(String(trad.id)) && w.includes('2026'),
    )
    expect(named).toHaveLength(1)
    expect(named[0]).toMatch(/no executed distribution/)
    expect(named[0]).toMatch(/incomplete/)
  })
})

/**
 * A 60-year-old single California filer with $150,000 of wages and an HSA that
 * models no contribution (`annualContribution: 0`), whose 2026 evidence row
 * asserts `federalHsaDeduction` and states every other category as a known 0.
 */
function californiaHsaPlan(federalHsaDeduction: number): Json {
  const plan = basePlan('CA', 1966)
  ;(plan.incomes as Json[]).push({ type: 'wages', id: 'wages-1', personId: 'person-0', annualGross: 150_000, endAge: 70, realGrowthPct: 0 })
  ;(plan.accounts as Json[]).push({ type: 'hsa', id: 'hsa-1', name: 'HSA', ownerPersonId: 'person-0', annualReturnPct: 0, balance: 1000, annualContribution: 0 })
  ;(plan.stateTaxFacts as Json).hsaYearEvidence = [
    {
      taxYear: 2026,
      state: 'CA',
      accountId: 'hsa-1',
      ownerPersonId: 'person-0',
      federalHsaDeduction,
      employerContributionExcludedFederally: 0,
      employerContributionAlreadyInStateWages: 0,
      interest: 0,
      dividends: 0,
      realizedGains: 0,
      unrealizedAppreciation: 0,
      qualifiedCashWithdrawals: 0,
      nonqualifiedDistributionFederalAmount: 0,
      nonqualifiedCashWithdrawals: 0,
      stateBasisBeforeYear: 0,
      annualActivityComplete: true,
      provenance: { source: 'plan-evidence', asOf: '2026-01-15' },
    },
  ]
  return plan
}

describe('engine 0.6.0: an asserted HSA deduction is not replaced by a runtime zero', () => {
  it('adds a $4,300 asserted federal HSA deduction back to California income', () => {
    // California does not conform to IRC 223: Schedule CA adds back the federal
    // HSA deduction (FTB 2025 Schedule CA instructions; R&TC 17201(d); the
    // engine's ca-hsa-state-basis-nonconformity and CA.md "HSA nonconformity").
    // RetireGolden#812: the projection passes a federal deduction of 0 for an HSA
    // whose contribution it did not model, and that default no longer replaces
    // an asserted one. Engine 0.5.0 let it, so the addition was $0.
    //
    // Wages cover the year's spending and tax (no withdrawal), so the federal
    // side is the same in both plans and the tax difference is California's.
    // California taxable income is $150,000 - $5,706 standard deduction =
    // $144,294 without the addition and $148,594 with it, both inside the
    // single 9.3% band ($72,724 to $371,479, FTB 2025 Schedule X), so:
    //   9.3% x $4,300 = $399.90 more California tax.
    const asserted = project(californiaHsaPlan(4300))
    const none = project(californiaHsaPlan(0))
    expect(asserted.years[0]!.withdrawals.total).toBe(0)
    expect(none.years[0]!.withdrawals.total).toBe(0)
    expect(asserted.years[0]!.tax - none.years[0]!.tax).toBeCloseTo(399.9, 2)
    expect(asserted.summary.warnings).toEqual([])
  })
})

/**
 * A 76-year-old single New Jersey filer with $200,000 of wages, two traditional
 * IRAs of $100,000 each at a 0% return, and a $20,000 QCD, with one Worksheet C
 * basis row per IRA and no unrecovered basis. Only IRA A may assert
 * exempt-obligation earnings.
 */
function newJerseyPoolPlan(iraAExemptObligation: number | undefined): Json {
  const plan = basePlan('NJ', 1950)
  ;(plan.incomes as Json[]).push({ type: 'wages', id: 'wages-1', personId: 'person-0', annualGross: 200_000, endAge: 80, realGrowthPct: 0 })
  const accounts = plan.accounts as Json[]
  const iraA = accounts.find((a) => a.type === 'traditional')!
  iraA.balance = 100_000
  accounts.push({ ...structuredClone(iraA), id: 'ira-b', name: 'Trad1' })
  ;(plan.strategies as Json).qcdAnnual = 20_000
  // Worksheet C works on the owner's IRAs together. At a 0% return the owner's
  // year-end value is $200,000 - $20,000 = $180,000 and the year's
  // distributions are the $20,000 transfer, so each row states half of each.
  const row = (accountId: unknown, extra: Json) => ({
    taxYear: 2026,
    state: 'NJ',
    ownerPersonId: iraA.ownerPersonId,
    accountId,
    unrecoveredStateBasis: 0,
    annualDistributionsComplete: true,
    yearEndAccountValue: 90_000,
    distributionsDuringYear: 10_000,
    postYearContributionsThroughFilingDeadline: 0,
    ...extra,
    provenance: { source: 'NJ Worksheet C annual account statement', asOf: '2026-12-31' },
  })
  ;(plan.stateTaxFacts as Json).iraBasisYearEvidence = [
    row(iraA.id, iraAExemptObligation === undefined ? {} : { exemptObligationAdjustment: iraAExemptObligation }),
    row('ira-b', {}),
  ]
  return plan
}

describe('engine 0.6.0: a New Jersey IRA owner pool keeps a partial exempt-obligation amount', () => {
  it('taxes $19,500 of a $20,000 QCD when one of two IRAs asserts $5,000 of exempt earnings', () => {
    // New Jersey has no QCD exclusion; the taxable part of the transfer is set
    // by GIT-1 & 2 Worksheet C (January 2026; the engine's
    // nj-direct-qcd-ira-basis-treatment). Line 3 = $180,000 year-end value +
    // $20,000 distributed = $200,000; basis $0; IRA A's $5,000 of
    // exempt-obligation earnings is excludable, IRA B states none. Taxable
    // ratio (200,000 - 5,000) / 200,000 = 0.975, so the QCD adds $19,500 to
    // New Jersey income, not $20,000. RetireGolden#814: engine 0.5.0 kept the
    // amount only when every row stated one, so it dropped IRA A's $5,000.
    //
    // New Jersey gross income is over $150,000, so no pension exclusion
    // applies (N.J.S.A. 54A:6-10), and $200,000 of wages plus the transfer sits
    // in the single 6.37% band ($75,000 to $500,000, N.J.S.A. 54A:2-1). The
    // federal side excludes the QCD in both plans, so:
    //   6.37% x ($20,000 - $19,500) = $31.85 less New Jersey tax.
    const partial = project(newJerseyPoolPlan(5000))
    const none = project(newJerseyPoolPlan(undefined))
    expect(partial.years[0]!.tax - none.years[0]!.tax).toBeCloseTo(-31.85, 2)
    expect(partial.summary.warnings).toEqual([])
    expect(none.summary.warnings).toEqual([])
  })
})
