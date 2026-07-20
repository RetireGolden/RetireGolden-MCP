import { describe, expect, it } from 'vitest'
import { createSession } from '../src/session.js'
import * as adapter from '../src/adapter.js'
import { buildPlanFromParams } from '../src/buildPlan.js'
import { mfjHousehold, mfjPolicy, singleHousehold, singlePolicy } from './fixtures.js'

function mfjSession() {
  const session = createSession(2026)
  const built = adapter.setPlanFromBuild(session, {
    household: mfjHousehold,
    policy: mfjPolicy,
    startYear: 2026,
  })
  expect(built.ok).toBe(true)
  return session
}

describe('runProjection — MFJ two-person with pension', () => {
  it('returns a full ledger with sane numeric outputs', () => {
    const session = mfjSession()
    const proj = adapter.runProjection(session, { detail: 'years' })
    expect(proj.ok).toBe(true)
    if (!proj.ok || !('years' in proj)) return
    expect(proj.startYear).toBe(2026)
    expect(proj.endYear).toBe(2040)
    expect(proj.years).toHaveLength(15)

    // ending estate/net worth are positive and net worth >= after-tax estate
    expect(proj.summary.endingAfterTaxEstate).toBeGreaterThan(0)
    expect(proj.summary.endingNetWorth).toBeGreaterThan(0)
    expect(proj.summary.endingNetWorth).toBeGreaterThanOrEqual(proj.summary.endingAfterTaxEstate)

    // fill-to-bracket conversions run in the first policy window year
    const y0 = proj.years[0]!
    expect(y0.year).toBe(2026)
    expect(y0.rothConversion).toBeGreaterThan(0)
    expect(y0.tax).toBeGreaterThan(0)
    expect(y0.magi).toBeGreaterThan(0)
    expect(proj.summary.lifetimeRothConversions).toBeGreaterThan(0)

    // every year is fully funded for this comfortable household
    expect(proj.years.every((y) => y.shortfall === 0)).toBe(true)
  })
})

describe('runProjection — ordering modes surface their caveats', () => {
  it('taxable-first has no ordering caveat', () => {
    const session = createSession(2026)
    adapter.setPlanFromBuild(session, {
      household: singleHousehold,
      policy: { ...singlePolicy, ordering: 'taxable-first' },
    })
    const proj = adapter.runProjection(session)
    expect(proj.ok).toBe(true)
    if (proj.ok) {
      expect(proj.caveats.some((c) => c.includes('ordering=traditional-first'))).toBe(false)
    }
  })

  it('proportional projects successfully', () => {
    const session = createSession(2026)
    adapter.setPlanFromBuild(session, {
      household: singleHousehold,
      policy: { ...singlePolicy, ordering: 'proportional' },
    })
    const proj = adapter.runProjection(session, { detail: 'years' })
    expect(proj.ok).toBe(true)
    if (proj.ok && 'years' in proj) expect(proj.years.length).toBeGreaterThan(0)
  })

  it('traditional-first carries its approximate-ordering caveat through the projection', () => {
    const session = createSession(2026)
    adapter.setPlanFromBuild(session, {
      household: singleHousehold,
      policy: { ...singlePolicy, ordering: 'traditional-first' },
    })
    const proj = adapter.runProjection(session)
    expect(proj.ok).toBe(true)
    if (proj.ok) {
      expect(proj.caveats.some((c) => c.includes('ordering=traditional-first'))).toBe(true)
    }
  })
})

describe('batchEvaluate — ordering modes', () => {
  it('evaluates each ordering mode and flags the traditional-first approximation', () => {
    const session = mfjSession()
    const batch = adapter.batchEvaluate(session, [
      { ...mfjPolicy, ordering: 'taxable-first' },
      { ...mfjPolicy, ordering: 'proportional' },
      { ...mfjPolicy, ordering: 'traditional-first' },
    ])
    expect(batch.ok).toBe(true)
    if (!batch.ok) return
    expect(batch.results).toHaveLength(3)
    expect(batch.results.every((r) => r.ok)).toBe(true)
    expect(batch.results.every((r) => typeof r.objective === 'number')).toBe(true)
    // only the traditional-first cell records the approximate caveat
    expect(batch.results[0]!.caveats.some((c) => c.includes('traditional-first approximate'))).toBe(
      false,
    )
    expect(batch.results[2]!.caveats.some((c) => c.includes('traditional-first approximate'))).toBe(
      true,
    )
  })

  it('supports the cumulative_tax objective', () => {
    const session = mfjSession()
    const batch = adapter.batchEvaluate(session, [mfjPolicy], 'cumulative_tax')
    expect(batch.ok).toBe(true)
    if (batch.ok) {
      expect(batch.objective).toBe('cumulative_tax')
      expect(batch.results[0]!.objective).toBeGreaterThan(0)
    }
  })
})

