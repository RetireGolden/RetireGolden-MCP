/**
 * In-memory MCP session: one plan + convention knobs per connection/process.
 * No disk I/O — suitable for ephemeral bench runs and local stdio clients.
 */

import type { Plan } from '@retiregolden/engine'

export interface ConventionKnobs {
  /** When set, freeze tax-law parameters at this calendar year (best-effort). */
  lawSunsetFreezeYear?: number | null
  /**
   * Two distinct pre-projection IRMAA lookback MAGIs [Y-2, Y-1].
   * Engine currently exposes one scalar; we seed recentAnnualMagi from the
   * first value and record a caveat when they differ.
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
  lastProjection: unknown | null
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
