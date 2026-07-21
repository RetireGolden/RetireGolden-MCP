import { describe, expect, it } from 'vitest'
import { buildPlanFromParams } from '../src/buildPlan.js'
import { getTool, validateToolArgs } from '../src/toolTable.js'
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

  it('pushes a caveat listing typed fields ignored because plan JSON takes precedence', () => {
    const built = buildPlanFromParams({ household: mfjHousehold, policy: mfjPolicy, startYear: 2026 })
    const planJson = JSON.parse(JSON.stringify(built.plan))
    const res = buildPlanFromParams({
      plan: planJson,
      household: mfjHousehold,
      assumptions: { inflationPct: 2.5 },
    })
    expect(res.ok).toBe(true)
    const caveat = res.caveats.find((c) => c.includes('full plan JSON was supplied'))
    expect(caveat).toBeTruthy()
    expect(caveat).toContain('assumptions')
    expect(caveat).toContain('household')
    // policy/conversion were not supplied here, so they must not be named.
    expect(caveat).not.toContain('policy')
    expect(caveat).not.toContain('conversion')
  })

  it('accepts mixed-mode plan JSON alongside a household missing state (household ignored)', () => {
    // Regression: household.state is required only on the typed path. When full plan
    // JSON is supplied it takes precedence and the household is ignored, so a
    // stateless household must NOT block the build.
    const built = buildPlanFromParams({ household: mfjHousehold, policy: mfjPolicy, startYear: 2026 })
    const planJson = JSON.parse(JSON.stringify(built.plan))
    const { state: _dropped, ...noStateHousehold } = mfjHousehold
    const res = buildPlanFromParams({
      plan: planJson,
      household: noStateHousehold as typeof mfjHousehold,
      policy: mfjPolicy,
    })
    expect(res.ok).toBe(true)
    expect(res.issues).toBeUndefined()
    expect(res.caveats.some((c) => c.includes('full plan JSON was supplied'))).toBe(true)
  })

  it('accepts mixed-mode plan JSON alongside a household with a MALFORMED state (household ignored)', () => {
    // Regression: schema-level state-format validation would reject this before the
    // full-plan precedence rule runs. State format is validated only on the typed
    // path, so a bad `state` on an ignored household must not block a valid plan.
    const built = buildPlanFromParams({ household: mfjHousehold, policy: mfjPolicy, startYear: 2026 })
    const planJson = JSON.parse(JSON.stringify(built.plan))
    const res = buildPlanFromParams({
      plan: planJson,
      household: { ...mfjHousehold, state: 'California' }, // malformed, but ignored
      policy: mfjPolicy,
    })
    expect(res.ok).toBe(true)
    expect(res.issues).toBeUndefined()
  })

  it('plan JSON alone produces no ignored-fields caveat', () => {
    const built = buildPlanFromParams({ household: mfjHousehold, policy: mfjPolicy, startYear: 2026 })
    const planJson = JSON.parse(JSON.stringify(built.plan))
    const res = buildPlanFromParams({ plan: planJson })
    expect(res.ok).toBe(true)
    expect(res.caveats.some((c) => c.includes('full plan JSON was supplied'))).toBe(false)
  })

  it('rejects a full plan when a convention makes its MAGI history invalid', () => {
    const built = buildPlanFromParams({ household: mfjHousehold, policy: mfjPolicy })
    const planJson = JSON.parse(JSON.stringify(built.plan))
    const res = buildPlanFromParams({
      plan: planJson,
      conventions: { irmaaLookbackMagis: [100_000, -1] },
    })

    expect(res.ok).toBe(false)
    expect(res.plan).toBeUndefined()
    expect(res.issues?.some((issue) => issue.includes('historicalAnnualMagiByYear'))).toBe(true)
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

  it('rejects a typed build with no household.state (WS1.3: state is required)', () => {
    const { state: _dropped, ...noState } = singleHousehold
    const res = buildPlanFromParams({
      household: noState as typeof singleHousehold,
      policy: singlePolicy,
    })
    expect(res.ok).toBe(false)
    expect(res.plan).toBeUndefined()
    expect(res.issues).toHaveLength(1)
    expect(res.issues![0]).toContain('household.state is required')
    expect(res.issues![0]).toContain('2-letter')
  })

  it('rejects an invalid (non-2-letter) household.state as malformed, not missing', () => {
    const res = buildPlanFromParams({
      household: { ...singleHousehold, state: 'California' },
      policy: singlePolicy,
    })
    expect(res.ok).toBe(false)
    // A malformed value must not read as "required/missing" (that invites re-adding
    // the same bad value); it names the format problem and echoes the bad value.
    expect(res.issues![0]).toContain('household.state must be a 2-letter code')
    expect(res.issues![0]).toContain('California')
    expect(res.issues![0]).not.toContain('is required')
  })

  it('rejects a malformed assumptions.state override before it reaches the engine', () => {
    const res = buildPlanFromParams({
      household: singleHousehold, // valid household.state
      policy: singlePolicy,
      assumptions: { state: '9!' },
    })
    expect(res.ok).toBe(false)
    expect(res.issues![0]).toContain('assumptions.state must be a 2-letter code')
    expect(res.issues![0]).toContain('9!')
  })

  it('rejects a non-zero wage as a hard error (WS1.3: wages are not modeled)', () => {
    const res = buildPlanFromParams({
      household: {
        ...singleHousehold,
        persons: [{ ...singleHousehold.persons[0]!, wage: 40_000 }],
      },
      policy: singlePolicy,
    })
    expect(res.ok).toBe(false)
    expect(res.plan).toBeUndefined()
    expect(res.issues).toEqual(['person 0: wages are not modeled; remove wage or use full plan JSON'])
  })

  it('allows an explicit zero wage (no wage is being modeled)', () => {
    const res = buildPlanFromParams({
      household: {
        ...singleHousehold,
        persons: [{ ...singleHousehold.persons[0]!, wage: 0 }],
      },
      policy: singlePolicy,
    })
    expect(res.ok).toBe(true)
  })
})

