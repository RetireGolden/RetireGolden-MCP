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

/**
 * Provenance skew on re-import. Two INDEPENDENT signals, and the distinction is
 * the point:
 *
 *  - `plan.schemaVersion` INSIDE the document is what the engine's parsePlan gates
 *    on (`z.literal(PLAN_SCHEMA_VERSION)`). A document genuinely written by a
 *    build on another plan schema carries that version, so it cannot be validated
 *    here at all — build_plan explains the mismatch instead of leaking a bare zod
 *    issue, and hands an older document to the engine's migratePlanToCurrent first.
 *  - the `schemaVersion` / `engineVersion` SIBLING args are provenance labels. They
 *    never refuse: a mismatch is a caveat on an accepted import. engineVersion is
 *    the skew that can really occur between two builds that can exchange documents
 *    at all (same plan schema, different defaults/semantics).
 */
describe('build_plan provenance skew (sibling labels warn, never refuse)', () => {
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

  /** A fresh, current-schema document — the thing a caller actually re-imports. */
  function currentDocument() {
    return JSON.parse(JSON.stringify(exportedDocument().plan)) as Record<string, unknown>
  }

  const skew = (caveats: string[]) => caveats.filter((c) => c.includes('skew:'))

  const callerSkewCaveat = (declared: number) =>
    `schemaVersion skew: caller-declared plan-schema v${declared} does not match this build's v${PLAN_SCHEMA_VERSION}; ` +
    `the supplied document itself validated as v${PLAN_SCHEMA_VERSION} and was accepted unchanged — ` +
    'check that the schemaVersion argument came from the same export_plan response as the plan.'

  // Both directions AND the falsy edge (PLAN_SCHEMA_VERSION - 1 is 0 today, which
  // also pins that the guard tests `== null`, not truthiness). A `declared >
  // PLAN_SCHEMA_VERSION` rewrite of the condition must fail on the low case.
  it.each([PLAN_SCHEMA_VERSION - 1, PLAN_SCHEMA_VERSION + 1, PLAN_SCHEMA_VERSION + 7])(
    'warns but still imports when the caller declares schemaVersion v%i',
    (declared) => {
      const res = buildPlanFromParams({
        plan: currentDocument(),
        startYear: 2026,
        schemaVersion: declared,
      })

      // Accepted: a provenance label is never a refusal.
      expect(res.ok).toBe(true)
      expect(res.plan).toBeTruthy()
      expect(res.issues).toBeUndefined()

      // Exact text, not substrings: a message that transposes the two versions
      // tells the agent the opposite of the truth about which side is stale.
      expect(res.caveats).toEqual([callerSkewCaveat(declared)])
    },
  )

  it('attributes the mismatch to the caller, not to the document', () => {
    // The document just passed parsePlan, which pins its embedded schemaVersion to
    // the installed version — so it demonstrably does NOT declare the skewed value.
    const doc = currentDocument()
    expect(doc.schemaVersion).toBe(PLAN_SCHEMA_VERSION)
    const res = buildPlanFromParams({
      plan: doc,
      startYear: 2026,
      schemaVersion: PLAN_SCHEMA_VERSION + 1,
    })
    expect(res.caveats[0]).toMatch(
      new RegExp(`caller-declared plan-schema v${PLAN_SCHEMA_VERSION + 1}`),
    )
    // It must not tell the user their (perfectly current) document is stale.
    expect(res.caveats[0]).not.toMatch(/document declares plan-schema/)
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
    const planJson = currentDocument()
    const matching = buildPlanFromParams({
      plan: planJson,
      startYear: 2026,
      schemaVersion: PLAN_SCHEMA_VERSION,
    })
    const without = buildPlanFromParams({ plan: planJson, startYear: 2026 })
    expect(without.ok).toBe(true)
    expect(skew(without.caveats)).toEqual([])
    expect(without.issues).toBeUndefined()
    // An unversioned import is indistinguishable from a matching one.
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
      engineVersion: exported.engineVersion ?? undefined,
      mcpVersion: exported.mcpVersion ?? undefined,
    })
    expect(res.ok).toBe(true)
    expect(res.caveats).toEqual([])
  })

  it('ignores provenance siblings on the typed path (no document was supplied)', () => {
    const res = buildPlanFromParams({
      household: mfjHousehold,
      policy: mfjPolicy,
      startYear: 2026,
      schemaVersion: PLAN_SCHEMA_VERSION + 1,
      engineVersion: '9.9.9',
    })
    expect(res.ok).toBe(true)
    expect(skew(res.caveats)).toEqual([])
  })
})

