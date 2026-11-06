import { describe, expect, it } from 'vitest'
import type { Plan } from '@retiregolden/engine'
import * as adapter from '../src/adapter.js'
import { buildPlanFromParams } from '../src/buildPlan.js'
import {
  MAX_ARRAY_ENTRIES,
  MAX_CAVEAT_CHARS,
  MAX_CAVEATS,
  planCollectionCount,
  planWorkFactor,
  structuralBudgetIssue,
} from '../src/limits.js'
import { createSession } from '../src/session.js'
import { jsonResult, getTool, validateToolArgs } from '../src/toolTable.js'
import { singleHousehold, singlePolicy, builtOk } from './fixtures.js'

function legacyConversionActions(count: number): Plan['strategies']['retirementActions'] {
  return Array.from({ length: count }, (_, index) => ({
    actionId: `action-${index}`,
    kind: 'legacyAggregateRothConversion',
    year: 2026,
    requestedAmount: 1,
    provenance: { source: 'migration' },
  })) as unknown as Plan['strategies']['retirementActions']
}

describe('shared input and response limits', () => {
  it.each(['build_plan', 'validate_plan', 'compare_scenarios'])('publishes the shared calendar-year range for %s', (name) => {
    const entry = getTool(name)!
    expect(validateToolArgs(entry, { ...(name === 'build_plan' ? { household: singleHousehold, policy: singlePolicy } : name === 'compare_scenarios' ? { planA: {}, planB: {} } : {}), startYear: 1899 })).toContain('1900')
    expect(validateToolArgs(entry, { ...(name === 'build_plan' ? { household: singleHousehold, policy: singlePolicy } : name === 'compare_scenarios' ? { planA: {}, planB: {} } : {}), startYear: 2201 })).toContain('2200')
  })

  it('enforces provenance text bounds for programmatic build callers', () => {
    const result = buildPlanFromParams({ household: singleHousehold, policy: singlePolicy, engineVersion: 'x'.repeat(129) })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues[0]).toContain('128')
  })

  it('publishes and enforces the update operation count', () => {
    const entry = getTool('update_plan')!
    const operations = Array.from({ length: 1_001 }, () => ({
      op: 'set_expense',
      field: 'baseAnnual',
      value: 1,
    }))
    expect(validateToolArgs(entry, { operations })).toContain('1000')
  })

  it('rejects a full plan whose effective span exceeds 120 years', () => {
    const seed = builtOk(buildPlanFromParams({ household: singleHousehold, policy: singlePolicy, startYear: 2026 }))
    const plan = structuredClone(seed.plan)
    plan.household.people[0]!.dob = '2100-06-15'
    plan.household.people[0]!.longevity.planningAge = 120
    const result = buildPlanFromParams({ plan, startYear: 2026 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues.join(' ')).toContain('120 years')
  })

  it('rejects oversized full-plan text before engine parsing', () => {
    const result = buildPlanFromParams({ plan: { note: 'x'.repeat(2 * 1024 * 1024 + 1) }, startYear: 2026 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues[0]).toContain('byte budget')
  })

  it('bounds MCP response serialization', () => {
    expect(() => jsonResult({ text: 'x'.repeat(8 * 1024 * 1024 + 1) })).toThrow(/response exceeds byte budget/)
  })

  it('serializes a large numeric response within the byte and node budgets', () => {
    const result = jsonResult(new Array(350_000).fill(0))
    expect(result.content[0]!.text.length).toBeGreaterThan(1_000_000)
  })

  it('rejects an update that creates a 501st account without changing the session', () => {
    const seed = builtOk(buildPlanFromParams({
      household: singleHousehold,
      policy: singlePolicy,
      startYear: 2026,
    }))
    const plan = structuredClone(seed.plan)
    const account = plan.accounts[0]!
    plan.accounts = Array.from({ length: 500 }, (_, index) => ({
      ...structuredClone(account),
      id: `account-${index}`,
    }))
    const session = createSession(2026)
    expect(adapter.setPlanFromBuild(session, { plan, startYear: 2026 }).ok).toBe(true)
    const committed = session.plan
    const result = adapter.updatePlan(session, [{
      op: 'add_account',
      account: { ...structuredClone(account), id: 'account-500' },
    }])
    expect(result).toMatchObject({ ok: false, error: 'INVALID_PLAN' })
    expect(session.plan).toBe(committed)
    expect(session.plan?.accounts).toHaveLength(500)
  })

  it('allows a replacement that shrinks a near-limit plan', () => {
    const seed = builtOk(buildPlanFromParams({
      household: singleHousehold,
      policy: singlePolicy,
      startYear: 2026,
    }))
    const base = structuredClone(seed.plan)
    const smallAccount = structuredClone(base.accounts[0]!)
    let low = 0
    let high = 2 * 1024 * 1024
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      const candidate = structuredClone(base)
      candidate.accounts[0] = { ...structuredClone(smallAccount), name: 'x'.repeat(middle) }
      if (structuralBudgetIssue(candidate) === null) low = middle
      else high = middle - 1
    }
    const nearLimit = structuredClone(base)
    nearLimit.accounts[0] = { ...structuredClone(smallAccount), name: 'x'.repeat(low) }
    const operation = {
      op: 'replace_account' as const,
      id: nearLimit.accounts[0]!.id,
      account: smallAccount,
    }
    expect(structuralBudgetIssue(nearLimit)).toBeNull()
    expect(structuralBudgetIssue({ plan: nearLimit, operations: [operation] })).not.toBeNull()

    const session = createSession(2026)
    expect(adapter.setPlanFromBuild(session, { plan: nearLimit, startYear: 2026 }).ok).toBe(true)
    const result = adapter.updatePlan(session, [operation])
    expect(result.ok).toBe(true)
    expect(structuralBudgetIssue(session.plan)).toBeNull()
    expect(session.plan?.accounts[0]?.name).toBe(smallAccount.name)
  })

  it('normalizes a long dropped-field caveat and keeps session tools usable', () => {
    const seed = builtOk(buildPlanFromParams({ household: singleHousehold, policy: singlePolicy, startYear: 2026 }))
    const plan = structuredClone(seed.plan) as typeof seed.plan & Record<string, unknown>
    plan[`future_${'x'.repeat(2_200)}`] = true
    const session = createSession(2026)
    const built = adapter.setPlanFromBuild(session, { plan, startYear: 2026 })
    expect(built.ok).toBe(true)
    if (!built.ok) return
    const note = built.caveats.find((caveat) => caveat.startsWith('fields dropped:'))
    expect(note).toBeDefined()
    expect(note!.length).toBe(MAX_CAVEAT_CHARS)
    expect(note).toMatch(/\.\.\.$/u)
    expect(note).not.toMatch(/[\r\n\t]/u)
    expect(adapter.snapshotCaveats(session)).toEqual(built.caveats)
    expect(adapter.runProjection(session).ok).toBe(true)
    expect(adapter.exportPlan(session).ok).toBe(true)
  })

  it('normalizes person text in priced batch-row caveats', () => {
    const seed = builtOk(buildPlanFromParams({
      household: singleHousehold,
      policy: { ...singlePolicy, claim_ages: [62] },
      startYear: 2026,
    }))
    const plan = structuredClone(seed.plan)
    plan.household.people[0]!.name = `Long\n${'x'.repeat(2_200)}\tName`
    const session = createSession(2026)
    expect(adapter.setPlanFromBuild(session, { plan, startYear: 2026 }).ok).toBe(true)
    const result = adapter.batchEvaluate(session, [{ ...singlePolicy, claim_ages: [67] }])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const row = result.results[0]!
    expect(row.ok).toBe(true)
    expect(typeof row.objective).toBe('number')
    const note = row.caveats.find((caveat) => caveat.startsWith("person 'person-0'"))
    expect(note).toBeDefined()
    expect(note!.length).toBe(MAX_CAVEAT_CHARS)
    expect(note).not.toMatch(/[\r\n\t]/u)
  })

  it('keeps caveats bounded through repeated updates', () => {
    const session = createSession(2026)
    expect(adapter.setPlanFromBuild(session, {
      household: singleHousehold,
      policy: singlePolicy,
      startYear: 2026,
    }).ok).toBe(true)
    session.caveats.push(...Array.from({ length: 70 }, (_, index) => `prior note ${index}`))
    for (let index = 0; index < 66; index += 1) {
      const result = adapter.updatePlan(session, [{
        op: 'set_expense',
        field: 'baseAnnual',
        value: 60_000 + index,
      }])
      expect(result.ok).toBe(true)
      expect(adapter.snapshotCaveats(session).length).toBeLessThanOrEqual(MAX_CAVEATS)
    }
    expect(adapter.runProjection(session).ok).toBe(true)
    expect(adapter.exportPlan(session).ok).toBe(true)
  })

  it('scales multi-path work by full-plan collection size', () => {
    const seed = builtOk(buildPlanFromParams({
      household: singleHousehold,
      policy: singlePolicy,
      startYear: 2026,
    }))
    const plan = structuredClone(seed.plan)
    plan.household.people[0]!.dob = '2005-06-15'
    plan.household.people[0]!.retirementAge = 30
    plan.household.people[0]!.longevity.planningAge = 120
    const account = plan.accounts[0]!
    plan.accounts = Array.from({ length: 500 }, (_, index) => ({
      ...structuredClone(account),
      id: `large-${index}`,
    }))
    const session = createSession(2026)
    expect(adapter.setPlanFromBuild(session, { plan, startYear: 2026 }).ok).toBe(true)
    expect(adapter.runProjection(session).ok).toBe(true)
    expect(adapter.runMonteCarlo(session, { pathCount: 5_000 })).toMatchObject({
      ok: false,
      error: 'COMPUTATION_LIMIT',
    })
  })

  it('counts nested engine collections in the aggregate work budget', () => {
    const seed = builtOk(buildPlanFromParams({
      household: singleHousehold,
      policy: singlePolicy,
      startYear: 2026,
    }))
    const plan = structuredClone(seed.plan)
    plan.household.people[0]!.longevity.planningAge = 120
    plan.strategies.retirementActions = legacyConversionActions(500)
    const session = createSession(2026)
    expect(adapter.setPlanFromBuild(session, { plan, startYear: 2026 }).ok).toBe(true)
    expect(planCollectionCount(session.plan!)).toBeGreaterThanOrEqual(500)
    expect(planWorkFactor(session.plan!)).toBeGreaterThanOrEqual(20)
    expect(adapter.runProjection(session).ok).toBe(true)
    expect(adapter.runMonteCarlo(session, { pathCount: 5_000 })).toMatchObject({
      ok: false,
      error: 'COMPUTATION_LIMIT',
    })
    expect(adapter.batchEvaluate(
      session,
      Array.from({ length: 500 }, () => ({ ...singlePolicy })),
    )).toMatchObject({
      ok: false,
      error: 'COMPUTATION_LIMIT',
    })
  })

  it('rejects an oversized nested plan array before parsing', () => {
    const seed = builtOk(buildPlanFromParams({
      household: singleHousehold,
      policy: singlePolicy,
      startYear: 2026,
    }))
    const plan = structuredClone(seed.plan)
    plan.strategies.retirementActions = legacyConversionActions(MAX_ARRAY_ENTRIES + 1)
    expect(structuralBudgetIssue(plan)).toBe(
      `plan.retirementActions exceeds ${MAX_ARRAY_ENTRIES} entries`,
    )
    const result = buildPlanFromParams({ plan, startYear: 2026 })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.issues).toEqual([
        `plan.retirementActions exceeds ${MAX_ARRAY_ENTRIES} entries`,
      ])
    }
  })
})
