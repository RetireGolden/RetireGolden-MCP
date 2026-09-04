import { describe, expect, it } from 'vitest'
import { buildPlanFromParams } from '../src/buildPlan.js'
import { DEFAULT_START_YEAR } from '../src/session.js'
import { argsSchemaFor, getTool, validateToolArgs } from '../src/toolTable.js'
import {
  builtFailed,
  builtOk,
  mfjHousehold,
  mfjPolicy,
  singleHousehold,
  singlePolicy,
} from './fixtures.js'

describe('buildPlanFromParams — typed household branch', () => {
  it('builds an MFJ two-person household with a pension', () => {
    const res = buildPlanFromParams({ household: mfjHousehold, policy: mfjPolicy, startYear: 2026 })
    expect(res.ok).toBe(true)
    const plan = builtOk(res).plan
    expect(res.startYear).toBe(2026)
    expect(builtOk(res).endYear).toBe(2040) // 2026 + 15 - 1
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
    expect(builtOk(res).plan.incomes.filter((i) => i.type === 'recurring')).toHaveLength(0)
  })
})

describe('buildPlanFromParams — frozen build clock', () => {
  const frozen = `${DEFAULT_START_YEAR}-01-01T00:00:00.000Z`

  it('stamps createdAt/updatedAt from DEFAULT_START_YEAR, not the wall clock', () => {
    const res = buildPlanFromParams({ household: singleHousehold, policy: singlePolicy })
    expect(builtOk(res).plan.createdAtIso).toBe(frozen)
    expect(builtOk(res).plan.updatedAtIso).toBe(frozen)
  })

  it('keeps that stamp even when the caller names an explicit startYear', () => {
    // The coupling worth stating out loud: the frozen clock tracks
    // DEFAULT_START_YEAR, so a plan built for 2029 is still stamped for the
    // default year. That is deliberate — one literal instead of two — but it
    // means a future change to DEFAULT_START_YEAR moves the timestamps on
    // EVERY newly built plan, including ones that never used the default.
    // The protocol baseline replaces timestamps with a sentinel, so it would
    // not catch that; this test is what catches it.
    const res = buildPlanFromParams({
      household: singleHousehold,
      policy: singlePolicy,
      startYear: 2029,
    })
    expect(res.startYear).toBe(2029)
    expect(builtOk(res).plan.createdAtIso).toBe(frozen)
  })
})

describe('buildPlanFromParams — withdrawal ordering modes', () => {
  it('taxable-first maps to sequential drain, not flagged unsupported', () => {
    const res = buildPlanFromParams({
      household: singleHousehold,
      policy: { ...singlePolicy, ordering: 'taxable-first' },
    })
    expect(res.ok).toBe(true)
    expect(builtOk(res).plan.strategies.withdrawalOrder).toEqual({ mode: 'sequential' })
    expect(res.ordering_unsupported).toBe(false)
  })

  it('proportional maps to proportional drain', () => {
    const res = buildPlanFromParams({
      household: singleHousehold,
      policy: { ...singlePolicy, ordering: 'proportional' },
    })
    expect(res.ok).toBe(true)
    expect(builtOk(res).plan.strategies.withdrawalOrder).toEqual({ mode: 'proportional' })
    expect(res.ordering_unsupported).toBe(false)
  })

  it('traditional-first falls back to sequential and flags ordering_unsupported with a caveat', () => {
    const res = buildPlanFromParams({
      household: singleHousehold,
      policy: { ...singlePolicy, ordering: 'traditional-first' },
    })
    expect(res.ok).toBe(true)
    expect(builtOk(res).plan.strategies.withdrawalOrder).toEqual({ mode: 'sequential' })
    expect(res.ordering_unsupported).toBe(true)
    expect(
      res.caveats.some((c) => c.includes('traditional-first has no exact engine equivalent')),
    ).toBe(true)
  })
})

