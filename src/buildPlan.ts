/**
 * Build a RetireGolden Plan from typed household/policy params (bench vocabulary)
 * or accept a full plan JSON object.
 */

import type { Plan } from '@retiregolden/engine'
import { createEmptyPlan, parsePlan } from '@retiregolden/engine/model/plan'
import type { ConventionKnobs } from './session.js'

export interface PersonParams {
  birth_year: number
  trad: number
  roth: number
  pia: number
  pension?: number
  wage?: number
  fra_years?: number
}

export interface HouseholdParams {
  filing: 'single' | 'mfj'
  persons: PersonParams[]
  taxable: number
  taxable_basis: number
  spending: number
  horizon: number
  growth: { trad: number; roth: number; taxable: number }
  pre_horizon_magi?: [number, number]
  heir_ordinary_rate: number
}

export interface PolicyParams {
  claim_ages: number[]
  conversion_bracket?: number | null
  conversion_years?: number | null
  ordering: 'taxable-first' | 'traditional-first' | 'proportional'
}

export interface BuildPlanInput {
  /** Full engine plan JSON (takes precedence when both supplied). */
  plan?: unknown
  household?: HouseholdParams
  policy?: PolicyParams
  conversion?: { mode: 'manual'; conversions: { year: number; amount: number }[] }
  startYear?: number
  conventions?: ConventionKnobs
}

export interface BuildPlanResult {
  ok: boolean
  plan?: Plan
  startYear: number
  endYear?: number
  caveats: string[]
  issues?: string[]
  ordering_unsupported?: boolean
}

const FILING = { single: 'single', mfj: 'marriedFilingJointly' } as const

