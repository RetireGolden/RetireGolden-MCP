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

  it('defaults the start year to 2026', () => {
    expect(createSession().startYear).toBe(2026)
  })

  it('clearSession resets plan, caveats, conventions, and lastProjection', () => {
    const session = createSession(2026)
    adapter.setPlanFromBuild(session, {
      household: singleHousehold,
      policy: singlePolicy,
      conventions: { withdrawalOrdering: 'proportional' },
    })
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
    // startYear is intentionally preserved across a clear
    expect(session.startYear).toBe(2026)
  })

  it('setPlanFromBuild records caveats and the built start year on the session', () => {
    const session = createSession(2026)
    adapter.setPlanFromBuild(session, {
      household: singleHousehold,
      policy: singlePolicy,
      startYear: 2030,
    })
    expect(session.startYear).toBe(2030)
    // distinct pre-horizon MAGIs produce the IRMAA-lookback caveat
    expect(session.caveats.some((c) => c.startsWith('IRMAA-lookback'))).toBe(true)
  })
})