describe('build_plan gateway arg validation (state format deferred to typed path)', () => {
  const entry = getTool('build_plan')!

  it('accepts a valid plan alongside a malformed-state household (mixed-mode)', () => {
    // Both transports run validateToolArgs before the handler. A schema-level state
    // format rule would reject this even though full plan JSON takes precedence.
    const err = validateToolArgs(entry, {
      plan: { anything: true },
      household: { ...mfjHousehold, state: 'California' },
      policy: mfjPolicy,
    })
    expect(err).toBeNull()
  })

  it('rejects a typed-path build (no plan) whose household state is missing', () => {
    const { state: _dropped, ...noState } = singleHousehold
    const err = validateToolArgs(entry, { household: noState, policy: singlePolicy })
    expect(err).toContain('household.state is required on the typed path')
  })

  it('rejects a typed-path build (no plan) whose household state is malformed', () => {
    const err = validateToolArgs(entry, {
      household: { ...singleHousehold, state: 'California' },
      policy: singlePolicy,
    })
    expect(err).toContain('household.state is required on the typed path')
  })
})

describe('buildPlanFromParams — conventions and caveats', () => {
  it('maps distinct MAGIs to the exact IRMAA lookback years', () => {
    const res = buildPlanFromParams({
      household: mfjHousehold, // pre_horizon_magi [80000, 82000], distinct
      policy: mfjPolicy,
      startYear: 2030,
    })
    expect(res.ok).toBe(true)
    expect(res.plan!.assumptions.historicalAnnualMagiByYear).toEqual({
      '2028': 80_000,
      '2029': 82_000,
    })
    expect(res.plan!.assumptions.recentAnnualMagi).toBe(80_000)
    expect(res.caveats.some((c) => c.startsWith('IRMAA-lookback'))).toBe(false)
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

  it('maps a convention irmaaLookbackMagis pair without a lossy caveat', () => {
    const res = buildPlanFromParams({
      household: singleHousehold,
      policy: singlePolicy,
      conventions: { irmaaLookbackMagis: [111_000, 222_000] },
    })
    expect(res.ok).toBe(true)
    expect(res.plan!.assumptions.recentAnnualMagi).toBe(111_000)
    expect(res.plan!.assumptions.historicalAnnualMagiByYear).toEqual({
      '2024': 111_000,
      '2025': 222_000,
    })
    expect(res.caveats.some((c) => c.includes('convention irmaaLookbackMagis='))).toBe(false)
  })
})