describe('buildPlanFromParams — full plan JSON branch', () => {
  it('accepts a validated engine plan JSON round-tripped through the typed builder', () => {
    const built = buildPlanFromParams({ household: mfjHousehold, policy: mfjPolicy, startYear: 2026 })
    expect(built.ok).toBe(true)
    const planJson = JSON.parse(JSON.stringify(builtOk(built).plan))
    const res = buildPlanFromParams({ plan: planJson })
    expect(res.ok).toBe(true)
    expect(builtOk(res).plan).toBeTruthy()
    expect('issues' in res).toBe(false)
  })

  it('rejects malformed plan JSON with issues', () => {
    const res = buildPlanFromParams({ plan: { not: 'a plan' } })
    expect(res.ok).toBe(false)
    expect(builtFailed(res).issues).toBeTruthy()
    expect(builtFailed(res).issues.length).toBeGreaterThan(0)
  })

  it('pushes a caveat listing typed fields ignored because plan JSON takes precedence', () => {
    const built = buildPlanFromParams({ household: mfjHousehold, policy: mfjPolicy, startYear: 2026 })
    const planJson = JSON.parse(JSON.stringify(builtOk(built).plan))
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
    const planJson = JSON.parse(JSON.stringify(builtOk(built).plan))
    const { state: _dropped, ...noStateHousehold } = mfjHousehold
    const res = buildPlanFromParams({
      plan: planJson,
      household: noStateHousehold as typeof mfjHousehold,
      policy: mfjPolicy,
    })
    expect(res.ok).toBe(true)
    expect('issues' in res).toBe(false)
    expect(res.caveats.some((c) => c.includes('full plan JSON was supplied'))).toBe(true)
  })

  it('accepts mixed-mode plan JSON alongside a household with a MALFORMED state (household ignored)', () => {
    // Regression: schema-level state-format validation would reject this before the
    // full-plan precedence rule runs. State format is validated only on the typed
    // path, so a bad `state` on an ignored household must not block a valid plan.
    const built = buildPlanFromParams({ household: mfjHousehold, policy: mfjPolicy, startYear: 2026 })
    const planJson = JSON.parse(JSON.stringify(builtOk(built).plan))
    const res = buildPlanFromParams({
      plan: planJson,
      household: { ...mfjHousehold, state: 'California' }, // malformed, but ignored
      policy: mfjPolicy,
    })
    expect(res.ok).toBe(true)
    expect('issues' in res).toBe(false)
  })

  it('plan JSON alone produces no ignored-fields caveat', () => {
    const built = buildPlanFromParams({ household: mfjHousehold, policy: mfjPolicy, startYear: 2026 })
    const planJson = JSON.parse(JSON.stringify(builtOk(built).plan))
    const res = buildPlanFromParams({ plan: planJson })
    expect(res.ok).toBe(true)
    expect(res.caveats.some((c) => c.includes('full plan JSON was supplied'))).toBe(false)
  })

  it('rejects a full plan when a convention makes its MAGI history invalid', () => {
    const built = buildPlanFromParams({ household: mfjHousehold, policy: mfjPolicy })
    const planJson = JSON.parse(JSON.stringify(builtOk(built).plan))
    const res = buildPlanFromParams({
      plan: planJson,
      conventions: { irmaaLookbackMagis: [100_000, -1] },
    })

    expect(res.ok).toBe(false)
    expect('plan' in res).toBe(false)
    expect(
      builtFailed(res).issues.some((issue) => issue.includes('historicalAnnualMagiByYear')),
    ).toBe(true)
  })

  it('requires either plan JSON or both household and policy', () => {
    const res = buildPlanFromParams({ startYear: 2026 })
    expect(res.ok).toBe(false)
    expect(builtFailed(res).issues).toEqual(['Provide either `plan` JSON or both `household` and `policy`'])
  })
})

