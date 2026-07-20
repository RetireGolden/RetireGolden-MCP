/**
 * WS2 assumptions overrides — each override must demonstrably reach the built
 * plan (and, where it changes math, move the projection). Omitting the whole
 * block reproduces the RetireBench bench defaults; that byte-identical guarantee
 * is proven numerically by tests/goldens.test.ts, so here we only assert that
 * each field lands where the engine reads it.
 */

import { describe, expect, it } from 'vitest'
import { buildPlanFromParams } from '../src/buildPlan.js'
import { createSession } from '../src/session.js'
import * as adapter from '../src/adapter.js'
import { singleHousehold, singlePolicy } from './fixtures.js'

function taxableAccount(plan: NonNullable<ReturnType<typeof buildPlanFromParams>['plan']>) {
  const acct = plan.accounts.find((a) => a.type === 'taxable')
  if (!acct) throw new Error('no taxable account')
  return acct as { type: 'taxable'; qualifiedRatio: number }
}

describe('assumptions overrides reach the plan', () => {
  it('inflationPct override lands on assumptions and moves the projection', () => {
    const base = createSession()
    adapter.setPlanFromBuild(base, { household: singleHousehold, policy: singlePolicy })
    const baseProj = adapter.runProjection(base)
    expect(baseProj.ok).toBe(true)

    const infl = createSession()
    const built = adapter.setPlanFromBuild(infl, {
      household: singleHousehold,
      policy: singlePolicy,
      assumptions: { inflationPct: 2.5 },
    })
    expect(built.ok).toBe(true)
    expect(built.plan!.assumptions.inflationPct).toBe(2.5)
    const inflProj = adapter.runProjection(infl)
    expect(inflProj.ok).toBe(true)
    if (baseProj.ok && inflProj.ok) {
      // A non-zero inflation must change the modeled outcome vs the bench default.
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

  it('omitted state keeps the bench default KY', () => {
    const res = buildPlanFromParams({ household: singleHousehold, policy: singlePolicy })
    expect(res.ok).toBe(true)
    expect(res.plan!.household.state).toBe('KY')
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

  it('omitted qualifiedRatio keeps the bench default 0.85', () => {
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

  it('omitted dobMonthDay and sex keep bench defaults (06-15 / average)', () => {
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
