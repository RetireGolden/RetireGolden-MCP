/**
 * export_plan round-trip: build -> export -> validate_plan(exported) ok ->
 * rebuild via plan JSON -> identical projection summary. Proves the exported
 * document is a faithful, re-importable representation of the session plan.
 */

import { describe, expect, it } from 'vitest'
import { PLAN_SCHEMA_VERSION } from '@retiregolden/engine/schema'
import { createSession } from '../src/session.js'
import * as adapter from '../src/adapter.js'
import { buildPlanFromParams } from '../src/buildPlan.js'
import { getTool, validateToolArgs } from '../src/toolTable.js'
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

describe('export_plan provenance stamp', () => {
  function exportedSession() {
    const session = createSession(2026)
    adapter.setPlanFromBuild(session, {
      household: mfjHousehold,
      policy: mfjPolicy,
      startYear: 2026,
    })
    return adapter.exportPlan(session)
  }

  it('stamps the engine plan-schema version the document was written by', () => {
    const exported = exportedSession()
    expect(exported.ok).toBe(true)
    if (!exported.ok) return
    // Sourced from the engine's own export — the same constant describe_plan_schema
    // reports — so the two can never drift apart.
    expect(exported.schemaVersion).toBe(PLAN_SCHEMA_VERSION)
    expect(adapter.describePlanSchema().schemaVersion).toBe(exported.schemaVersion)
  })

  it('reports the same mcp/engine versions get_session does, degrading to null', () => {
    const exported = exportedSession()
    expect(exported.ok).toBe(true)
    if (!exported.ok) return
    const { mcpVersion, engineVersion } = adapter.getVersions()
    expect(exported.mcpVersion).toBe(mcpVersion)
    expect(exported.engineVersion).toBe(engineVersion)
    // Best-effort: a string when resolvable, null when not — never undefined/throwing.
    for (const v of [exported.mcpVersion, exported.engineVersion]) {
      expect(v === null || typeof v === 'string').toBe(true)
    }
  })

  it('keeps every pre-0.4.2 field alongside the new stamp', () => {
    const exported = exportedSession()
    expect(exported.ok).toBe(true)
    if (!exported.ok) return
    expect(Object.keys(exported).sort()).toEqual(
      [
        'caveats',
        'conventions',
        'engineVersion',
        'mcpVersion',
        'ok',
        'plan',
        'schemaVersion',
        'startYear',
      ].sort(),
    )
  })

  it('NO_PLAN is unchanged — nothing to stamp when no plan is loaded', () => {
    const exported = adapter.exportPlan(createSession(2026))
    expect(exported).toEqual({
      ok: false,
      error: 'NO_PLAN',
      message: 'Call build_plan first',
    })
  })
})

describe('build_plan schemaVersion skew (warn, never refuse)', () => {
  function exportedDocument() {
    const session = createSession(2026)
    adapter.setPlanFromBuild(session, {
      household: mfjHousehold,
      policy: mfjPolicy,
      startYear: 2026,
    })
    const exported = adapter.exportPlan(session)
    if (!exported.ok) throw new Error('fixture export failed')
    return exported
  }

  const skew = (caveats: string[]) => caveats.filter((c) => c.startsWith('schemaVersion skew:'))

  it('warns but still imports when the declared schemaVersion differs', () => {
    const exported = exportedDocument()
    const stale = PLAN_SCHEMA_VERSION + 1
    const res = buildPlanFromParams({
      plan: JSON.parse(JSON.stringify(exported.plan)),
      startYear: exported.startYear,
      conventions: exported.conventions,
      schemaVersion: stale,
    })

    // Accepted: skew is never a refusal.
    expect(res.ok).toBe(true)
    expect(res.plan).toBeTruthy()
    expect(res.issues).toBeUndefined()

    const warned = skew(res.caveats)
    expect(warned).toHaveLength(1)
    // Names BOTH versions and says the plan was taken anyway.
    expect(warned[0]).toContain(`v${stale}`)
    expect(warned[0]).toContain(`v${PLAN_SCHEMA_VERSION}`)
    expect(warned[0]).toContain('accepted anyway')
  })

  it('is silent when the declared schemaVersion matches this build', () => {
    const exported = exportedDocument()
    const res = buildPlanFromParams({
      plan: JSON.parse(JSON.stringify(exported.plan)),
      startYear: exported.startYear,
      conventions: exported.conventions,
      schemaVersion: exported.schemaVersion,
    })
    expect(res.ok).toBe(true)
    expect(skew(res.caveats)).toEqual([])
  })

  it('is silent when schemaVersion is absent (pre-0.4.2 documents import unchanged)', () => {
    const exported = exportedDocument()
    const planJson = JSON.parse(JSON.stringify(exported.plan))
    const matching = buildPlanFromParams({
      plan: planJson,
      startYear: 2026,
      schemaVersion: PLAN_SCHEMA_VERSION,
    })
    const without = buildPlanFromParams({ plan: planJson, startYear: 2026 })
    expect(without.ok).toBe(true)
    expect(skew(without.caveats)).toEqual([])
    expect(without.issues).toBeUndefined()
    // An unversioned document is indistinguishable from a matching one.
    expect(without.caveats).toEqual(matching.caveats)
  })

  it('spreading a whole export_plan response back into build_plan round-trips cleanly', () => {
    // The documented round-trip: the export's siblings ARE build_plan's args.
    const exported = exportedDocument()
    const res = buildPlanFromParams({
      plan: JSON.parse(JSON.stringify(exported.plan)),
      startYear: exported.startYear,
      conventions: exported.conventions,
      schemaVersion: exported.schemaVersion,
    })
    expect(res.ok).toBe(true)
    expect(res.caveats).toEqual([])
  })

  it('ignores schemaVersion on the typed path (no document was supplied)', () => {
    const res = buildPlanFromParams({
      household: mfjHousehold,
      policy: mfjPolicy,
      startYear: 2026,
      schemaVersion: PLAN_SCHEMA_VERSION + 1,
    })
    expect(res.ok).toBe(true)
    expect(skew(res.caveats)).toEqual([])
  })

  it('accepts schemaVersion through the build_plan tool arg schema', () => {
    const entry = getTool('build_plan')!
    expect(
      validateToolArgs(entry, { plan: { anything: true }, schemaVersion: PLAN_SCHEMA_VERSION + 1 }),
    ).toBeNull()
    // An unknown/extra sibling must not break the existing validation either.
    expect(validateToolArgs(entry, { plan: { anything: true }, someFutureKey: 'x' })).toBeNull()
  })
})
