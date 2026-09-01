/**
 * "Copy plan for your AI", end to end against the real contract.
 *
 * Ported from planner-ui/src/data/planForAi.roundtrip.test.ts, which used to
 * live beside the browser serializer with `@retiregolden/mcp` as a dev
 * dependency. That put the only dependency edge between the two repos in the
 * wrong direction: the MCP is the consumer of the browser's payload and pins
 * `@retiregolden/engine`, so planner-ui ended up dev-depending on a package that
 * dev-depends back on it. Here the arrow points one way — this repo depends on
 * `@retiregolden/planner-ui`, never the reverse — and the guard runs against the
 * LOCAL adapter, so a change to `build_plan` fails in the same PR that made it
 * rather than waiting for the next npm release to reach the other repo.
 *
 * The trade the move costs, stated plainly: the browser side is now the
 * *published* planner-ui, so a serializer change lands here one release late.
 * `tests/browserParity.test.ts` covers the complementary direction (the tax
 * stack, reconstructed from the engine); this file covers the payload.
 *
 * What it pins is the acceptance criterion: the copied payload, passed to
 * `build_plan`, reproduces the plan and the projection the app is showing.
 * `startYear` is the reason it exists — `build_plan` defaults to the literal
 * 2026 while the planner projects from the current year, so an unstamped payload
 * agrees with the app all through 2026 and silently diverges on 2027-01-01. The
 * negative controls below are as load-bearing as the positive one.
 *
 * Two things are asserted, and they are separate claims. First, that the rebuilt
 * plan re-projected through the browser's OWN stack reproduces the app's ledger —
 * that the payload loses nothing. Second (the block at the bottom), that this
 * package's `run_projection` returns the same summary — that an assistant handed
 * this payload reports the numbers the user is looking at.
 *
 * The second claim was false through 0.4.2, which ran a federal-only tax stack
 * against the browser's federal+state one. Keep them separate: a future payload
 * bug and a future tax-stack regression should fail on different lines.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { parsePlan, type Plan } from '@retiregolden/engine/model/plan'
import { migratePlanToCurrent } from '@retiregolden/engine/model/migrations'
import { PLAN_SCHEMA_VERSION } from '@retiregolden/engine/schema'
// `testSupport/samplePlan` is a deprecated one-line re-export that planner-ui
// means to keep out of its tarball, so import the builder it forwards to.
import { buildExampleCouple as createSamplePlan } from '@retiregolden/planner-ui/planner/examples/buildExampleCouple'
// The app reads these through `planner/useProjection`, which only re-exports
// them from here and adds a React hook this headless suite cannot load.
import { currentStartYear, projectPlan } from '@retiregolden/planner-ui/projection'
import { serializeSinglePlan, type SinglePlanExport } from '@retiregolden/planner-ui/plan-format'

import * as adapter from '../src/adapter.js'
import { buildPlanFromParams, type BuildPlanInput } from '../src/buildPlan.js'
import { createSession } from '../src/session.js'
import { TOOL_TABLE } from '../src/toolTable.js'

/**
 * The plan type the PUBLISHED planner-ui produces — whatever engine it binds,
 * which is not necessarily this package's. Today planner-ui 0.9.0 resolves
 * engine ^0.1.12 (plan schema v4) while this package pins 0.2.0 (v5), so the
 * two `Plan` types genuinely differ on `schemaVersion`, and a value that
 * came out of planner-ui is typed as such rather than cast into ours. The day
 * planner-ui republishes on the same engine this alias collapses to `Plan`
 * and nothing here needs to change.
 */
type BrowserPlan = ReturnType<typeof createSamplePlan>

/**
 * The browser's document exactly as `build_plan` would store it: brought
 * forward to this build's schema by the engine's own migration, which is the
 * path a pasted payload actually takes. Comparing `built.plan` against the raw
 * browser object instead would fail on every field a migration writes — today
 * `schemaVersion`, and `inflationAdjusted` on any one-time income — and would
 * be asserting that `build_plan` does NOT migrate, which is the opposite of
 * its contract.
 */
function asThisBuildStoresIt(plan: BrowserPlan): Plan {
  const migrated = migratePlanToCurrent(plan)
  expect(migrated.ok, migrated.ok ? '' : `browser plan did not migrate: ${migrated.reason}`).toBe(true)
  if (!migrated.ok) throw new Error('unreachable')
  return migrated.plan
}

/** The plan-schema version a browser payload's DOCUMENT declares about itself. */
function documentSchemaVersion(payload: SinglePlanExport): number {
  const v = (payload.plan as { schemaVersion?: unknown }).schemaVersion
  if (typeof v !== 'number') throw new Error('browser payload carries no numeric plan.schemaVersion')
  return v
}

