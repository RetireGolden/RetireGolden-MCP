/**
 * WS2/WS1.3 assumptions overrides — each override must demonstrably reach the
 * built plan (and, where it changes math, move the projection). Omitting the
 * whole block now lets the ENGINE defaults through (WS1.3 default flip); the
 * legacy bench values are reproduced only by passing them explicitly, proven
 * numerically by tests/goldens.test.ts. Here we assert that each field lands
 * where the engine reads it, and that omission keeps the engine default.
 */

import { describe, expect, it } from 'vitest'
import { buildPlanFromParams, AssumptionsSchema } from '../src/buildPlan.js'
import { createSession } from '../src/session.js'
import * as adapter from '../src/adapter.js'
import { singleHousehold, singlePolicy, mfjHousehold, mfjPolicy } from './fixtures.js'

function taxableAccount(plan: NonNullable<ReturnType<typeof buildPlanFromParams>['plan']>) {
  const acct = plan.accounts.find((a) => a.type === 'taxable')
  if (!acct) throw new Error('no taxable account')
  return acct as { type: 'taxable'; qualifiedRatio: number }
}

describe('assumptions overrides reach the plan', () => {
  it('inflationPct override lands on assumptions and moves the projection', () => {
    // base = no assumptions → engine default inflation (2.5%).
    const base = createSession()
    adapter.setPlanFromBuild(base, { household: singleHousehold, policy: singlePolicy })
    const baseProj = adapter.runProjection(base)
    expect(baseProj.ok).toBe(true)

    const infl = createSession()
    const built = adapter.setPlanFromBuild(infl, {
      household: singleHousehold,
      policy: singlePolicy,
      assumptions: { inflationPct: 6 },
    })
    expect(built.ok).toBe(true)
    expect(built.plan!.assumptions.inflationPct).toBe(6)
    const inflProj = adapter.runProjection(infl)
    expect(inflProj.ok).toBe(true)
    if (baseProj.ok && inflProj.ok) {
      // An explicit override must change the modeled outcome vs the engine default.
      expect(inflProj.summary.endingAfterTaxEstate).not.toBe(
        baseProj.summary.endingAfterTaxEstate,
      )
    }
  })

  it('state override lands on the household (2-letter code)', () => {
    const res = buildPlanFromParams({
      household: singleHousehold,
      policy: singlePolicy,
      assumptions: { state: 'CA' },
    })
    expect(res.ok).toBe(true)
    expect(res.plan!.household.state).toBe('CA')
  })

  it('omitted assumptions.state uses the required household.state', () => {
    // singleHousehold declares state: 'KY'; with no override it flows through.
    const res = buildPlanFromParams({ household: singleHousehold, policy: singlePolicy })
    expect(res.ok).toBe(true)
    expect(res.plan!.household.state).toBe('KY')
  })

  it('assumptions.state overrides the household state', () => {
    const res = buildPlanFromParams({
      household: { ...singleHousehold, state: 'KY' },
      policy: singlePolicy,
      assumptions: { state: 'TX' },
    })
    expect(res.ok).toBe(true)
    expect(res.plan!.household.state).toBe('TX')
  })

  it('qualifiedRatio override lands on the taxable account', () => {
    const res = buildPlanFromParams({
      household: singleHousehold,
      policy: singlePolicy,
      assumptions: { qualifiedRatio: 0.5 },
    })
    expect(res.ok).toBe(true)
    expect(taxableAccount(res.plan!).qualifiedRatio).toBe(0.5)
  })

  it('omitted qualifiedRatio keeps the neutral default 0.85', () => {
    const res = buildPlanFromParams({ household: singleHousehold, policy: singlePolicy })
    expect(res.ok).toBe(true)
    expect(taxableAccount(res.plan!).qualifiedRatio).toBe(0.85)
  })

  it('dobMonthDay and sex overrides land on every person', () => {
    const res = buildPlanFromParams({
      household: singleHousehold,
      policy: singlePolicy,
      assumptions: { dobMonthDay: '03-22', sex: 'male' },
    })
    expect(res.ok).toBe(true)
    for (const person of res.plan!.household.people) {
      expect(person.dob.endsWith('-03-22')).toBe(true)
      expect(person.sex).toBe('male')
    }
  })

  it('omitted dobMonthDay and sex keep neutral defaults (06-15 / average)', () => {
    const res = buildPlanFromParams({ household: singleHousehold, policy: singlePolicy })
    expect(res.ok).toBe(true)
    for (const person of res.plan!.household.people) {
      expect(person.dob.endsWith('-06-15')).toBe(true)
      expect(person.sex).toBe('average')
    }
  })

  it('numeric percent overrides land on assumptions', () => {
    const res = buildPlanFromParams({
      household: singleHousehold,
      policy: singlePolicy,
      assumptions: {
        healthcareExtraInflationPct: 2,
        defaultReturnPct: 4.5,
        ssColaPct: 2.5,
        stateEffectiveTaxPct: 3,
        localIncomeTaxPct: 1,
      },
    })
    expect(res.ok).toBe(true)
    const a = res.plan!.assumptions
    expect(a.healthcareExtraInflationPct).toBe(2)
    expect(a.defaultReturnPct).toBe(4.5)
    expect(a.ssCola).toEqual({ mode: 'fixed', annualPct: 2.5 })
    expect(a.stateEffectiveTaxPct).toBe(3)
    expect(a.localIncomeTaxPct).toBe(1)
  })
})