describe('runMonteCarlo', () => {
  it('returns a summary with a success rate in [0, 1]', () => {
    const session = mfjSession()
    const mc = adapter.runMonteCarlo(session, { pathCount: 50, seed: 7 })
    expect(mc.ok).toBe(true)
    if (!mc.ok) return
    expect(mc.pathCount).toBe(50)
    expect(mc.seed).toBe(7)
    expect(mc.successRate).toBeGreaterThanOrEqual(0)
    expect(mc.successRate).toBeLessThanOrEqual(1)
    expect(mc.requiredFloorSuccessRate).toBeGreaterThanOrEqual(0)
    expect(mc.requiredFloorSuccessRate).toBeLessThanOrEqual(1)
  })

  it('is deterministic for a fixed seed', () => {
    const session = mfjSession()
    const a = adapter.runMonteCarlo(session, { pathCount: 64, seed: 123 })
    const b = adapter.runMonteCarlo(session, { pathCount: 64, seed: 123 })
    expect(a.ok && b.ok).toBe(true)
    if (a.ok && b.ok) {
      expect(a.successRate).toBe(b.successRate)
      expect(a.requiredFloorSuccessRate).toBe(b.requiredFloorSuccessRate)
    }
  })
})

describe('runOptimizer', () => {
  it('returns a schedule and a winning tournament entry', async () => {
    const session = mfjSession()
    const opt = await adapter.runOptimizer(session)
    expect(opt.ok).toBe(true)
    if (!opt.ok) return
    expect(opt.schedule).toBeTruthy()
    expect(typeof opt.tournament.winnerSource).toBe('string')
    expect(typeof opt.tournament.winnerLabel).toBe('string')
    expect(Array.isArray(opt.tournament.winnerConversions)).toBe(true)
  })
})

describe('solveMaxSpending', () => {
  it('bisects a positive maximum sustainable base annual spend', () => {
    const session = mfjSession()
    const res = adapter.solveMaxSpending(session)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(typeof res.maxBaseAnnual).toBe('number')
    expect(res.maxBaseAnnual!).toBeGreaterThan(0)
    expect(typeof res.converged).toBe('boolean')
    expect([null, 'depletion', 'estate-floor']).toContain(res.limitingConstraint)
  })
})

describe('compareScenarios', () => {
  it('reports a zero delta for two identical plans', () => {
    const session = mfjSession()
    const planJson = JSON.parse(
      JSON.stringify(buildPlanFromParams({ household: mfjHousehold, policy: mfjPolicy }).plan),
    )
    const cmp = adapter.compareScenarios(session, planJson, planJson)
    expect(cmp.ok).toBe(true)
    if (cmp.ok) {
      expect(cmp.deltaEndingAfterTaxEstate).toBe(0)
      expect(cmp.a.endingAfterTaxEstate).toBe(cmp.b.endingAfterTaxEstate)
    }
  })

  it('rejects an invalid plan A', () => {
    const session = mfjSession()
    const validPlan = JSON.parse(
      JSON.stringify(buildPlanFromParams({ household: mfjHousehold, policy: mfjPolicy }).plan),
    )
    const cmp = adapter.compareScenarios(session, { bad: true }, validPlan)
    expect(cmp.ok).toBe(false)
    if (!cmp.ok) expect(cmp.error).toBe('INVALID_PLAN_A')
  })
})

describe('validatePlanJson', () => {
  it('accepts a valid engine plan', () => {
    const planJson = JSON.parse(
      JSON.stringify(buildPlanFromParams({ household: mfjHousehold, policy: mfjPolicy }).plan),
    )
    const res = adapter.validatePlanJson(planJson)
    expect(res.ok).toBe(true)
  })

  it('rejects a malformed plan', () => {
    const res = adapter.validatePlanJson({ not: 'a plan' })
    expect(res.ok).toBe(false)
  })
})

describe('explainModeledResult', () => {
  it('reports no plan for a fresh session', () => {
    const session = createSession(2026)
    const res = adapter.explainModeledResult(session)
    expect(res.ok).toBe(true)
    expect(res.hasPlan).toBe(false)
    expect(res.assumptions).toBeNull()
    expect(typeof res.framing).toBe('string')
    expect(Array.isArray(res.limitations)).toBe(true)
  })

  it('reflects assumptions and caveats once a plan is loaded', () => {
    const session = mfjSession()
    const res = adapter.explainModeledResult(session)
    expect(res.hasPlan).toBe(true)
    expect(res.assumptions).toBeTruthy()
    expect(res.caveats.length).toBeGreaterThan(0)
  })
})

describe('adapter NO_PLAN error branches', () => {
  it('every plan-dependent function reports NO_PLAN on a fresh session', async () => {
    const session = createSession(2026)
    expect(adapter.runProjection(session)).toMatchObject({ ok: false, error: 'NO_PLAN' })
    expect(adapter.runMonteCarlo(session)).toMatchObject({ ok: false, error: 'NO_PLAN' })
    expect(adapter.batchEvaluate(session, [singlePolicy])).toMatchObject({
      ok: false,
      error: 'NO_PLAN',
    })
    expect(adapter.solveMaxSpending(session)).toMatchObject({ ok: false, error: 'NO_PLAN' })
    await expect(adapter.runOptimizer(session)).resolves.toMatchObject({
      ok: false,
      error: 'NO_PLAN',
    })
  })
})

describe('setPlanFromBuild — failed builds do not mutate the session', () => {
  it('leaves the session planless when the build fails validation', () => {
    const session = createSession(2026)
    const res = adapter.setPlanFromBuild(session, {
      household: { ...singleHousehold, horizon: 0 },
      policy: singlePolicy,
    })
    expect(res.ok).toBe(false)
    expect(session.plan).toBeNull()
  })
})
