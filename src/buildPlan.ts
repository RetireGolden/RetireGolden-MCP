/**
 * Build a RetireGolden Plan from typed household/policy params (bench vocabulary)
 * or accept a full plan JSON object.
 */

import { z } from 'zod'
import type { Plan } from '@retiregolden/engine'
import { createEmptyPlan, parsePlan } from '@retiregolden/engine/model/plan'
import type { ConventionKnobs } from './session.js'

export const PersonParamsSchema = z.object({
  birth_year: z.number().int().min(1900).max(2100).describe('4-digit birth year, e.g. 1960'),
  trad: z.number().min(0).describe('Traditional/pre-tax IRA+401k balance in dollars'),
  roth: z.number().min(0).describe('Roth balance in dollars'),
  pia: z.number().min(0).describe('Social Security primary insurance amount, monthly dollars at FRA'),
  pension: z.number().min(0).optional().describe('Annual pension income in dollars (ordinary-taxed)'),
  wage: z
    .number()
    .min(0)
    .optional()
    .describe(
      'Annual wage — NOT modeled. A non-zero wage is a hard build error (retired household is the explicit contract of the typed path); remove it or use the full plan JSON path.',
    ),
  fra_years: z.number().min(0).max(120).optional().describe('Full retirement age in years'),
})
export type PersonParams = z.infer<typeof PersonParamsSchema>

export const HouseholdParamsSchema = z.object({
  filing: z.enum(['single', 'mfj']).describe('Tax filing status: single or married-filing-jointly'),
  // Deliberately no format constraint (no `.length(2)`) at the Zod layer: both
  // transports parse HouseholdParamsSchema before buildPlanFromParams runs, so any
  // schema-level rule here would reject mixed-mode `build_plan({ plan, household })`
  // even though full plan JSON takes precedence and the household is ignored. Both
  // presence AND 2-letter format are enforced on the typed path in
  // buildPlanFromParams, and mirrored in the gateway crossFieldValidate when no
  // `plan` is supplied.
  state: z
    .string()
    .optional()
    .describe(
      '2-letter state-of-residence code — REQUIRED on the typed path (omitting or malforming it fails the build when no full `plan` is supplied), e.g. "CA". The engine requires a residence state — there is no hardcoded default. `assumptions.state` can override the value used. NOTE: naming a state does NOT by itself model that state\'s income tax; set `assumptions.stateEffectiveTaxPct` for that.',
    ),
  persons: z.array(PersonParamsSchema).min(1).describe('One entry per household member'),
  taxable: z.number().min(0).describe('Taxable brokerage balance in dollars'),
  taxable_basis: z.number().min(0).describe('Cost basis of the taxable brokerage account in dollars'),
  spending: z.number().min(0).describe('Base annual household spending in dollars'),
  horizon: z.number().int().min(1).max(100).describe('Number of projection years (1-100)'),
  growth: z
    .object({
      trad: z.number().describe('Traditional NOMINAL annual return as a fraction, e.g. 0.05'),
      roth: z.number().describe('Roth NOMINAL annual return as a fraction, e.g. 0.05'),
      taxable: z.number().describe('Taxable NOMINAL annual return as a fraction, e.g. 0.05'),
    })
    .describe(
      'Per-bucket NOMINAL annual return rates (fractions, not percents). These are written straight into the engine\'s nominal annualReturnPct — real return is roughly this minus inflationPct. Use nominal figures (e.g. 0.05 for a 5% headline return), not inflation-adjusted ones.',
    ),
  pre_horizon_magi: z
    .tuple([z.number(), z.number()])
    .optional()
    .describe('IRMAA lookback MAGIs for [startYear-2, startYear-1]'),
  heir_ordinary_rate: z.number().min(0).max(1).describe('Heir ordinary income tax rate as a fraction'),
})
export type HouseholdParams = z.infer<typeof HouseholdParamsSchema>