describe('dobMonthDay calendar-aware validation', () => {
  const accept = ['01-01', '02-29', '06-15', '12-31', '04-30', '02-28', '11-30']
  for (const v of accept) {
    it(`accepts valid month-day ${v}`, () => {
      expect(AssumptionsSchema.safeParse({ dobMonthDay: v }).success).toBe(true)
    })
  }

  const reject = ['13-40', '00-00', '02-31', '00-15', '13-01', '01-00', '01-32', '04-31', '06-00']
  for (const v of reject) {
    it(`rejects impossible month-day ${v}`, () => {
      const parsed = AssumptionsSchema.safeParse({ dobMonthDay: v })
      expect(parsed.success).toBe(false)
      if (!parsed.success) {
        // A clear, actionable message must be attached to the field.
        expect(parsed.error.issues.some((i) => i.message.includes('dobMonthDay'))).toBe(true)
      }
    })
  }

  it('still rejects the wrong shape (non-MM-DD strings)', () => {
    expect(AssumptionsSchema.safeParse({ dobMonthDay: '6-15' }).success).toBe(false)
    expect(AssumptionsSchema.safeParse({ dobMonthDay: '2026-06-15' }).success).toBe(false)
    expect(AssumptionsSchema.safeParse({ dobMonthDay: 'June 15' }).success).toBe(false)
  })
})

describe('assumption-interaction caveats (footguns)', () => {
  it('warns when state is set but stateEffectiveTaxPct is not (tax still 0%)', () => {
    const res = buildPlanFromParams({
      household: singleHousehold,
      policy: singlePolicy,
      assumptions: { state: 'CA' },
    })
    expect(res.ok).toBe(true)
    expect(res.plan!.household.state).toBe('CA')
    expect(res.plan!.assumptions.stateEffectiveTaxPct).toBe(0)
    expect(
      res.caveats.some((c) => c.includes('state=CA') && c.includes('stateEffectiveTaxPct')),
    ).toBe(true)
  })

  it('does not warn about state tax when stateEffectiveTaxPct is provided', () => {
    const res = buildPlanFromParams({
      household: singleHousehold,
      policy: singlePolicy,
      assumptions: { state: 'CA', stateEffectiveTaxPct: 6 },
    })
    expect(res.ok).toBe(true)
    expect(res.caveats.some((c) => c.includes('stateEffectiveTaxPct'))).toBe(false)
  })

  it('warns that sex/dobMonthDay apply to every person in a multi-person household', () => {
    const res = buildPlanFromParams({
      household: mfjHousehold, // two persons
      policy: mfjPolicy,
      assumptions: { sex: 'male', dobMonthDay: '03-22' },
    })
    expect(res.ok).toBe(true)
    const caveat = res.caveats.find((c) => c.includes('every person'))
    expect(caveat).toBeTruthy()
    expect(caveat).toContain('sex')
    expect(caveat).toContain('dobMonthDay')
  })

  it('does not warn about per-person overrides for a single-person household', () => {
    const res = buildPlanFromParams({
      household: singleHousehold, // one person
      policy: singlePolicy,
      assumptions: { sex: 'male', dobMonthDay: '03-22' },
    })
    expect(res.ok).toBe(true)
    expect(res.caveats.some((c) => c.includes('every person'))).toBe(false)
  })
})
