/**
 * run_projection detail option: default 'summary' omits the per-year array;
 * 'years' restores the old full-ledger shape. Both carry an identical summary.
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

describe('run_projection detail option', () => {
  it("default response has no years array", () => {
    const proj = adapter.runProjection(session())
    expect(proj.ok).toBe(true)
    expect('years' in proj).toBe(false)
  })

  it("detail:'summary' explicitly also omits the years array", () => {
    const proj = adapter.runProjection(session(), { detail: 'summary' })
    expect(proj.ok).toBe(true)
    expect('years' in proj).toBe(false)
  })

  it("detail:'years' restores the full per-year ledger", () => {
    const proj = adapter.runProjection(session(), { detail: 'years' })
    expect(proj.ok).toBe(true)
    if (!proj.ok || !('years' in proj)) throw new Error('expected years')
    expect(proj.years).toHaveLength(15) // 2026..2040
    expect(proj.years[0]!.year).toBe(2026)
    // per-year ledger carries the expected fields
    const y0 = proj.years[0]!
    for (const k of ['tax', 'penalties', 'magi', 'rothConversion', 'withdrawals', 'shortfall']) {
      expect(k in y0).toBe(true)
    }
  })

  it('both detail modes carry an identical summary', () => {
    const summaryOnly = adapter.runProjection(session(), { detail: 'summary' })
    const withYears = adapter.runProjection(session(), { detail: 'years' })
    expect(summaryOnly.ok && withYears.ok).toBe(true)
    if (summaryOnly.ok && withYears.ok) {
      expect(summaryOnly.summary).toEqual(withYears.summary)
      expect(summaryOnly.startYear).toBe(withYears.startYear)
      expect(summaryOnly.endYear).toBe(withYears.endYear)
    }
  })
})