/** Exactly what the toolbar button puts on the clipboard, parsed back. */
function copiedPayload(plan: BrowserPlan, startYear: number): SinglePlanExport {
  return JSON.parse(serializeSinglePlan(plan, startYear)) as SinglePlanExport
}

/**
 * The `build_plan` argument schema the transports actually enforce — stdio
 * builds `z.object(tool.inputShape)` and the HTTP gateway validates against the
 * same shape.
 */
const buildPlanArgs = z.object(TOOL_TABLE.find((t) => t.name === 'build_plan')!.inputShape)

/**
 * `build_plan` with the payload spread straight in, as the paste instruction says.
 *
 * Routed through the tool-layer schema first, not straight into
 * `buildPlanFromParams`. A pasted payload never reaches `buildPlanFromParams`
 * directly — it arrives as `tools/call` arguments and is parsed by
 * `z.object(inputShape)` on the way in. Calling the function directly would let
 * a serializer that is no longer a *valid `build_plan` argument* (a stringified
 * `startYear`, a renamed sibling) sail past this suite while failing for a real
 * assistant. Parsing here means the acceptance criterion is tested on the path
 * the user's paste actually takes.
 *
 * Scope of the gate, so nobody reads more into it: it checks the SIBLINGS.
 * `plan` is `z.unknown()` in the shape by design — the engine's `parsePlan` is
 * the real document validator and `build_plan` warns rather than refuses — so a
 * malformed plan still arrives as `issues`, not as a parse failure here.
 */
function buildFrom(payload: SinglePlanExport | Partial<BuildPlanInput>) {
  const parsed = buildPlanArgs.safeParse(payload)
  expect(
    parsed.success,
    parsed.success ? '' : `payload is not a valid build_plan argument: ${parsed.error.message}`,
  ).toBe(true)
  return buildPlanFromParams((parsed.success ? parsed.data : payload) as BuildPlanInput)
}

/**
 * Assert the payload introduced no skew **of its own**.
 *
 * A `schemaVersion` skew caveat would be the browser's bug — it stamps that from
 * the same constant the document carries. An `engineVersion` skew caveat is only
 * a bug when both sides are actually running the same engine. They often are
 * not: this package *exact-pins* an engine version while planner-ui takes a
 * range, so from the moment the engine publishes a release until this package
 * re-pins, a correctly-stamped payload legitimately triggers the provenance
 * warning — which is the warning doing its job, not a defect.
 *
 * So this reproduces the comparison `pushEngineSkewCaveat` actually makes — the
 * stamp **the payload carries** against **this package's installed engine** —
 * rather than asserting the caveat away. Blanket-asserting no skew would couple
 * this file to another repo's release cadence and turn every engine patch into a
 * red test here, which would teach the next person to delete the assertion.
 *
 * Take the stamp from the payload, never from a local `ENGINE_VERSION` import —
 * which is why this file no longer imports one. In planner-ui's tree that
 * constant was the *browser's* engine, so the two sides were genuinely different
 * copies. Imported here it would resolve to this package's engine, so comparing
 * the two would be this package reading itself: the `===` branch would always
 * win and the skew branch would be dead code.
 *
 * As of engine 0.2.0 the two readings DISAGREE, and in the direction this note
 * did not predict: our exact pin rose past planner-ui's floor, not the other
 * way round. planner-ui 0.9.0 still declares `^0.1.12`, which no longer
 * matches, so pnpm keeps a second engine copy nested under it and its payloads
 * are stamped by that copy — engine 0.1.12, plan schema v4. The skew branch
 * below is therefore live today, not dead code, and the `documentVersion`
 * parameter carries the same lag on the schema axis. Both collapse back to
 * the agreeing case, with no change here, once planner-ui republishes on a
 * range that admits 0.2.0.
 */