describe('build_plan engineVersion skew (the skew that can really happen)', () => {
  function currentDocument() {
    const session = createSession(2026)
    adapter.setPlanFromBuild(session, {
      household: mfjHousehold,
      policy: mfjPolicy,
      startYear: 2026,
    })
    const exported = adapter.exportPlan(session)
    if (!exported.ok) throw new Error('fixture export failed')
    return JSON.parse(JSON.stringify(exported.plan)) as Record<string, unknown>
  }

  it('warns but still imports when the document came from a different engine build', () => {
    const installed = adapter.getVersions().engineVersion
    expect(installed).not.toBeNull()
    const res = buildPlanFromParams({
      plan: currentDocument(),
      startYear: 2026,
      schemaVersion: PLAN_SCHEMA_VERSION,
      engineVersion: '0.1.3',
    })
    expect(res.ok).toBe(true)
    expect(res.issues).toBeUndefined()
    expect(res.caveats).toEqual([
      'engineVersion skew: the supplied plan document was exported under @retiregolden/engine 0.1.3 ' +
        `but this build runs ${installed}; the document was imported unchanged, but engine defaults ` +
        'and modeling semantics can differ between versions — re-run the projection here rather than ' +
        'comparing against numbers produced by the exporting build.',
    ])
  })

  it('is silent when the engineVersion matches, and when it is absent', () => {
    const installed = adapter.getVersions().engineVersion!
    const matching = buildPlanFromParams({
      plan: currentDocument(),
      startYear: 2026,
      engineVersion: installed,
    })
    const absent = buildPlanFromParams({ plan: currentDocument(), startYear: 2026 })
    expect(matching.ok).toBe(true)
    expect(matching.caveats).toEqual([])
    expect(absent.caveats).toEqual([])
  })

  it('reports schemaVersion and engineVersion skew independently', () => {
    const res = buildPlanFromParams({
      plan: currentDocument(),
      startYear: 2026,
      schemaVersion: PLAN_SCHEMA_VERSION + 1,
      engineVersion: '0.1.3',
    })
    expect(res.ok).toBe(true)
    expect(res.caveats).toHaveLength(2)
    expect(res.caveats[0]).toMatch(/^schemaVersion skew:/)
    expect(res.caveats[1]).toMatch(/^engineVersion skew:/)
  })
})

describe('build_plan cross-schema documents (the engine validator, explained)', () => {
  function currentDocument() {
    const session = createSession(2026)
    adapter.setPlanFromBuild(session, {
      household: mfjHousehold,
      policy: mfjPolicy,
      startYear: 2026,
    })
    const exported = adapter.exportPlan(session)
    if (!exported.ok) throw new Error('fixture export failed')
    return JSON.parse(JSON.stringify(exported.plan)) as Record<string, unknown>
  }

  it('explains a document written by a NEWER plan schema instead of leaking a zod message', () => {
    // What export_plan on a future build actually emits: the embedded schemaVersion
    // and the sibling agree, and both are ahead of this build.
    const doc = { ...currentDocument(), schemaVersion: PLAN_SCHEMA_VERSION + 1 }
    const res = buildPlanFromParams({
      plan: doc,
      startYear: 2026,
      schemaVersion: PLAN_SCHEMA_VERSION + 1,
    })

    // The engine's validator cannot read another schema — that refusal is real and
    // is NOT dressed up as an acceptance.
    expect(res.ok).toBe(false)
    expect(res.plan).toBeUndefined()
    const issues = res.issues ?? []
    // The explanation comes FIRST, names both versions and the remedy...
    expect(issues[0]).toMatch(
      new RegExp(
        `^plan-schema skew: the supplied document declares plan-schema v${PLAN_SCHEMA_VERSION + 1} ` +
          `but this build validates v${PLAN_SCHEMA_VERSION} —`,
      ),
    )
    expect(issues[0]).toContain('NEWER build')
    expect(issues[0]).toContain('newer_than_app')
    expect(issues[0]).not.toContain('accepted')
    // ...and the engine's own issue is still reported underneath it.
    expect(issues.slice(1)).toEqual([
      `schemaVersion: Invalid input: expected ${PLAN_SCHEMA_VERSION}`,
    ])
    // A refusal is not a caveat; nothing is claimed to have been imported.
    expect(res.caveats).toEqual([])
  })

  it('explains an OLDER-schema document the installed engine cannot upgrade', () => {
    const doc = { ...currentDocument(), schemaVersion: 0 }
    const res = buildPlanFromParams({ plan: doc, startYear: 2026 })
    expect(res.ok).toBe(false)
    const first = (res.issues ?? [])[0] ?? ''
    expect(first).toMatch(/^plan-schema skew: the supplied document declares plan-schema v0/)
    expect(first).toContain('could not upgrade it')
    // Read off the DOCUMENT — no sibling argument was supplied at all.
    expect(first).toContain(`v${PLAN_SCHEMA_VERSION}`)
  })

  it('leaves every non-version parse failure byte-identical to before', () => {
    // Same schemaVersion as this build, but structurally invalid: no skew wording,
    // just the engine's issues, exactly as pre-0.4.2.
    const doc = { ...currentDocument(), accounts: 'not-an-array' }
    const res = buildPlanFromParams({ plan: doc, startYear: 2026 })
    expect(res.ok).toBe(false)
    expect((res.issues ?? []).some((i) => i.includes('plan-schema skew'))).toBe(false)
    expect(res.caveats).toEqual([])

    // ...and a document with NO schemaVersion field at all is likewise untouched:
    // it fails on the engine's literal, with no skew commentary invented for it.
    const unversioned = currentDocument()
    delete unversioned.schemaVersion
    const res2 = buildPlanFromParams({ plan: unversioned, startYear: 2026 })
    expect(res2.ok).toBe(false)
    expect(res2.issues).toEqual([`schemaVersion: Invalid input: expected ${PLAN_SCHEMA_VERSION}`])
  })
})

