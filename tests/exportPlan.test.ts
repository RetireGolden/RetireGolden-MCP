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
})
