import { describe, expect, it } from 'vitest'
import { buildPlanFromParams } from '../src/buildPlan.js'
import { jsonResult, getTool, validateToolArgs } from '../src/toolTable.js'
import { singleHousehold, singlePolicy, builtOk } from './fixtures.js'

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
})