function expectNoPayloadSkew(caveats: string[], stampedEngine: string, documentVersion: number) {
  const mcpEngine = adapter.getVersions().engineVersion

  // A `schemaVersion skew:` caveat is still always the payload's fault: it means
  // the sibling label disagreed with the document it travelled with, and the
  // browser stamps both from one constant.
  expect(caveats.filter((c) => c.includes('schemaVersion skew:'))).toEqual([])

  // A `plan-schema migration:` caveat is the SCHEMA analogue of engine lag, and
  // gets the same treatment rather than being asserted away: while the published
  // planner-ui binds an older engine, its documents legitimately arrive one
  // schema version behind and `build_plan` migrates them. That is the warning
  // doing its job. So: no migration when the versions agree, and exactly one —
  // naming both versions, so a reader can tell lag from a mis-stamped document —
  // when they do not. Never zero in the lag case; silent migration would hide
  // exactly the drift this file exists to keep visible.
  const migration = caveats.filter((c) => c.includes('plan-schema migration:'))
  if (documentVersion === PLAN_SCHEMA_VERSION) {
    expect(migration).toEqual([])
  } else {
    expect(migration).toHaveLength(1)
    expect(migration[0]).toContain(`v${documentVersion}`)
    expect(migration[0]).toContain(`v${PLAN_SCHEMA_VERSION}`)
  }

  const engineSkew = caveats.filter((c) => c.includes('engineVersion skew:'))
  if (mcpEngine === stampedEngine) {
    expect(engineSkew).toEqual([])
  } else {
    // Different engines: exactly one caveat, and it must name both so a reader
    // can tell a release lag from a mis-stamped payload.
    expect(engineSkew).toHaveLength(1)
    expect(engineSkew[0]).toContain(stampedEngine)
    expect(engineSkew[0]).toContain(String(mcpEngine))
  }
}

describe('copied plan → build_plan', () => {
  it('rebuilds the same plan and start year, with no version skew', () => {
    const plan = createSamplePlan()
    const view = projectPlan(plan)
    const payload = copiedPayload(plan, view.startYear)
    const built = buildFrom(payload)

    expect(built.issues ?? []).toEqual([])
    expect(built.ok).toBe(true)
    expect(built.plan).toEqual(asThisBuildStoresIt(plan))
    expect(built.startYear).toBe(view.startYear)
    // Filtered to skew rather than asserting no caveats at all — since 0.5.0 an
    // imported document also reports that the resident state's income tax is
    // modeled, which is a true statement about this KY plan and not a defect in
    // the payload.
    expectNoPayloadSkew(built.caveats, payload.engineVersion, documentSchemaVersion(payload))
  })

  it('reproduces the projection the results page is showing', () => {
    const plan = createSamplePlan()
    const shown = projectPlan(plan)
    const built = buildFrom(copiedPayload(plan, shown.startYear))
    expect(built.ok && built.plan).toBeTruthy()

    // Re-project the REBUILT plan at the REBUILT start year. Same ledger, year
    // for year, not just the same headline number.
    const currentPlan = parsePlan(built.plan)
    expect(currentPlan.ok, currentPlan.ok ? '' : currentPlan.issues.join('; ')).toBe(true)
    // `currentPlan.plan` is this build's `Plan`; `projectPlan` is the published
    // browser's and is typed for the plan ITS engine produces. The cast is the
    // cross-engine comparison this test exists to make, and it is sound at
    // runtime for two checked reasons: planner-ui's `projectPlan` does not
    // re-validate the document (no `parsePlan` in its projection entry), and the
    // example couple carries no field that exists only in the newer schema. If
    // either stops being true this test fails loudly rather than the cast
    // hiding it — `toEqual` below compares the whole ledger.
    const rebuilt = projectPlan(
      (currentPlan.ok ? currentPlan.plan : plan) as unknown as BrowserPlan,
      built.startYear,
    )
    expect(rebuilt.result).toEqual(shown.result)
    expect(rebuilt.summary).toEqual(shown.summary)
  })

  it('survives a plan with every exotic corner filled in', () => {
    // Prove the wrapper is agnostic to plan content. The fixture already carries
    // the awkward corners — `insurance` (whole life + two LTC policies),
    // `careEvents`, and an `expenses.oneTimeGoals` entry — see
    // planner-ui/src/planner/examples/buildExampleCouple.ts. This adds the one
    // corner it lacks, `scenarios`, so all four are in the object under test and
    // a serializer that dropped any of them fails the `toEqual` below.
    const plan = createSamplePlan()
    plan.scenarios = [{ id: 'scen-1', name: 'Higher inflation', patch: { 'assumptions.inflationPct': 3 } }]
    // Well-formedness is checked by migrating, not by `parsePlan` on this
    // build's engine: that would reject the browser's document for its
    // `schemaVersion` alone. The browser's OWN object is what gets serialized,
    // so the sibling stamp and the embedded version agree exactly as they do
    // for a real paste.
    const stored = asThisBuildStoresIt(plan)
    const payload = copiedPayload(plan, 2029)
    const built = buildFrom(payload)
    expect(built.ok).toBe(true)
    expect(built.plan).toEqual(stored)
    expect(built.startYear).toBe(2029)
    expectNoPayloadSkew(built.caveats, payload.engineVersion, documentSchemaVersion(payload))
  })
})

