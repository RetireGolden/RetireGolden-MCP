/**
 * `solve_max_spending`'s SPENDING_SOLVER_FAILED arm.
 *
 * The failure shape is wire-visible and, as of 0.10.0, carries `caveats` like
 * `run_optimizer`'s failure arm does. Nothing else in the suite reaches it: the
 * fixture plans all converge, so the only way in is to make the engine's solver
 * throw. Hence a dedicated file — `vi.mock` is hoisted to module scope and would
 * otherwise stub the solver for every other test in the file.
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('@retiregolden/engine/decisions/spendingSolver', () => ({
  solveMaxSustainableSpending: () => {
    throw new Error('solver did not converge')
  },
}))

const adapter = await import('../src/adapter.js')
const { mfjSession } = await import('./helpers/session.js')

describe('solveMaxSpending failure arm', () => {
  it('returns SPENDING_SOLVER_FAILED with the session caveats attached', () => {
    const session = mfjSession()
    // The fixture build records at least one caveat, so an empty array here
    // would prove nothing about whether the field is actually populated.
    expect(session.caveats.length).toBeGreaterThan(0)

    const res = adapter.solveMaxSpending(session)
    expect(res.ok).toBe(false)
    // Narrow past the NO_PLAN arm, which carries no caveats.
    if (res.ok || res.error !== 'SPENDING_SOLVER_FAILED') throw new Error('expected solver failure')
    expect(res.message).toContain('solver did not converge')
    expect(res.caveats).toEqual(session.caveats)
  })

  it('attaches a SNAPSHOT, not the live session array', () => {
    const session = mfjSession()
    const res = adapter.solveMaxSpending(session)
    expect(res.ok).toBe(false)
    if (res.ok || res.error !== 'SPENDING_SOLVER_FAILED') throw new Error('expected solver failure')
    // `error` widens to `string` on both failure arms (no `as const`), so the
    // union does not discriminate and `caveats` stays optional to the compiler.
    const caveats = res.caveats!
    expect(caveats).toBeDefined()

    const before = [...caveats]
    session.caveats.push('a caveat added after the call')
    expect(caveats).toEqual(before)

    caveats.push('mutating the response')
    expect(session.caveats).not.toContain('mutating the response')
  })
})