export const PolicyParamsSchema = z.object({
  claim_ages: z
    .array(z.number().int().min(0).max(120))
    .min(1)
    .describe('Social Security claim age per person (whole years), aligned to household.persons order'),
  conversion_bracket: z
    .number()
    .min(0)
    .max(1)
    .nullable()
    .optional()
    .describe('Top-of-bracket target for Roth conversions as a fraction (e.g. 0.24), or null'),
  conversion_years: z
    .number()
    .int()
    .min(0)
    .max(100)
    .nullable()
    .optional()
    .describe('Number of years to run fill-to-bracket conversions from startYear, or null'),
  ordering: z
    .enum(['taxable-first', 'traditional-first', 'proportional'])
    .describe('Withdrawal ordering; traditional-first is approximate under sequential drain'),
})
export type PolicyParams = z.infer<typeof PolicyParamsSchema>

/** Max day per month (1-indexed); February allows 29 (leap-year check left to the engine). */
const MAX_DAY_BY_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const

/** True when `MM-DD` names a real calendar month-day (month 01-12, day within that month, 02-29 allowed). */
function isValidMonthDay(v: string): boolean {
  const [mmStr, ddStr] = v.split('-')
  const mm = Number(mmStr)
  const dd = Number(ddStr)
  if (!Number.isInteger(mm) || !Number.isInteger(dd)) return false
  if (mm < 1 || mm > 12) return false
  const max = MAX_DAY_BY_MONTH[mm - 1]!
  return dd >= 1 && dd <= max
}

export const AssumptionsSchema = z
  .object({
    inflationPct: z
      .number()
      .optional()
      .describe('General price inflation, in percent per year (e.g. 2.5 for 2.5%)'),
    healthcareExtraInflationPct: z
      .number()
      .optional()
      .describe('Healthcare inflation above general inflation, in percent per year (e.g. 2 for +2%)'),
    defaultReturnPct: z
      .number()
      .optional()
      .describe('Fallback nominal annual return for accounts without an explicit rate, in percent'),
    ssColaPct: z
      .number()
      .optional()
      .describe('Social Security COLA as a fixed annual percent (e.g. 2.5 for 2.5%/yr)'),
    // No `.length(2)` here either: assumptions are also ignored under full-plan
    // precedence, so schema-level format validation would break the same mixed-mode
    // flow. Format is enforced on the typed path in buildPlanFromParams.
    state: z
      .string()
      .nullable()
      .optional()
      .describe('2-letter state-of-residence OVERRIDE (e.g. "CA"); when omitted or null, the required household.state is used. NOTE: setting state alone does NOT model that state\'s income tax — state tax stays 0% unless you also set stateEffectiveTaxPct'),
    stateEffectiveTaxPct: z
      .number()
      .optional()
      .describe('Flat effective state income tax rate, in percent'),
    localIncomeTaxPct: z
      .number()
      .optional()
      .describe('Flat local income tax rate, in percent'),
    qualifiedRatio: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe('Fraction (0-1) of taxable-account dividends taxed at qualified rates. Default 0.85 (a reasonable neutral value, overridable) — not a bench artifact.'),
    dobMonthDay: z
      .string()
      .regex(/^\d{2}-\d{2}$/, 'dobMonthDay must be "MM-DD" with a zero-padded two-digit month and day')
      .refine((v) => isValidMonthDay(v), {
        message:
          'dobMonthDay must be a real calendar date: month 01-12 and day within that month (02-29 allowed; 13-40, 00-00, 02-31 rejected)',
      })
      .optional()
      .describe(
        'Birth month-day as "MM-DD", combined with each person birth_year (e.g. "06-15"). Default "06-15" (a reasonable neutral value, overridable) — not a bench artifact. Calendar-validated (month 01-12, day within that month; 02-29 allowed). Leap-year interaction with each person birth_year is left to the engine.',
      ),
    sex: z
      .enum(['female', 'male', 'average'])
      .optional()
      .describe("Person sex for mortality/longevity: female, male, or average (percent-free enum). Default 'average' (a reasonable neutral value, overridable) — not a bench artifact."),
  })
  .describe("Optional overrides for the typed-path modeling assumptions. Defaults now follow the ENGINE's own defaults: ~2.5%/yr inflation, +3%/yr healthcare inflation above general, 5.5% fallback return, SS COLA tracking inflation, 0% state/local income tax. Household state is a REQUIRED input (household.state), not an assumption. Set explicit values to override; omitted fields keep the engine defaults.")
