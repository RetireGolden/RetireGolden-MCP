/**
 * In-memory MCP session: one plan + convention knobs per connection/process.
 * No disk I/O — suitable for ephemeral bench runs and local stdio clients.
 */

import type { Plan, ProjectionResult, summarizeProjection } from '@retiregolden/engine'

/**
 * The engine's projection summary. Named here via `ReturnType` because the
 * engine publishes `summarizeProjection` from its package root but not the
 * `ProjectionSummary` interface itself, and this import is type-only — nothing
 * from the engine is pulled in at runtime.
 */
type ProjectionSummary = ReturnType<typeof summarizeProjection>

export interface ConventionKnobs {
  /** When set, freeze tax-law parameters at this calendar year (best-effort). */
  lawSunsetFreezeYear?: number | null
  /**
   * Two distinct pre-projection IRMAA lookback MAGIs [Y-2, Y-1].
   * These are mapped to the engine's year-keyed historical MAGI assumptions;
   * recentAnnualMagi retains the first value as a compatibility fallback.
   */
  irmaaLookbackMagis?: [number, number] | null
  /**
   * Withdrawal sequence preference. `traditional-first` is not fully supported
   * by the engine sequential drain; adapter records caveats.
   */
  withdrawalOrdering?: 'taxable-first' | 'traditional-first' | 'proportional' | null
}

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
 * CHANGING THIS VALUE IS A WIRE CHANGE and not a one-line edit. Several
 * `tools/list` descriptions in src/toolTable.ts name 2026 in prose
 * ("a non-2026 session's projection would diverge"), and those descriptions are
 * hashed into tests/protocol-baseline/baseline.json's inventory. They are plain
 * strings, not interpolations, so moving the year means editing them in the
 * same change and regenerating the baseline deliberately. Interpolating them
 * would itself be a wire-visible change and belongs in its own commit.
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
