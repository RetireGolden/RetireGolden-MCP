/**
 * Two engine 0.6.0 corrections, taken through the tool layer with a full plan
 * document: `build_plan({ plan })` then `run_projection`. The typed `household`
 * path reaches neither (it refuses wages and writes no QCD evidence), and the
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
  years: { withdrawals: { traditional: number } }[]
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