export type AssumptionsInput = z.infer<typeof AssumptionsSchema>

export const ConversionSchema = z
  .object({
    mode: z.literal('manual'),
    conversions: z.array(z.object({ year: z.number().int(), amount: z.number().min(0) })),
  })
  .describe('Manual Roth conversion schedule: explicit dollar amounts per year')
export type ConversionInput = z.infer<typeof ConversionSchema>

export interface BuildPlanInput {
  /** Full engine plan JSON (takes precedence when both supplied). */
  plan?: unknown
  household?: HouseholdParams
  policy?: PolicyParams
  conversion?: ConversionInput
  startYear?: number
  conventions?: ConventionKnobs
  assumptions?: AssumptionsInput
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
    // Mixed-mode is allowed for compatibility, but full plan JSON takes precedence:
    // any typed household/policy/conversion/assumptions supplied alongside it are
    // ignored. Surface exactly which, so the caller is not silently surprised.
    // (conventions are NOT listed here — applyConventions below still honors them.)
    const ignored: string[] = []
    if (input.household != null) ignored.push('household')
    if (input.policy != null) ignored.push('policy')
    if (input.conversion != null) ignored.push('conversion')
    if (input.assumptions != null) ignored.push('assumptions')
    if (ignored.length > 0) {
      caveats.push(
        `${ignored.join(', ')} ignored: full plan JSON was supplied and takes precedence`,
      )
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

  const hh = input.household
  const policy = input.policy

  if (hh.horizon < 1) {
    return { ok: false, startYear, caveats, issues: ['horizon must be >= 1'] }
  }
  if (hh.persons.length === 0) {
    return { ok: false, startYear, caveats, issues: ['household.persons must not be empty'] }
  }
  if (policy.claim_ages.length < hh.persons.length) {
    return {
      ok: false,
      startYear,
      caveats,
      issues: ['policy.claim_ages must have an entry for each person'],
    }
  }
  // state is a required household input on the typed path — the engine needs a
  // residence state and there is no longer a hardcoded KY default. assumptions.state
  // can override the value used, but household.state must still be provided.
  const STATE_CODE = /^[A-Za-z]{2}$/
  if (hh.state == null || hh.state === '') {
    return {
      ok: false,
      startYear,
      caveats,
      issues: [
        'household.state is required: provide a 2-letter state-of-residence code (e.g. "CA"); assumptions.state can override the value used',
      ],
    }
  }
  if (!STATE_CODE.test(hh.state)) {
    return {
      ok: false,
      startYear,
      caveats,
      issues: [`household.state must be a 2-letter code (A–Z), got "${hh.state}"`],
    }
  }
  // assumptions.state overrides household.state, so validate it here too rather than
  // letting a bad override surface only later as an opaque parsePlan failure.
  if (input.assumptions?.state != null && !STATE_CODE.test(input.assumptions.state)) {
    return {
      ok: false,
      startYear,
      caveats,
      issues: [`assumptions.state must be a 2-letter code (A–Z), got "${input.assumptions.state}"`],
    }
  }
  // Wages are not modeled by the typed path — a retired household is the explicit
  // contract here (previously a silent caveat; now a hard error).
  const wageIdx = hh.persons.findIndex((p) => (p.wage ?? 0) !== 0)
  if (wageIdx >= 0) {
    return {
      ok: false,
      startYear,
      caveats,
      issues: [
        `person ${wageIdx}: wages are not modeled; remove wage or use full plan JSON`,
      ],
    }
  }

  try {
    return buildTypedPlan(input, hh, policy, startYear, conventions, caveats)
  } catch (e) {
    return { ok: false, startYear, caveats, issues: [e instanceof Error ? e.message : String(e)] }
  }
}

function buildTypedPlan(
  input: BuildPlanInput,
  hh: HouseholdParams,
  policy: PolicyParams,
  startYear: number,
  conventions: ConventionKnobs,
  caveats: string[],
): BuildPlanResult {
  let n = 0
  const newId = () => `id-${++n}`
  const now = () => new Date('2026-01-01T00:00:00.000Z')

  const endYear = startYear + hh.horizon - 1
  const filing = FILING[hh.filing]
  if (!filing) {
    return { ok: false, startYear, caveats, issues: [`unknown filing ${hh.filing}`] }
  }

  const asmpt = input.assumptions

  const plan = createEmptyPlan({ newId, now, name: 'mcp-session' })
  plan.household.filingStatus = filing
  // Household state is a required input (validated in buildPlanFromParams).
  // assumptions.state, when provided, overrides the value used; null/absent keeps
  // the household's own state.
  const effectiveState = (asmpt?.state ?? hh.state)!
  plan.household.state = effectiveState
  // Footgun: naming a state does NOT switch on that state's income tax. Unless the
  // caller sets a flat stateEffectiveTaxPct, state tax stays modeled at 0%. This now
  // fires for the primary happy path too (household.state is always present on the
  // typed path), not just the assumptions.state override, unless the caller has
  // explicitly set stateEffectiveTaxPct (even to 0, an acknowledged 0% state tax).
  if (asmpt?.stateEffectiveTaxPct == null) {
    caveats.push(
      `state=${effectiveState} set but stateEffectiveTaxPct is not — state income tax is modeled at 0%; set stateEffectiveTaxPct to model it`,
    )
  }

  const dobMonthDay = asmpt?.dobMonthDay ?? '06-15'
  const sex = asmpt?.sex ?? 'average'
  // Footgun: sex / dobMonthDay are single scalars — they apply to EVERY person, so a
  // multi-person household cannot give members distinct values via the typed path.
  if ((asmpt?.sex != null || asmpt?.dobMonthDay != null) && hh.persons.length > 1) {
    const which = [
      asmpt?.sex != null ? 'sex' : null,
      asmpt?.dobMonthDay != null ? 'dobMonthDay' : null,
    ]
      .filter(Boolean)
      .join(' and ')
    caveats.push(
      `assumptions.${which} applies to every person in this ${hh.persons.length}-person household (the typed path has no per-person override)`,
    )
  }
  plan.household.people = hh.persons.map((p, i) => {
    return {
      id: `person-${i}`,
      name: `P${i}`,
      dob: `${p.birth_year}-${dobMonthDay}`,
      sex,
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
    qualifiedRatio: asmpt?.qualifiedRatio ?? 0.85,
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

  // Modeling assumptions: let the engine's createEmptyPlan defaults through
  // (inflationPct 2.5, healthcareExtraInflationPct 3, defaultReturnPct 5.5,
  // ssCola { mode: 'matchInflation' }, state/local tax 0) unless the caller
  // overrides a field explicitly. Only heirTaxRatePct is always set, from the
  // required household.heir_ordinary_rate.
  const a = plan.assumptions
  if (asmpt?.inflationPct != null) a.inflationPct = asmpt.inflationPct
  if (asmpt?.healthcareExtraInflationPct != null) {
    a.healthcareExtraInflationPct = asmpt.healthcareExtraInflationPct
  }
  if (asmpt?.defaultReturnPct != null) a.defaultReturnPct = asmpt.defaultReturnPct
  if (asmpt?.ssColaPct != null) a.ssCola = { mode: 'fixed', annualPct: asmpt.ssColaPct }
  if (asmpt?.stateEffectiveTaxPct != null) a.stateEffectiveTaxPct = asmpt.stateEffectiveTaxPct
  if (asmpt?.localIncomeTaxPct != null) a.localIncomeTaxPct = asmpt.localIncomeTaxPct
  a.heirTaxRatePct = hh.heir_ordinary_rate * 100

  const pre = conventions.irmaaLookbackMagis ?? hh.pre_horizon_magi ?? ([0, 0] as [number, number])
  a.recentAnnualMagi = pre[0] ?? 0
  if (pre.length >= 2 && pre[0] !== pre[1]) {
    caveats.push(
      `IRMAA-lookback: engine uses one scalar recentAnnualMagi=${pre[0]} for both pre-horizon years; distinct MAGIs ${startYear - 2}=${pre[0]}, ${startYear - 1}=${pre[1]} may diverge`,
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
