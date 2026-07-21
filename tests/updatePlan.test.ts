/**
 * update_plan: incremental merge-semantics mutation of the session plan. Covers
 * add/replace/remove/set operations, the validate-before-commit safety (a failed
 * validation leaves session.plan byte-identical), the NO_PLAN branch, and a full
 * round-trip: build minimal -> several update_plan ops -> export_plan ->
 * validate_plan ok.
 */

import { describe, expect, it } from 'vitest'
import { createSession, type SessionState } from '../src/session.js'
import * as adapter from '../src/adapter.js'
import { singleHousehold, singlePolicy } from './fixtures.js'

function seededSession(): SessionState {
  const session = createSession(2026)
  const built = adapter.setPlanFromBuild(session, {
    household: singleHousehold,
    policy: singlePolicy,
    startYear: 2026,
  })
  expect(built.ok).toBe(true)
  return session
}

/** A valid engine-plan taxable-account fragment (what document extraction emits). */
function brokerageFragment(id = 'brokerage-1', balance = 250_000) {
  return {
    id,
    name: 'Fidelity Brokerage',
    ownerPersonId: null,
    annualReturnPct: null,
    type: 'taxable',
    balance,
    costBasis: 180_000,
    annualContribution: 0,
  }
}

describe('update_plan', () => {
  it('NO_PLAN when no plan is seeded', () => {
    const session = createSession(2026)
    const res = adapter.updatePlan(session, [{ op: 'add_account', account: brokerageFragment() }])
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toBe('NO_PLAN')
    expect(session.plan).toBeNull()
  })

  it('add_account appends a validated account', () => {
    const session = seededSession()
    const before = session.plan!.accounts.length
    const res = adapter.updatePlan(session, [
      { op: 'add_account', account: brokerageFragment() },
    ])
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.appliedOperations).toBe(1)
    expect(session.plan!.accounts.length).toBe(before + 1)
    expect(session.plan!.accounts.some((a) => a.id === 'brokerage-1')).toBe(true)
  })

  it('replace_account swaps by id', () => {
    const session = seededSession()
    const targetId = session.plan!.accounts[0]!.id
    const res = adapter.updatePlan(session, [
      { op: 'replace_account', id: targetId, account: brokerageFragment(targetId, 999_000) },
    ])
    expect(res.ok).toBe(true)
    const replaced = session.plan!.accounts.find((a) => a.id === targetId)
    expect(replaced?.type).toBe('taxable')
    expect((replaced as { balance: number }).balance).toBe(999_000)
  })

  it('remove_account drops by id', () => {
    const session = seededSession()
    const targetId = session.plan!.accounts[session.plan!.accounts.length - 1]!.id
    const before = session.plan!.accounts.length
    const res = adapter.updatePlan(session, [{ op: 'remove_account', id: targetId }])
    expect(res.ok).toBe(true)
    expect(session.plan!.accounts.length).toBe(before - 1)
    expect(session.plan!.accounts.some((a) => a.id === targetId)).toBe(false)
  })

  it('add_income appends a recurring income', () => {
    const session = seededSession()
    const before = session.plan!.incomes.length
    const res = adapter.updatePlan(session, [
      {
        op: 'add_income',
        income: {
          type: 'recurring',
          id: 'pension-1',
          label: 'Employer pension',
          annualAmount: 24_000,
          startYear: 2026,
          endYear: 2045,
          inflationAdjusted: false,
          taxTreatment: 'ordinary',
        },
      },
    ])
    expect(res.ok).toBe(true)
    expect(session.plan!.incomes.length).toBe(before + 1)
    expect(session.plan!.incomes.some((i) => i.id === 'pension-1')).toBe(true)
  })

  it('set_assumption and set_expense update single fields', () => {
    const session = seededSession()
    const res = adapter.updatePlan(session, [
      { op: 'set_assumption', field: 'inflationPct', value: 3.1 },
      { op: 'set_expense', field: 'baseAnnual', value: 72_000 },
    ])
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.appliedOperations).toBe(2)
    expect(session.plan!.assumptions.inflationPct).toBe(3.1)
    expect(session.plan!.expenses.baseAnnual).toBe(72_000)
  })

  it('an operation targeting a missing id fails without mutating', () => {
    const session = seededSession()
    const snapshot = structuredClone(session.plan)
    const res = adapter.updatePlan(session, [{ op: 'remove_account', id: 'does-not-exist' }])
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toBe('OPERATION_FAILED')
    expect(session.plan).toEqual(snapshot)
  })

  it('a plan that fails engine validation leaves the session plan untouched', () => {
    const session = seededSession()
    const snapshot = structuredClone(session.plan)
    // Negative balance violates the schema (minimum 0): parsePlan rejects the
    // mutated plan, so the merge is rolled back wholesale.
    const res = adapter.updatePlan(session, [
      { op: 'add_account', account: brokerageFragment('bad-1', -5) },
    ])
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toBe('INVALID_PLAN')
    expect((res.issues ?? []).length).toBeGreaterThan(0)
    expect(session.plan).toEqual(snapshot)
  })

  it('partially-valid batches do not half-apply: a later bad op rolls back an earlier good op', () => {
    const session = seededSession()
    const before = session.plan!.accounts.length
    const res = adapter.updatePlan(session, [
      { op: 'add_account', account: brokerageFragment('good-1') },
      { op: 'add_account', account: brokerageFragment('bad-2', -1) },
    ])
    expect(res.ok).toBe(false)
    // The first (valid) add is discarded because the batch failed validation.
    expect(session.plan!.accounts.length).toBe(before)
    expect(session.plan!.accounts.some((a) => a.id === 'good-1')).toBe(false)
  })

  it('rejects a replacement fragment whose id does not match the target id', () => {
    const session = seededSession()
    const targetId = session.plan!.accounts[0]!.id
    const snapshot = structuredClone(session.plan)
    const res = adapter.updatePlan(session, [
      { op: 'replace_account', id: targetId, account: brokerageFragment('some-other-id') },
    ])
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toBe('OPERATION_FAILED')
    expect(session.plan).toEqual(snapshot)
  })

  it('fills in an omitted id on a replacement fragment from the target id', () => {
    const session = seededSession()
    const targetId = session.plan!.accounts[0]!.id
    const fragment = brokerageFragment(targetId)
    delete (fragment as { id?: unknown }).id
    const res = adapter.updatePlan(session, [
      { op: 'replace_account', id: targetId, account: fragment },
    ])
    expect(res.ok).toBe(true)
    expect(session.plan!.accounts.some((a) => a.id === targetId)).toBe(true)
  })

  it('rejects a prototype-polluting key in a fragment or set field', () => {
    const session = seededSession()
    const snapshot = structuredClone(session.plan)
    // Computed-key form creates an OWN "__proto__" property (as JSON.parse does),
    // rather than the literal `{ __proto__: ... }` form which sets the prototype.
    const poisonAccount: Record<string, unknown> = {
      ...brokerageFragment('poison'),
      ['__proto__']: { polluted: true },
    }
    const poison = adapter.updatePlan(session, [{ op: 'add_account', account: poisonAccount }])
    expect(poison.ok).toBe(false)
    if (!poison.ok) expect(poison.error).toBe('OPERATION_FAILED')
    expect(session.plan).toEqual(snapshot)

    const badField = adapter.updatePlan(session, [
      { op: 'set_assumption', field: '__proto__', value: { polluted: true } },
    ])
    expect(badField.ok).toBe(false)
    expect(session.plan).toEqual(snapshot)
    // The prototype of a fresh object was not polluted.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('clears a stale irmaaLookbackMagis convention when recentAnnualMagi is set directly', () => {
    const session = createSession(2026)
    adapter.setPlanFromBuild(session, {
      household: singleHousehold,
      policy: singlePolicy,
      startYear: 2026,
      conventions: { irmaaLookbackMagis: [50_000, 60_000] },
    })
    expect(session.conventions.irmaaLookbackMagis).toEqual([50_000, 60_000])
    const res = adapter.updatePlan(session, [
      { op: 'set_assumption', field: 'recentAnnualMagi', value: 90_000 },
    ])
    expect(res.ok).toBe(true)
    // The superseded convention is cleared so the explicit MAGI round-trips.
    expect(session.conventions.irmaaLookbackMagis).toBeNull()
    expect(session.plan!.assumptions.recentAnnualMagi).toBe(90_000)
    if (res.ok) expect(res.caveats.some((c) => c.includes('recentAnnualMagi'))).toBe(true)
  })

  it('records a caveat and clears the stale projection on commit', () => {
    const session = seededSession()
    adapter.runProjection(session)
    expect(session.lastProjection).not.toBeNull()
    const res = adapter.updatePlan(session, [
      { op: 'set_assumption', field: 'inflationPct', value: 2.7 },
    ])
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(session.lastProjection).toBeNull()
    expect(res.caveats.some((c) => c.includes('update_plan'))).toBe(true)
  })

  it('round-trips: build minimal -> update ops -> export -> validate ok', () => {
    const session = seededSession()
    const update = adapter.updatePlan(session, [
      { op: 'add_account', account: brokerageFragment('rt-brokerage', 300_000) },
      { op: 'add_income', income: {
        type: 'recurring',
        id: 'rt-pension',
        label: 'Pension',
        annualAmount: 18_000,
        startYear: 2026,
        endYear: 2040,
        inflationAdjusted: true,
        taxTreatment: 'ordinary',
      } },
      { op: 'set_expense', field: 'baseAnnual', value: 65_000 },
    ])
    expect(update.ok).toBe(true)

    const exported = adapter.exportPlan(session)
    expect(exported.ok).toBe(true)
    if (!exported.ok) return

    const validated = adapter.validatePlanJson(JSON.parse(JSON.stringify(exported.plan)))
    expect(validated.ok).toBe(true)
    // The mutations are present in the exported document.
    expect(exported.plan.accounts.some((a) => a.id === 'rt-brokerage')).toBe(true)
    expect(exported.plan.incomes.some((i) => i.id === 'rt-pension')).toBe(true)
    expect(exported.plan.expenses.baseAnnual).toBe(65_000)
  })
})
