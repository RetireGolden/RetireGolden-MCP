import { describe, expect, it } from 'vitest'
import { buildPlanFromParams } from '../src/buildPlan.js'
import { mfjHousehold, mfjPolicy, singleHousehold, singlePolicy } from './fixtures.js'

describe('buildPlanFromParams — typed household branch', () => {
  it('builds an MFJ two-person household with a pension', () => {
    const res = buildPlanFromParams({ household: mfjHousehold, policy: mfjPolicy, startYear: 2026 })
    expect(res.ok).toBe(true)
    expect(res.plan).toBeTruthy()
    const plan = res.plan!
    expect(res.startYear).toBe(2026)
    expect(res.endYear).toBe(2040) // 2026 + 15 - 1
    expect(plan.household.filingStatus).toBe('marriedFilingJointly')
    expect(plan.household.people).toHaveLength(2)
    // one traditional + one roth per person, plus a single brokerage account
    expect(plan.accounts).toHaveLength(5)
    expect(plan.accounts.filter((a) => a.type === 'traditional')).toHaveLength(2)
    expect(plan.accounts.filter((a) => a.type === 'roth')).toHaveLength(2)
    expect(plan.accounts.filter((a) => a.type === 'taxable')).toHaveLength(1)
    // pension mapped to a single recurring ordinary income
    const pensions = plan.incomes.filter((i) => i.type === 'recurring')
    expect(pensions).toHaveLength(1)
    expect((pensions[0] as { annualAmount: number }).annualAmount).toBe(24_000)
    // two social-security streams, one per person
    expect(plan.incomes.filter((i) => i.type === 'socialSecurity')).toHaveLength(2)
    expect(plan.expenses.baseAnnual).toBe(90_000)
  })

  it('does not emit a pension income when no person has a pension', () => {
    const res = buildPlanFromParams({ household: singleHousehold, policy: singlePolicy })
    expect(res.ok).toBe(true)
    expect(res.plan!.incomes.filter((i) => i.type === 'recurring')).toHaveLength(0)
  })
})

describe('buildPlanFromParams — withdrawal ordering modes', () => {
  it('taxable-first maps to sequential drain, not flagged unsupported', () => {
    const res = buildPlanFromParams({
      household: singleHousehold,
      policy: { ...singlePolicy, ordering: 'taxable-first' },
    })
    expect(res.ok).toBe(true)
    expect(res.plan!.strategies.withdrawalOrder).toEqual({ mode: 'sequential' })
    expect(res.ordering_unsupported).toBe(false)
  })

  it('proportional maps to proportional drain', () => {
    const res = buildPlanFromParams({
      household: singleHousehold,
      policy: { ...singlePolicy, ordering: 'proportional' },
    })
    expect(res.ok).toBe(true)
    expect(res.plan!.strategies.withdrawalOrder).toEqual({ mode: 'proportional' })
    expect(res.ordering_unsupported).toBe(false)
  })

  it('traditional-first falls back to sequential and flags ordering_unsupported with a caveat', () => {
    const res = buildPlanFromParams({
      household: singleHousehold,
      policy: { ...singlePolicy, ordering: 'traditional-first' },
    })
    expect(res.ok).toBe(true)
    expect(res.plan!.strategies.withdrawalOrder).toEqual({ mode: 'sequential' })
    expect(res.ordering_unsupported).toBe(true)
    expect(res.caveats.some((c) => c.includes('ordering=traditional-first'))).toBe(true)
  })
})

describe('buildPlanFromParams — full plan JSON branch', () => {
  it('accepts a validated engine plan JSON round-tripped through the typed builder', () => {
    const built = buildPlanFromParams({ household: mfjHousehold, policy: mfjPolicy, startYear: 2026 })
    expect(built.ok).toBe(true)
    const planJson = JSON.parse(JSON.stringify(built.plan))
    const res = buildPlanFromParams({ plan: planJson })
    expect(res.ok).toBe(true)
    expect(res.plan).toBeTruthy()
    expect(res.issues).toBeUndefined()
  })

  it('rejects malformed plan JSON with issues', () => {
    const res = buildPlanFromParams({ plan: { not: 'a plan' } })
    expect(res.ok).toBe(false)
    expect(res.issues).toBeTruthy()
    expect(res.issues!.length).toBeGreaterThan(0)
  })

  it('requires either plan JSON or both household and policy', () => {
    const res = buildPlanFromParams({ startYear: 2026 })
    expect(res.ok).toBe(false)
    expect(res.issues).toEqual(['Provide either `plan` JSON or both `household` and `policy`'])
  })
})