describe('buildPlanFromParams — validation guards', () => {
  it('rejects horizon < 1', () => {
    const res = buildPlanFromParams({
      household: { ...singleHousehold, horizon: 0 },
      policy: singlePolicy,
    })
    expect(res.ok).toBe(false)
    expect(builtFailed(res).issues).toEqual(['horizon must be >= 1'])
    expect('plan' in res).toBe(false)
  })

  it('rejects an empty persons array', () => {
    const res = buildPlanFromParams({
      household: { ...singleHousehold, persons: [] },
      policy: singlePolicy,
    })
    expect(res.ok).toBe(false)
    expect(builtFailed(res).issues).toEqual(['household.persons must not be empty'])
  })

  it('rejects claim_ages shorter than persons', () => {
    const res = buildPlanFromParams({
      household: mfjHousehold, // two persons
      policy: { ...mfjPolicy, claim_ages: [67] }, // only one
    })
    expect(res.ok).toBe(false)
    expect(builtFailed(res).issues).toEqual([
      'policy.claim_ages must have exactly one entry per person',
    ])
  })

  // The build path used to check `<`, so a LONGER array was accepted and the
  // surplus silently dropped, while batch_evaluate rejected the same policy.
  // Exact length, both paths. @see adapter.batchEvaluate
  it('rejects claim_ages longer than persons', () => {
    const res = buildPlanFromParams({
      household: mfjHousehold, // two persons
      policy: { ...mfjPolicy, claim_ages: [67, 70, 62] }, // one too many
    })
    expect(res.ok).toBe(false)
    expect(builtFailed(res).issues).toEqual([
      'policy.claim_ages must have exactly one entry per person',
    ])
  })

  // validateTypedPathInputs runs BEFORE the horizon/persons/claim_ages guards, so
  // an input that is invalid several ways reports the state issue first. Pinned
  // because the error text is wire-visible and the precedence is deliberate, not
  // incidental to statement order.
  it('reports the state issue first when several typed-path rules fail at once', () => {
    const res = buildPlanFromParams({
      household: { ...mfjHousehold, state: 'California', horizon: 0 },
      policy: { ...mfjPolicy, claim_ages: [67] },
    })
    expect(res.ok).toBe(false)
    expect(builtFailed(res).issues).toEqual([
      'household.state must be a 2-letter code (A–Z), got "California"',
    ])
  })

  it('rejects a typed build with no household.state (WS1.3: state is required)', () => {
    const { state: _dropped, ...noState } = singleHousehold
    const res = buildPlanFromParams({
      household: noState as typeof singleHousehold,
      policy: singlePolicy,
    })
    expect(res.ok).toBe(false)
    expect('plan' in res).toBe(false)
    expect(builtFailed(res).issues).toHaveLength(1)
    expect(builtFailed(res).issues[0]).toContain('household.state is required')
    expect(builtFailed(res).issues[0]).toContain('2-letter')
  })

  it('rejects an invalid (non-2-letter) household.state as malformed, not missing', () => {
    const res = buildPlanFromParams({
      household: { ...singleHousehold, state: 'California' },
      policy: singlePolicy,
    })
    expect(res.ok).toBe(false)
    // A malformed value must not read as "required/missing" (that invites re-adding
    // the same bad value); it names the format problem and echoes the bad value.
    expect(builtFailed(res).issues[0]).toContain('household.state must be a 2-letter code')
    expect(builtFailed(res).issues[0]).toContain('California')
    expect(builtFailed(res).issues[0]).not.toContain('is required')
  })

  it('rejects a malformed assumptions.state override before it reaches the engine', () => {
    const res = buildPlanFromParams({
      household: singleHousehold, // valid household.state
      policy: singlePolicy,
      assumptions: { state: '9!' },
    })
    expect(res.ok).toBe(false)
    expect(builtFailed(res).issues[0]).toContain('assumptions.state must be a 2-letter code')
    expect(builtFailed(res).issues[0]).toContain('9!')
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
    expect('plan' in res).toBe(false)
    expect(builtFailed(res).issues).toEqual(['person 0: wages are not modeled; remove wage or use full plan JSON'])
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
    expect(err).toContain('household.state is required')
  })

  it('rejects a typed-path build (no plan) whose household state is malformed', () => {
    const err = validateToolArgs(entry, {
      household: { ...singleHousehold, state: 'California' },
      policy: singlePolicy,
    })
    // A malformed value must not read as "required/missing" here either — the
    // gateway used to say exactly that, telling a caller who supplied
    // "California" that they had supplied nothing.
    expect(err).toContain('household.state must be a 2-letter code')
    expect(err).toContain('California')
  })

  it('word-for-word matches what the typed path reports, for every shared rule', () => {
    // The point of validateTypedPathInputs: one wording, both transports. A
    // gateway caller and a stdio caller must not be told different things about
    // the same bad input.
    const cases: Array<Record<string, unknown>> = [
      { policy: singlePolicy },
      { household: (({ state: _s, ...rest }) => rest)(singleHousehold), policy: singlePolicy },
      { household: { ...singleHousehold, state: 'California' }, policy: singlePolicy },
      { household: singleHousehold, policy: singlePolicy, assumptions: { state: '9!' } },
    ]
    for (const args of cases) {
      const gatewayError = validateToolArgs(entry, args)
      const typedIssues = builtFailed(buildPlanFromParams(args as never)).issues
      expect(gatewayError).toBe(typedIssues[0])
    }
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
    expect(builtOk(res).plan.assumptions.historicalAnnualMagiByYear).toEqual({
      '2028': 80_000,
      '2029': 82_000,
    })
    expect(builtOk(res).plan.assumptions.recentAnnualMagi).toBe(80_000)
    expect(res.caveats.some((c) => c.startsWith('IRMAA-lookback'))).toBe(false)
  })

  it('applies a withdrawalOrdering convention that overrides policy.ordering', () => {
    const res = buildPlanFromParams({
      household: singleHousehold,
      policy: { ...singlePolicy, ordering: 'taxable-first' },
      conventions: { withdrawalOrdering: 'proportional' },
    })
    expect(res.ok).toBe(true)
    expect(builtOk(res).plan.strategies.withdrawalOrder).toEqual({ mode: 'proportional' })
  })

  it('records a caveat for a traditional-first withdrawalOrdering convention', () => {
    const res = buildPlanFromParams({
      household: singleHousehold,
      policy: { ...singlePolicy, ordering: 'taxable-first' },
      conventions: { withdrawalOrdering: 'traditional-first' },
    })
    expect(res.ok).toBe(true)
    expect(builtOk(res).plan.strategies.withdrawalOrder).toEqual({ mode: 'sequential' })
    expect(
      res.caveats.some((c) => c.includes('traditional-first has no exact engine equivalent')),
    ).toBe(true)
  })

  it('ignores a legacy lawSunsetFreezeYear without a caveat, and strips it at the tool boundary', () => {
    // A conventions block saved by an older export_plan can still carry the key.
    // The engine has no freeze knob, so 0.10.0 removed it from the tool schema and
    // stopped emitting the caveat that implied one was attempted. Two things must
    // remain true: the programmatic path still accepts (and ignores) it, and the
    // zod object is non-strict, so the tool transports drop the unknown key rather
    // than refusing the whole import.
    const res = buildPlanFromParams({
      household: singleHousehold,
      policy: singlePolicy,
      startYear: 2030,
      conventions: { lawSunsetFreezeYear: 2030, irmaaLookbackMagis: [1, 2] },
    })
    expect(res.ok).toBe(true)
    expect(res.caveats.some((c) => c.toLowerCase().includes('sunset'))).toBe(false)
    expect(res.caveats.some((c) => c.toLowerCase().includes('freeze'))).toBe(false)
    // The surviving knob still applied.
    expect(builtOk(res).plan.assumptions.historicalAnnualMagiByYear).toEqual({
      '2028': 1,
      '2029': 2,
    })

    const entry = getTool('build_plan')!
    const args = {
      household: singleHousehold,
      policy: singlePolicy,
      startYear: 2030,
      conventions: { lawSunsetFreezeYear: 2030, irmaaLookbackMagis: [1, 2] },
    }
    expect(validateToolArgs(entry, args)).toBeNull()
    expect(
      argsSchemaFor(entry).parse(args) as { conventions: Record<string, unknown> },
    ).toMatchObject({ conventions: { irmaaLookbackMagis: [1, 2] } })
    expect(
      'lawSunsetFreezeYear' in
        (argsSchemaFor(entry).parse(args) as { conventions: Record<string, unknown> }).conventions,
    ).toBe(false)
  })

  it('maps a convention irmaaLookbackMagis pair without a lossy caveat', () => {
    const res = buildPlanFromParams({
      household: singleHousehold,
      policy: singlePolicy,
      conventions: { irmaaLookbackMagis: [111_000, 222_000] },
    })
    expect(res.ok).toBe(true)
    expect(builtOk(res).plan.assumptions.recentAnnualMagi).toBe(111_000)
    expect(builtOk(res).plan.assumptions.historicalAnnualMagiByYear).toEqual({
      '2024': 111_000,
      '2025': 222_000,
    })
    expect(res.caveats.some((c) => c.includes('convention irmaaLookbackMagis='))).toBe(false)
  })
})
