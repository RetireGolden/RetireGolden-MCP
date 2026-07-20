import { describe, expect, it } from 'vitest'
import { createSession } from '../src/session.js'
import { setPlanFromBuild, runProjection, batchEvaluate } from '../src/adapter.js'

const sampleHousehold = {
  filing: 'single' as const,
  state: 'KY',
  persons: [
    {
      birth_year: 1960,
      trad: 800_000,
      roth: 100_000,
      pia: 2500,
      fra_years: 67,
    },
  ],
  taxable: 200_000,
  taxable_basis: 150_000,
  spending: 60_000,
  horizon: 10,
  growth: { trad: 0.05, roth: 0.05, taxable: 0.04 },
  pre_horizon_magi: [50_000, 52_000] as [number, number],
  heir_ordinary_rate: 0.24,
}

const samplePolicy = {
  claim_ages: [67],
  conversion_bracket: 0.22,
  conversion_years: 3,
  ordering: 'taxable-first' as const,
}

describe('adapter', () => {
  it('builds a plan and runs a projection', () => {
    const session = createSession(2026)
    const built = setPlanFromBuild(session, {
      household: sampleHousehold,
      policy: samplePolicy,
      startYear: 2026,
    })
    expect(built.ok).toBe(true)
    expect(session.plan).not.toBeNull()

    const proj = runProjection(session, { detail: 'years' })
    expect(proj.ok).toBe(true)
    if (proj.ok && 'years' in proj) {
      expect(proj.years.length).toBeGreaterThan(0)
      expect(proj.summary).toBeTruthy()
    }
  })

  it('batch_evaluate returns one cell per policy', () => {
    const session = createSession(2026)
    setPlanFromBuild(session, {
      household: sampleHousehold,
      policy: samplePolicy,
      startYear: 2026,
    })
    const batch = batchEvaluate(session, [
      samplePolicy,
      { ...samplePolicy, claim_ages: [70], conversion_years: 0 },
    ])
    expect(batch.ok).toBe(true)
    if (batch.ok) {
      expect(batch.results).toHaveLength(2)
      expect(batch.results.every((r) => r.ok)).toBe(true)
    }
  })
})
