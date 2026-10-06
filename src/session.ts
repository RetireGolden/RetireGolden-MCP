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

/**
 * Where a session reads "now". Injected rather than read from `new Date()` at
 * each site, so a test (and the protocol baseline) can pin the year while the
 * stdio server runs on the real clock.
 */
export type Clock = () => Date

/** The real clock, which every server and gateway session runs on. */
export const systemClock: Clock = () => new Date()

/**
 * The projection start year a build uses when the caller names none: the
 * clock's calendar year, read on the LOCAL calendar.
 *
 * Through 0.10.0 this was the literal 2026 (`DEFAULT_START_YEAR`), so a plan
 * built or imported without a `startYear` was projected from 2026 forever,
 * while the RetireGolden app projects a user's plan from the current year
 * (planner-ui's `projectionStartYear`) and RetireGolden Pro's MCP host does the
 * same (`guiStartYear()`, `new Date().getFullYear()`). From 1 January 2027 the
 * same document would have answered differently here and in the app. This is
 * the same rule, on the same local calendar, so the two agree on what "this
 * year" is.
 *
 * No tool description names the resulting year: `tools/list` is hashed into
 * the protocol baseline, and a description that moved with the clock would
 * drift every New Year.
 */
export function clockStartYear(clock: Clock): number {
  return clock().getFullYear()
}

export interface SessionState {
  plan: Plan | null
  startYear: number
  caveats: string[]
  conventions: ConventionKnobs
  /**
   * Where this session reads "now": the start year of a `build_plan` that names
   * none, the createdAt/updatedAt stamp on a plan the typed path builds, and the
   * updatedAt stamp `update_plan` advances. @see Clock
   */
  clock: Clock
  /**
   * The most recent `run_projection` output, or null when no projection has run
   * (or `update_plan` invalidated it). `runProjection` is the only writer and it
   * always stores exactly this pair, so typing it saves
   * `explainModeledResult` a runtime `'summary' in ...` narrowing dance over an
   * `unknown` it had itself just produced.
   */
  lastProjection: { result: ProjectionResult; summary: ProjectionSummary } | null
}

export interface CreateSessionOptions {
  /** Where the session reads "now". Defaults to {@link systemClock}. */
  clock?: Clock
}

/**
 * A fresh, empty session. `startYear` is what `get_session` reports before any
 * build; it defaults to the clock's year, and every `build_plan` then sets it
 * (to the caller's `startYear`, or to the clock's year at that build).
 */
export function createSession(startYear?: number, options: CreateSessionOptions = {}): SessionState {
  const clock = options.clock ?? systemClock
  return {
    plan: null,
    startYear: startYear ?? clockStartYear(clock),
    caveats: [],
    conventions: {},
    lastProjection: null,
    clock,
  }
}

export function clearSession(session: SessionState): void {
  session.plan = null
  session.caveats = []
  session.conventions = {}
  session.lastProjection = null
}
