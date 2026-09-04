/**
 * Monte Carlo ending-balance percentiles: shape (p10..p90 numeric and monotone
 * non-decreasing) and determinism under a fixed seed.
 */

import { describe, expect, it } from 'vitest'
import * as adapter from '../src/adapter.js'
import { mfjSession as session } from './helpers/session.js'

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

  it('echoes the three run inputs, defaulting pathCount/seed/returnVolPct', () => {
    const defaults = adapter.runMonteCarlo(session())
    expect(defaults.ok).toBe(true)
    if (!defaults.ok) return
    expect(defaults.pathCount).toBe(200)
    expect(defaults.seed).toBe(42)
    expect(defaults.returnVolPct).toBe(12)

    const configured = adapter.runMonteCarlo(session(), {
      pathCount: 64,
      seed: 7,
      returnVolPct: 25,
    })
    expect(configured.ok).toBe(true)
    if (!configured.ok) return
    expect(configured.pathCount).toBe(64)
    expect(configured.seed).toBe(7)
    expect(configured.returnVolPct).toBe(25)
  })

  it('a different returnVolPct moves the percentiles', () => {
    const calm = adapter.runMonteCarlo(session(), { pathCount: 100, seed: 7, returnVolPct: 2 })
    const wild = adapter.runMonteCarlo(session(), { pathCount: 100, seed: 7, returnVolPct: 30 })
    expect(calm.ok && wild.ok).toBe(true)
    if (!calm.ok || !wild.ok) return
    // Same seed and path count: only the volatility differs, and it reaches the
    // market model rather than being accepted and dropped.
    expect(wild.percentiles).not.toEqual(calm.percentiles)
    expect(wild.percentiles.p90 - wild.percentiles.p10).toBeGreaterThan(
      calm.percentiles.p90 - calm.percentiles.p10,
    )
  })

  // The tool description promises `returnVolPct: 0` "makes every path
  // deterministic apart from inflation". Pinned, because it is a public claim
  // about behaviour that lives in the engine, not in this package: at 0 the
  // RETURN draw is gone, so the ending-balance spread collapses to a sliver of
  // the default run's — but it is not zero, and it still moves with the seed,
  // because the lognormal model keeps drawing inflation.
  it('returnVolPct 0 removes the return draw but not the inflation draw', () => {
    const flat = adapter.runMonteCarlo(session(), { pathCount: 100, seed: 7, returnVolPct: 0 })
    const dflt = adapter.runMonteCarlo(session(), { pathCount: 100, seed: 7 })
    const otherSeed = adapter.runMonteCarlo(session(), { pathCount: 100, seed: 99, returnVolPct: 0 })
    expect(flat.ok && dflt.ok && otherSeed.ok).toBe(true)
    if (!flat.ok || !dflt.ok || !otherSeed.ok) return

    expect(flat.returnVolPct).toBe(0)
    const flatSpread = flat.percentiles.p90 - flat.percentiles.p10
    const defaultSpread = dflt.percentiles.p90 - dflt.percentiles.p10
    expect(flatSpread).toBeGreaterThan(0)
    // Two orders of magnitude narrower: the returns no longer vary at all.
    expect(flatSpread).toBeLessThan(defaultSpread / 10)
    // ...but "apart from inflation" is load-bearing — paths are not identical.
    expect(otherSeed.percentiles).not.toEqual(flat.percentiles)
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
