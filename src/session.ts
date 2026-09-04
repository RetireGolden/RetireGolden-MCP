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

export function createSession(startYear = 2026): SessionState {
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
