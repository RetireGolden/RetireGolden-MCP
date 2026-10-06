/**
 * The protocol baseline's clock, preloaded into the stdio server it captures.
 *
 * Since 0.11.0 a session reads "now" from an injected clock: the start year of
 * a build that names none follows the calendar (src/session.ts,
 * `clockStartYear`), and `get_session` reports that year before any build. A
 * test injects the clock in process; the protocol baseline cannot, because it
 * talks to `dist/cli.js` in a child process over stdio, and that server runs on
 * the system clock. Unpinned, the committed baseline would drift every
 * 1 January.
 *
 * So scripts/capture-protocol-baseline.mjs starts the child with
 * `node --import <this file>` and sets `RETIREGOLDEN_MCP_BASELINE_NOW` to an ISO
 * instant. This file then moves the child's `Date` to that instant: every
 * `new Date()`, `Date()` and `Date.now()` reads the real time plus a fixed
 * offset, so the calendar is the instant's while time still moves (timers and
 * the optimizer's time budget behave as usual). With the variable unset it does
 * nothing. It is never loaded by the package itself (`scripts/` is not
 * published), and nothing in the server reads the variable.
 *
 * The shifted `Date` is a `Proxy` over the real one, not a subclass, so `Date()`
 * called as a function still returns a string instead of throwing; the engine's
 * rollover clock (RetireGolden `scripts/rollover/shiftClock.setup.mts`) is
 * built the same way.
 */

const target = process.env.RETIREGOLDEN_MCP_BASELINE_NOW
if (target) {
  const RealDate = globalThis.Date
  const targetMs = RealDate.parse(target)
  if (!Number.isFinite(targetMs)) {
    throw new Error(`RETIREGOLDEN_MCP_BASELINE_NOW is not an instant: ${target}`)
  }
  const offsetMs = targetMs - RealDate.now()
  const now = () => RealDate.now() + offsetMs
  globalThis.Date = new Proxy(RealDate, {
    construct(dateTarget, args, newTarget) {
      return Reflect.construct(dateTarget, args.length === 0 ? [now()] : args, newTarget)
    },
    apply(dateTarget) {
      // `Date(...)` ignores its arguments and returns the current time as a string.
      return new dateTarget(now()).toString()
    },
    get(dateTarget, property, receiver) {
      if (property === 'now') return now
      return Reflect.get(dateTarget, property, receiver)
    },
  })
}
