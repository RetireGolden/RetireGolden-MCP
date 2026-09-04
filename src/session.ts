/**
 * In-memory MCP session: one plan + convention knobs per connection/process.
 * No disk I/O — suitable for ephemeral bench runs and local stdio clients.
 */

import type { Plan, ProjectionResult, summarizeProjection } from '@retiregolden/engine'
import type { ConventionKnobs } from './buildPlan.js'

/**
 * The convention knobs a session stores. Defined in src/buildPlan.ts, next to
 * the zod schema `build_plan` validates them with and that they are derived
 * from, and re-exported here (type-only, so nothing is imported at runtime)
 * because `SessionState` and the package root have always named it from this
 * module.
 */
export type { ConventionKnobs }

/**
 * The engine's projection summary. Named here via `ReturnType` because the
 * engine publishes `summarizeProjection` from its package root but not the
 * `ProjectionSummary` interface itself, and this import is type-only — nothing
 * from the engine is pulled in at runtime.
 */
type ProjectionSummary = ReturnType<typeof summarizeProjection>

export interface SessionState {
  plan: Plan | null
  startYear: number
  caveats: string[]
  conventions: ConventionKnobs
  /**
   * The most recent `run_projection` output, or null when no projection has run
   * (or `update_plan` invalidated it). `runProjection` is the only writer and it
   * always stores exactly this pair, so typing it saves
   * `explainModeledResult` a runtime `'summary' in ...` narrowing dance over an
   * `unknown` it had itself just produced.
   */
  lastProjection: { result: ProjectionResult; summary: ProjectionSummary } | null
}

/**
 * The projection start year a session (and a build) assumes when the caller
 * names none.
 *
 * One definition for what were three separate `2026` literals:
 * `createSession`'s default, `buildPlanFromParams`'s `input.startYear ?? 2026`,
 * and `buildTypedPlan`'s frozen `now()` clock — the createdAt/updatedAt stamp on
 * a freshly built plan, which is pinned rather than `new Date()` so a build is
 * reproducible.
 *
 * CHANGING THIS VALUE IS A WIRE CHANGE and not a one-line edit. Exactly one
 * `tools/list` description names 2026 in prose — `export_plan`'s "a non-2026
 * session's projection will diverge" in src/toolTable.ts — and that description
 * is hashed into tests/protocol-baseline/baseline.json's inventory. It is a
 * plain string, not an interpolation, so moving the year means editing it in
 * the same change and regenerating the baseline deliberately. Interpolating it
 * would itself be a wire-visible change and belongs in its own commit.
 *
 * It also stamps `createdAtIso`/`updatedAtIso` on every newly built plan, via
 * `buildTypedPlan`'s frozen clock — INCLUDING plans built with an explicit
 * `startYear`, which do not otherwise depend on this constant. That coupling is
 * deliberate (one literal, not two) and pinned by
 * tests/buildPlan.test.ts's "frozen build clock" case, so moving the year moves
 * those timestamps and that test with it.
 */
export const DEFAULT_START_YEAR = 2026

export function createSession(startYear: number = DEFAULT_START_YEAR): SessionState {
  return {
    plan: null,
    startYear,
    caveats: [],
    conventions: {},
    lastProjection: null,
  }
}

export function clearSession(session: SessionState): void {
  session.plan = null
  session.caveats = []
  session.conventions = {}
  session.lastProjection = null
}