describe('build_plan provenance args reach the handler (wiring, not just the pure fn)', () => {
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

  it('declares the provenance siblings in the zod inputShape', () => {
    // Load-bearing: the MCP SDK passes the PARSED args to the handler and zod
    // strips undeclared keys, so deleting any of these silently disables the
    // feature over stdio while every other test still passes.
    const shape = getTool('build_plan')!.inputShape
    expect(Object.keys(shape)).toEqual(
      expect.arrayContaining(['schemaVersion', 'engineVersion', 'mcpVersion']),
    )
  })

  it.each([
    ['schemaVersion', 'v1'],
    ['schemaVersion', 1.5],
    ['schemaVersion', true],
    ['engineVersion', 7],
    ['mcpVersion', 7],
  ])('rejects a mistyped %s (%p) — only possible while the field is declared', (key, value) => {
    const entry = getTool('build_plan')!
    expect(validateToolArgs(entry, { plan: { anything: true }, [key]: value })).not.toBeNull()
  })

  it('accepts well-typed provenance siblings', () => {
    const entry = getTool('build_plan')!
    expect(
      validateToolArgs(entry, {
        plan: { anything: true },
        schemaVersion: PLAN_SCHEMA_VERSION + 1,
        engineVersion: '0.1.3',
        mcpVersion: '0.4.1',
      }),
    ).toBeNull()
  })

  it('tolerates unknown siblings (forward compatibility, NOT a declaration check)', () => {
    const entry = getTool('build_plan')!
    expect(validateToolArgs(entry, { plan: { anything: true }, someFutureKey: 'x' })).toBeNull()
  })

  it('propagates the caveat through the tool handler into the session and back out', () => {
    const exported = exportedDocument()
    const session = createSession(2026)
    const res = getTool('build_plan')!.handler(session, {
      plan: JSON.parse(JSON.stringify(exported.plan)),
      startYear: exported.startYear,
      schemaVersion: PLAN_SCHEMA_VERSION + 1,
      engineVersion: '0.1.3',
    }) as { ok: boolean; caveats: string[] }

    expect(res.ok).toBe(true)
    expect(res.caveats.filter((c) => c.includes('skew:'))).toHaveLength(2)
    // setPlanFromBuild must copy them onto the session, or no later response shows them.
    expect(session.caveats).toEqual(res.caveats)
    // ...which is what run_projection and export_plan surface.
    const projected = adapter.runProjection(session) as { ok: boolean; caveats: string[] }
    expect(projected.caveats.filter((c) => c.includes('skew:'))).toHaveLength(2)
    const reExported = adapter.exportPlan(session)
    expect(reExported.ok).toBe(true)
    if (!reExported.ok) return
    expect(reExported.caveats.filter((c) => c.includes('skew:'))).toHaveLength(2)
  })
})
