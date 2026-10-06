import { describe, expect, it } from 'vitest'
import { clearSession, createSession } from '../src/session.js'
import * as adapter from '../src/adapter.js'
import { singleHousehold, singlePolicy } from './fixtures.js'

describe('session helpers', () => {
  it('createSession seeds an empty, planless session at the given start year', () => {
    const session = createSession(2031)
    expect(session.plan).toBeNull()
    expect(session.startYear).toBe(2031)
    expect(session.caveats).toEqual([])
    expect(session.conventions).toEqual({})
    expect(session.lastProjection).toBeNull()
  })

  it("defaults the start year to the injected clock's year", () => {
    // Through 0.10.0 the default was the literal 2026. tests/startYear.test.ts
    // covers the clock in full; this pins that createSession reads it.
    expect(createSession(undefined, { clock: () => new Date(2034, 6, 1) }).startYear).toBe(2034)
  })

  it('clearSession resets plan, caveats, conventions, lastProjection and the start year', () => {
    // Pinned to 2026 at creation; the build moves the session to 2030.
    const session = createSession(2026, { clock: () => new Date(2026, 5, 15) })
    adapter.setPlanFromBuild(session, {
      household: singleHousehold,
      policy: singlePolicy,
      startYear: 2030,
      conventions: { withdrawalOrdering: 'proportional' },
    })
    expect(session.startYear).toBe(2030)
    adapter.runProjection(session)
    // sanity: the session is now populated
    expect(session.plan).not.toBeNull()
    expect(session.lastProjection).not.toBeNull()
    expect(session.conventions).toEqual({ withdrawalOrdering: 'proportional' })

    clearSession(session)
    expect(session.plan).toBeNull()
    expect(session.caveats).toEqual([])
    expect(session.conventions).toEqual({})
    expect(session.lastProjection).toBeNull()
    // The start year goes back to the session's default, not the last build's:
    // here the year pinned at creation.
    expect(session.startYear).toBe(2026)
  })

  it("clearSession returns an unpinned session to the clock's year", () => {
    const session = createSession(undefined, { clock: () => new Date(2033, 5, 15) })
    adapter.setPlanFromBuild(session, { household: singleHousehold, policy: singlePolicy, startYear: 2030 })
    expect(session.startYear).toBe(2030)
    clearSession(session)
    expect(session.startYear).toBe(2033)
  })

  it('setPlanFromBuild records the built start year and exact MAGI history', () => {
    const session = createSession(2026)
    adapter.setPlanFromBuild(session, {
      household: singleHousehold,
      policy: singlePolicy,
      startYear: 2030,
    })
    expect(session.startYear).toBe(2030)
    expect(session.plan!.assumptions.historicalAnnualMagiByYear).toEqual({
      '2028': 50_000,
      '2029': 52_000,
    })
    expect(session.caveats.some((c) => c.startsWith('IRMAA-lookback'))).toBe(false)
  })
})
