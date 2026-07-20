/**
 * Monte Carlo ending-balance percentiles: shape (p10..p90 numeric and monotone
 * non-decreasing) and determinism under a fixed seed.
 */

import { describe, expect, it } from 'vitest'
import { createSession } from '../src/session.js'
import * as adapter from '../src/adapter.js'
import { mfjHousehold, mfjPolicy } from './fixtures.js'

function session() {
  const s = createSession(2026)
  const built = adapter.setPlanFromBuild(s, { household: mfjHousehold, policy: mfjPolicy })
  expect(built.ok).toBe(true)
  return s
}

describe('run_monte_carlo percentiles', () => {
  it('returns numeric, monotone p10..p90', () => {
    const mc = adapter.runMonteCarlo(session(), { pathCount: 100, seed: 7 })
    expect(mc.ok).toBe(true)
    if (!mc.ok) return
    const p = mc.percentiles
    for (const key of ['p10', 'p25', 'p50', 'p75', 'p90'] as const) {
      expect(typeof p[key]).toBe('number')
      expect(Number.isFinite(p[key])).toBe(true)
    }
    expect(p.p10).toBeLessThanOrEqual(p.p25)
    expect(p.p25).toBeLessThanOrEqual(p.p50)
    expect(p.p50).toBeLessThanOrEqual(p.p75)
    expect(p.p75).toBeLessThanOrEqual(p.p90)
  })

  it('is deterministic under a fixed seed', () => {
    const a = adapter.runMonteCarlo(session(), { pathCount: 100, seed: 7 })
    const b = adapter.runMonteCarlo(session(), { pathCount: 100, seed: 7 })
    expect(a.ok && b.ok).toBe(true)
    if (a.ok && b.ok) {
      expect(a.percentiles).toEqual(b.percentiles)
    }
  })
})