describe('buildPlanFromParams — validation guards', () => {
  it('rejects horizon < 1', () => {
    const res = buildPlanFromParams({
      household: { ...singleHousehold, horizon: 0 },
      policy: singlePolicy,
    })
    expect(res.ok).toBe(false)
    expect(res.issues).toEqual(['horizon must be >= 1'])
    expect(res.plan).toBeUndefined()
  })

  it('rejects an empty persons array', () => {
    const res = buildPlanFromParams({
      household: { ...singleHousehold, persons: [] },
      policy: singlePolicy,
    })
    expect(res.ok).toBe(false)
    expect(res.issues).toEqual(['household.persons must not be empty'])
  })

  it('rejects claim_ages shorter than persons', () => {
    const res = buildPlanFromParams({
      household: mfjHousehold, // two persons
      policy: { ...mfjPolicy, claim_ages: [67] }, // only one
    })
    expect(res.ok).toBe(false)
    expect(res.issues).toEqual(['policy.claim_ages must have an entry for each person'])
  })
})

describe('buildPlanFromParams — conventions and caveats', () => {
  it('interpolates the real IRMAA lookback years for a non-2026 startYear', () => {
    const res = buildPlanFromParams({
      household: mfjHousehold, // pre_horizon_magi [80000, 82000], distinct
      policy: mfjPolicy,
      startYear: 2030,
    })
    expect(res.ok).toBe(true)
    const caveat = res.caveats.find((c) => c.startsWith('IRMAA-lookback'))
    expect(caveat).toBeTruthy()
    // startYear-2 = 2028, startYear-1 = 2029
    expect(caveat).toContain('2028=80000')
    expect(caveat).toContain('2029=82000')
  })

  it('applies a withdrawalOrdering convention that overrides policy.ordering', () => {
    const res = buildPlanFromParams({
      household: singleHousehold,
      policy: { ...singlePolicy, ordering: 'taxable-first' },
      conventions: { withdrawalOrdering: 'proportional' },
    })
    expect(res.ok).toBe(true)
    expect(res.plan!.strategies.withdrawalOrder).toEqual({ mode: 'proportional' })
  })

  it('records a caveat for a traditional-first withdrawalOrdering convention', () => {
    const res = buildPlanFromParams({
      household: singleHousehold,
      policy: { ...singlePolicy, ordering: 'taxable-first' },
      conventions: { withdrawalOrdering: 'traditional-first' },
    })
    expect(res.ok).toBe(true)
    expect(res.plan!.strategies.withdrawalOrder).toEqual({ mode: 'sequential' })
    expect(
      res.caveats.some((c) => c.includes('convention withdrawalOrdering=traditional-first')),
    ).toBe(true)
  })

  it('records a lawSunsetFreezeYear caveat', () => {
    const res = buildPlanFromParams({
      household: singleHousehold,
      policy: singlePolicy,
      startYear: 2030,
      conventions: { lawSunsetFreezeYear: 2031 },
    })
    expect(res.ok).toBe(true)
    expect(res.caveats.some((c) => c.includes('lawSunsetFreezeYear=2031'))).toBe(true)
  })

  it('records a convention irmaaLookbackMagis caveat when the two MAGIs differ', () => {
    const res = buildPlanFromParams({
      household: singleHousehold,
      policy: singlePolicy,
      conventions: { irmaaLookbackMagis: [111_000, 222_000] },
    })
    expect(res.ok).toBe(true)
    expect(res.plan!.assumptions.recentAnnualMagi).toBe(111_000)
    expect(
      res.caveats.some((c) => c.includes('convention irmaaLookbackMagis=[111000,222000]')),
    ).toBe(true)
  })
})
