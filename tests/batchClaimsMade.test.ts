/**
 * batch_evaluate and claims already made (engine 0.4.0,
 * `socialSecurity/openClaims`). A claim counts as made when its claim year,
 * birth year plus the claim age's whole years, is before the plan's start year.
 * Such a claim is history: the engine holds it fixed in every claim-age search,
 * so a batch row keeps it and says so. A requested claim age whose claim year
 * is before the start year would be a backdated claim, which the engine's
 * claim-age grid never offers, so that row fails with the reason.
 */

import { describe, expect, it } from 'vitest'
import * as adapter from '../src/adapter.js'
import { createSession } from '../src/session.js'
import { singleHousehold, singlePolicy } from './fixtures.js'

/** The single fixture (born 1960) built with a stored claim at `claimAge`, from 2026. */
function sessionClaimingAt(claimAge: number) {
  const session = createSession(2026)
  const built = adapter.setPlanFromBuild(session, {
    household: singleHousehold,
    policy: { ...singlePolicy, claim_ages: [claimAge] },
    startYear: 2026,
  })
  expect(built.ok).toBe(true)
  return session
}

describe('batch_evaluate and Social Security claims already made', () => {
  it('holds a claim made before the start year fixed, and says so on a row that asked for another age', () => {
    // Claimed at 62 in 2022, before the plan starts in 2026.
    const session = sessionClaimingAt(62)
    const batch = adapter.batchEvaluate(session, [
      { ...singlePolicy, claim_ages: [62] },
      { ...singlePolicy, claim_ages: [67] },
    ])
    if (!batch.ok) throw new Error('batch failed')
    const [kept, asked] = batch.results
    expect(kept!.ok && asked!.ok).toBe(true)
    // The claim is the plan's history, so both rows price the same claim.
    expect(asked!.objective).toBe(kept!.objective)
    const note = asked!.caveats.find((c) => c.includes('already claimed Social Security'))
    expect(note).toBeDefined()
    expect(note).toContain("person 'person-0'")
    expect(note).toContain('at 62y0m in 2022, before this plan starts in 2026')
    expect(note).toContain('does not apply the requested claim age 67')
    // Asking for the age it was claimed at changes nothing and says nothing.
    expect(kept!.caveats.some((c) => c.includes('already claimed Social Security'))).toBe(false)
    // The session plan itself is untouched.
    const stored = session.plan!.incomes.find((inc) => inc.type === 'socialSecurity')
    expect(stored?.type === 'socialSecurity' ? stored.claimAge : null).toEqual({ years: 62, months: 0 })
  })

  it('fails a row that asks for a claim age already passed, naming the earliest still open', () => {
    // Stored claim at 67 (2027) is still a choice; 64 would be a claim in 2024.
    const session = sessionClaimingAt(67)
    const batch = adapter.batchEvaluate(session, [
      { ...singlePolicy, claim_ages: [64] },
      { ...singlePolicy, claim_ages: [66] },
    ])
    if (!batch.ok) throw new Error('batch failed')
    const [backdated, open] = batch.results
    expect(backdated!.ok).toBe(false)
    expect(backdated!.objective).toBeNull()
    expect(backdated!.error).toContain("person 'person-0'")
    expect(backdated!.error).toContain('a claim at 64 falls in 2024, before this plan starts in 2026')
    expect(backdated!.error).toContain('the earliest claim age still open is 66')
    // 66 is the age reached in 2026: still open, so the row is priced.
    expect(open!.ok).toBe(true)
    expect(typeof open!.objective).toBe('number')
  })
})