describe("this package's own run_projection", () => {
  /**
   * The other half of the acceptance criterion. The payload being faithful (above)
   * only pays off if the assistant reading it then reports the numbers the user is
   * looking at.
   *
   * Through 0.4.2 it did not. `run_projection` ran `createFederalTaxCalculator()`
   * alone while the browser runs federal COMBINED WITH the engine's modeled state
   * pack (`taxCalculatorFor` in planner-ui/src/planTaxCalculator.ts), so for this
   * KY couple the MCP overstated ending net worth by ~13%. `browserParity.test.ts`
   * guards the stack by reconstruction; this guards it against the browser's real
   * serializer and the browser's real projection entry point.
   *
   * Equality is over the WHOLE summary rather than the headline: two tax stacks can
   * agree on ending net worth while disagreeing on lifetime taxes or the estate
   * breakdown.
   */
  it('reproduces the projection the browser is showing', () => {
    const plan = createSamplePlan()
    const shown = projectPlan(plan)
    const session = createSession()
    adapter.setPlanFromBuild(session, copiedPayload(plan, shown.startYear) as BuildPlanInput)
    const viaMcp = adapter.runProjection(session)
    expect(viaMcp.ok).toBe(true)
    if (!viaMcp.ok) return

    expect(viaMcp.summary).toEqual(shown.summary)

    // What makes the assertion above discriminating: a resident of a state that
    // taxes income. In FL or TX the two stacks agree trivially and this test would
    // have passed against the federal-only bug. Note `stateEffectiveTaxPct: 0` does
    // NOT mean "no state tax" — the engine reads 0 as "use the modeled KY pack".
    expect(plan.household.state).toBe('KY')
    expect(plan.assumptions.stateEffectiveTaxPct).toBe(0)
  })
})

describe('the siblings are load-bearing, not decoration', () => {
  it('emits the start year the app actually projected from', () => {
    const plan = createSamplePlan()
    const view = projectPlan(plan)
    expect(copiedPayload(plan, view.startYear).startYear).toBe(currentStartYear())
  })

  it('would diverge from the app if startYear were dropped', () => {
    // The bug this field prevents, made explicit: without it build_plan falls
    // back to the literal 2026. Assert both halves — the fallback value, and
    // that projecting from a different year is a materially different plan.
    const plan = createSamplePlan()
    const { startYear, ...withoutStartYear } = copiedPayload(plan, 2031)
    expect(startYear).toBe(2031)

    const built = buildFrom(withoutStartYear)
    expect(built.startYear).toBe(2026)
    expect(projectPlan(plan, 2026).result.endingNetWorth).not.toBeCloseTo(
      projectPlan(plan, 2031).result.endingNetWorth,
      2,
    )
  })

  it('stamps the engine that produced the document, and a wrong one is caught', () => {
    const plan = createSamplePlan()
    const payload = copiedPayload(plan, 2026)
    // `schemaVersion` needs pinning as a PRESENT stamp, not just a matching one.
    // `pushCallerSchemaSkewCaveat` fires only when the sibling is present and
    // disagrees, so a serializer that dropped the field entirely would emit no
    // caveat and slide past `expectNoPayloadSkew` unnoticed.
    expect(payload.schemaVersion).toBe(plan.schemaVersion)

    // A real engine version, not a placeholder and not some other field.
    // Deliberately NOT compared to `@retiregolden/engine/version`'s
    // `ENGINE_VERSION`: that constant is OUR engine, and the browser stamps ITS
    // own, so asserting equality would make this file go red the moment
    // planner-ui's engine range moves off our exact pin — the same
    // release-cadence coupling `expectNoPayloadSkew` is written to avoid. The
    // teeth are in the negative control below, which proves `build_plan` really
    // reads this field as an engine version.
    expect(payload.engineVersion).toMatch(/^\d+\.\d+\.\d+/)

    // The provenance warning is the entire point of stamping it: a document
    // exported under a different engine still imports, but says so.
    const skewed = buildFrom({ ...payload, engineVersion: '0.0.1-ancient' })
    expect(skewed.ok).toBe(true)
    expect(skewed.caveats.join(' ')).toContain('engineVersion skew')
  })

  it('sends no `conventions`, so the MCP applies its own end-user defaults', () => {
    // Deliberate absence (see serializeSinglePlan). The knobs are benchmark
    // session overrides with no browser meaning; emitting `{}` or `null` would
    // assert a posture the user never chose. Pin that the payload has no such
    // key and that the import is clean without one.
    const payload = copiedPayload(createSamplePlan(), 2026)
    expect('conventions' in (payload as object)).toBe(false)
    const caveats: string[] = buildFrom(payload).caveats
    expectNoPayloadSkew(caveats, payload.engineVersion, documentSchemaVersion(payload))
    // Nothing about conventions either — the absence must not read as a posture.
    expect(caveats.some((c) => c.includes('convention'))).toBe(false)
  })
})
