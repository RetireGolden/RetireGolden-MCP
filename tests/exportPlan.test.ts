/**
 * export_plan round-trip: build -> export -> validate_plan(exported) ok ->
 * rebuild via plan JSON -> identical projection summary. Proves the exported
 * document is a faithful, re-importable representation of the session plan.
 */

import { describe, expect, it } from 'vitest'
import { createSession } from '../src/session.js'
import * as adapter from '../src/adapter.js'
import { buildPlanFromParams } from '../src/buildPlan.js'
import { mfjHousehold, mfjPolicy } from './fixtures.js'

describe('export_plan round-trip', () => {
  it('exports a plan that validates and rebuilds to an identical projection', () => {
    const session = createSession(2026)
    const built = adapter.setPlanFromBuild(session, {
      household: mfjHousehold,
      policy: mfjPolicy,
      startYear: 2026,
    })
    expect(built.ok).toBe(true)

    const original = adapter.runProjection(session)
    expect(original.ok).toBe(true)

    // export
    const exported = adapter.exportPlan(session)
    expect(exported.ok).toBe(true)
    if (!exported.ok) return

    // the exported document validates as an engine plan
    const planJson = JSON.parse(JSON.stringify(exported.plan))
    const validated = adapter.validatePlanJson(planJson)
    expect(validated.ok).toBe(true)

    // rebuild via the plan-JSON branch of build_plan
    const rebuild = buildPlanFromParams({ plan: planJson, startYear: 2026 })
    expect(rebuild.ok).toBe(true)

    const session2 = createSession(2026)
    session2.plan = rebuild.plan!
    session2.startYear = rebuild.startYear
    const reprojected = adapter.runProjection(session2)
    expect(reprojected.ok).toBe(true)

    if (original.ok && reprojected.ok) {
      expect(reprojected.summary).toEqual(original.summary)
    }
  })

  it('surfaces startYear + conventions and round-trips a non-2026 session identically', () => {
    // Build a session that does NOT start in the default year 2026. Because the
    // Roth-conversion window is baked into the plan JSON relative to startYear, a
    // re-import that forgets startYear would project from 2026 and diverge. The
    // export now carries startYear so the round-trip is faithful.
    const session = createSession(2032)
    const built = adapter.setPlanFromBuild(session, {
      household: mfjHousehold,
      policy: mfjPolicy,
      startYear: 2032,
    })
    expect(built.ok).toBe(true)

    const original = adapter.runProjection(session)
    expect(original.ok).toBe(true)

    const exported = adapter.exportPlan(session)
    expect(exported.ok).toBe(true)
    if (!exported.ok) return
    // The export echoes the session timing/knobs needed to re-import faithfully.
    expect(exported.startYear).toBe(2032)
    expect(exported.conventions).toBeDefined()

    // Re-import passing exported.startYear -> identical projection summary.
    const rebuild = buildPlanFromParams({
      plan: JSON.parse(JSON.stringify(exported.plan)),
      startYear: exported.startYear,
      conventions: exported.conventions,
    })
    expect(rebuild.ok).toBe(true)

    const session2 = createSession(exported.startYear)
    session2.plan = rebuild.plan!
    session2.startYear = rebuild.startYear
    const reprojected = adapter.runProjection(session2)
    expect(reprojected.ok).toBe(true)

    if (original.ok && reprojected.ok) {
      expect(reprojected.summary).toEqual(original.summary)
      expect(reprojected.startYear).toBe(2032)
    }
  })

  it('returns a clone — mutating the exported plan does not touch the live session', () => {
    const session = createSession(2026)
    adapter.setPlanFromBuild(session, {
      household: mfjHousehold,
      policy: mfjPolicy,
      startYear: 2026,
    })
    const exported = adapter.exportPlan(session)
    expect(exported.ok).toBe(true)
    if (!exported.ok) return
    const before = session.plan!.expenses.baseAnnual
    // Mutate the exported document in place, as a programmatic consumer might.
    exported.plan.expenses.baseAnnual = before + 999_999
    expect(session.plan!.expenses.baseAnnual).toBe(before)
    expect(exported.plan).not.toBe(session.plan)
  })
})