export function buildPlanFromParams(input: BuildPlanInput): BuildPlanResult {
  const caveats: string[] = []
  const startYear = input.startYear ?? 2026
  const conventions = input.conventions ?? {}

  if (input.plan != null) {
    const parsed = parsePlan(input.plan)
    if (!parsed.ok) {
      return { ok: false, startYear, caveats, issues: parsed.issues }
    }
    applyConventions(parsed.plan, conventions, caveats)
    return { ok: true, plan: parsed.plan, startYear, caveats }
  }

  if (!input.household || !input.policy) {
    return {
      ok: false,
      startYear,
      caveats,
      issues: ['Provide either `plan` JSON or both `household` and `policy`'],
    }
  }

  let n = 0
  const newId = () => `id-${++n}`
  const now = () => new Date('2026-01-01T00:00:00.000Z')

  const hh = input.household
  const policy = input.policy
  const endYear = startYear + hh.horizon - 1
  const filing = FILING[hh.filing]
  if (!filing) {
    return { ok: false, startYear, caveats, issues: [`unknown filing ${hh.filing}`] }
  }

  const plan = createEmptyPlan({ newId, now, name: 'mcp-session' })
  plan.household.filingStatus = filing
  plan.household.state = 'KY'

  plan.household.people = hh.persons.map((p, i) => {
    if ((p.wage ?? 0) !== 0) {
      caveats.push(
        `person ${i} has non-zero wage ${p.wage}; wages are not mapped (retired household assumed)`,
      )
    }
    return {
      id: `person-${i}`,
      name: `P${i}`,
      dob: `${p.birth_year}-06-15`,
      sex: 'average' as const,
      retirementAge: Math.max(1, startYear - p.birth_year - 1),
      longevity: { planningAge: endYear - p.birth_year, source: 'manual' as const },
    }
  })

  const growth = hh.growth
  const accounts: Plan['accounts'] = []
  hh.persons.forEach((p, i) => {
    accounts.push({
      type: 'traditional',
      id: newId(),
      name: `Trad${i}`,
      ownerPersonId: `person-${i}`,
      kind: 'ira',
      annualReturnPct: growth.trad * 100,
      balance: p.trad,
      annualContribution: 0,
    })
    accounts.push({
      type: 'roth',
      id: newId(),
      name: `Roth${i}`,
      ownerPersonId: `person-${i}`,
      kind: 'ira',
      annualReturnPct: growth.roth * 100,
      balance: p.roth,
      annualContribution: 0,
    })
  })
  accounts.push({
    type: 'taxable',
    id: newId(),
    name: 'Brokerage',
    ownerPersonId: null,
    annualReturnPct: growth.taxable * 100,
    balance: hh.taxable,
    costBasis: hh.taxable_basis,
    interestYieldPct: 0,
    dividendYieldPct: 0,
    qualifiedRatio: 0.85,
    reinvestDividends: true,
    annualContribution: 0,
  })
  plan.accounts = accounts

  const incomes: Plan['incomes'] = []
  hh.persons.forEach((p, i) => {
    if ((p.pension ?? 0) > 0) {
      incomes.push({
        type: 'recurring',
        id: newId(),
        label: `Pension${i}`,
        annualAmount: p.pension!,
        startYear: null,
        endYear: null,
        inflationAdjusted: false,
        taxTreatment: 'ordinary',
      })
    }
    incomes.push({
      type: 'socialSecurity',
      id: newId(),
      personId: `person-${i}`,
      piaMonthly: p.pia,
      earnings: null,
      claimAge: { years: policy.claim_ages[i]!, months: 0 },
    })
  })
  plan.incomes = incomes

  plan.expenses.baseAnnual = hh.spending
  plan.expenses.healthcare = {
    pre65MonthlyPremiumPerPerson: 0,
    applyAcaCredit: false,
    medicareExtrasMonthlyPerPerson: 0,
  }

  let ordering_unsupported = false
  const ordering = conventions.withdrawalOrdering ?? policy.ordering
  if (ordering === 'taxable-first') {
    plan.strategies.withdrawalOrder = { mode: 'sequential' }
  } else if (ordering === 'proportional') {
    plan.strategies.withdrawalOrder = { mode: 'proportional' }
  } else if (ordering === 'traditional-first') {
    plan.strategies.withdrawalOrder = { mode: 'sequential' }
    ordering_unsupported = true
    caveats.push(
      'ordering=traditional-first has no full engine equivalent (sequential drains taxable before traditional); ledger is approximate',
    )
  } else {
    return { ok: false, startYear, caveats, issues: [`unknown ordering ${ordering}`] }
  }
  plan.strategies.qcdAnnual = 0

  const conv = input.conversion
  const bracket = policy.conversion_bracket
  const kYears = policy.conversion_years ?? 0
  if (conv && conv.mode === 'manual') {
    plan.strategies.rothConversion = { mode: 'manual', conversions: conv.conversions ?? [] }
  } else if (bracket != null && kYears > 0) {
    plan.strategies.rothConversion = {
      mode: 'fillToTarget',
      target: 'topOfBracket',
      targetValue: bracket * 100,
      startYear,
      endYear: startYear + kYears - 1,
    }
  } else {
    plan.strategies.rothConversion = { mode: 'none' }
  }

  const a = plan.assumptions
  a.inflationPct = 0
  a.healthcareExtraInflationPct = 0
  a.defaultReturnPct = 0
  a.ssCola = { mode: 'fixed', annualPct: 0 }
  a.ssHaircut = null
  a.stateEffectiveTaxPct = 0
  a.localIncomeTaxPct = 0
  a.heirTaxRatePct = hh.heir_ordinary_rate * 100

  const pre = conventions.irmaaLookbackMagis ?? hh.pre_horizon_magi ?? ([0, 0] as [number, number])
  a.recentAnnualMagi = pre[0] ?? 0
  if (pre.length >= 2 && pre[0] !== pre[1]) {
    caveats.push(
      `IRMAA-lookback: engine uses one scalar recentAnnualMagi=${pre[0]} for both pre-horizon years; distinct MAGIs 2024=${pre[0]}, 2025=${pre[1]} may diverge`,
    )
  }

  if (conventions.lawSunsetFreezeYear != null) {
    caveats.push(
      `lawSunsetFreezeYear=${conventions.lawSunsetFreezeYear} requested; engine freeze toggle is best-effort — verify parameter packs for that year`,
    )
  }

  applyConventions(plan, conventions, caveats)

  const parsed = parsePlan(plan)
  if (!parsed.ok) {
    return { ok: false, startYear, caveats, issues: parsed.issues, ordering_unsupported }
  }

  return {
    ok: true,
    plan: parsed.plan,
    startYear,
    endYear,
    caveats,
    ordering_unsupported,
  }
}

function applyConventions(plan: Plan, conventions: ConventionKnobs, caveats: string[]): void {
  if (conventions.irmaaLookbackMagis) {
    const [a, b] = conventions.irmaaLookbackMagis
    plan.assumptions.recentAnnualMagi = a
    if (a !== b) {
      caveats.push(
        `convention irmaaLookbackMagis=[${a},${b}]: seeded recentAnnualMagi=${a} (engine single scalar)`,
      )
    }
  }
  if (conventions.withdrawalOrdering === 'proportional') {
    plan.strategies.withdrawalOrder = { mode: 'proportional' }
  } else if (conventions.withdrawalOrdering === 'taxable-first') {
    plan.strategies.withdrawalOrder = { mode: 'sequential' }
  } else if (conventions.withdrawalOrdering === 'traditional-first') {
    plan.strategies.withdrawalOrder = { mode: 'sequential' }
    caveats.push('convention withdrawalOrdering=traditional-first: approximate under sequential')
  }
}
