# Changelog

All notable changes to `@retiregolden/mcp` are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

## Unreleased

Internal adapter hygiene. **No change to any tool's wire output or to
`tools/list` descriptions** — the protocol baseline
(`tests/protocol-baseline/baseline.json`) is unmoved.

### Changed (programmatic embedders only)

- `BuildPlanResult` (exported from the package root) is now a discriminated
  union on `ok` instead of one interface with optional `plan`/`issues`:
  `{ ok: true; plan; startYear; endYear?; caveats; ordering_unsupported? }`
  or `{ ok: false; startYear; caveats; issues; ordering_unsupported? }`.
  Runtime shape is identical — the same fields were already present or absent
  on the same branches — but TypeScript now narrows on `result.ok` alone.
  Embedders that read `result.plan` without checking `result.ok` (or that
  wrote `result.plan!`) will see a type error; guard on `result.ok` first.
- Every handler now returns COPIES of `session.caveats` and
  `session.conventions` rather than the live values. `export_plan` already
  did; `run_projection`, `run_monte_carlo`, `batch_evaluate`, `run_optimizer`,
  `solve_max_spending`, `explain_modeled_result`, `update_plan` and
  `get_session` now do too. A consumer that relied on mutating a returned
  `caveats` array to edit the live session no longer can — that was never the
  documented contract.
- The same now holds for the other two session-owned objects that reached a
  response by reference: `run_projection`'s `summary` (which is also cached on
  the session) and `explain_modeled_result`'s `assumptions` (the live plan's)
  and `lastProjectionSummary`. `build_plan` also deep-copies the `conventions`
  it is given, so a caller that keeps its own `irmaaLookbackMagis` tuple can no
  longer mutate live session conventions through it.
- `adapter.snapshotCaveats(session)` and `adapter.snapshotConventions(session)`
  are exported (via the `adapter` namespace) for embedders composing their own
  handlers on the same isolation terms.
- `SessionState.lastProjection` is typed as
  `{ result: ProjectionResult; summary: ProjectionSummary } | null` instead of
  `unknown | null`.
- `DEFAULT_START_YEAR` (2026) is exported from the package root.

### Changed (HTTP research transport only — opt-in, loopback-only)

- Each `startHttpGateway()` instance now owns its session store and releases
  it when the server closes; sessions are also swept on a 60-second timer
  (`unref()`'d) in addition to the existing per-request sweep. Two gateways
  in one process no longer share sessions or a `MAX_SESSIONS` cap. Error
  codes, TTL, and cap semantics are unchanged.
- A tool handler that throws now answers `500 { error: 'TOOL_FAILED' }` and
  logs the exception to stderr, instead of echoing the exception text on the
  wire.
- A failed bind (`EADDRINUSE` on the default port, say) now rejects the
  `startHttpGateway()` promise and releases the sweep timer, instead of raising
  an unhandled `'error'` event that takes down the process without telling the
  caller the gateway is not listening.
- `GET /health` reports `transport: 'http-research'` (was `'http-stub'`), and
  the undocumented `azure` alias for `http` is gone from `src/cli.ts` — which is
  the published `retiregolden-mcp` bin. The repo-root `bin/retiregolden-mcp.js`
  launcher still accepts it; that file is deleted separately. The stdio server
  and every MCP tool are untouched.

### Changed (tooling and tests only)

Nothing below reaches the published runtime; the protocol baseline and every
golden literal are unmoved.

- The dual-era MCP client harness lives in `tests/helpers/eraHarness.ts`. The
  checkout suite and the packed-artifact release gate share that one copy
  instead of carrying near-identical clients.
- `pnpm run goldens:print` (`scripts/gen-goldens.mjs`) is committed: the
  generator that prints the golden numbers in `tests/goldens.test.ts`, so a
  deliberate engine bump can be re-derived rather than hand-transcribed.
- `resolveInstalledPackageVersion` is one walk-up resolver shared with
  `scripts/capture-protocol-baseline.mjs`, not two copies.
- `fast-uri` is raised to 3.1.7 through `pnpm.overrides` (4 high Dependabot
  alerts). It is a transitive dev-only dependency, reached through the v1 MCP
  SDK's `ajv`.
- `dist/` is built once per vitest run by a `globalSetup`
  (`tests/globalSetup.ts`), replacing the per-file `pnpm run build` spawns in
  the dist-backed suites. Those spawns raced on CI, where `pnpm test` runs
  before `pnpm run build`; `ensureBuild()` now only asserts freshness. The
  freshness check is content-based (a digest of `src/**/*.ts` plus the package
  version, cached under `node_modules/.cache/`), falling back to mtimes, so a
  `dist/` left over from another HEAD is rebuilt rather than trusted.

## 0.9.1

**Updates the exact `@retiregolden/engine` dependency from 0.2.0 to 0.3.0, and
the `@retiregolden/planner-ui` dev dependency from 0.9.0 to 0.10.0.** A patch,
because nothing this server publishes changes shape: the plan schema stays v5,
the tool inventory hash and the `plan-schema` resource hash are unchanged, and
every engine-numeric step in the protocol baseline is byte-identical.

### Changed

- The exact engine pin moves 0.2.0 → 0.3.0, and no modeled number moves with
  it: the golden-number suite passes unchanged and every engine-numeric step
  in the protocol baseline is byte-identical across the bump (see
  **Verified**). Neither new engine field (`netPortfolioNeed`, `refusalCode`)
  is read or served anywhere in this package.
- The engine's Plan JSON Schema is now read from
  `@retiregolden/engine/schema/current`, the entry point the engine documents
  for the common case, rather than the legacy `/schema` compatibility barrel
  (which now evaluates every historical generated schema on import). Same
  constants, same bytes; `describe_plan_schema` and the resource are unaffected.
- The dev tree carries exactly one engine copy again: planner-ui 0.10.0
  resolves `^0.3.0`, which this package's exact pin satisfies. The round-trip
  test's engine-lag and schema-migration branches are therefore idle rather
  than live; the test keeps both, and its comments now say which state is
  current and why both survive.

### Verified

- The protocol baseline was regenerated **deliberately** and inspected leaf by
  leaf before being trusted. Of 25 recorded envelopes, exactly six moved
  (`get_session` ×3, `export_plan` ×2, `explain_modeled_result`), and in each
  the only differing leaf is `engineVersion: "0.2.0" → "0.3.0"`; the
  `build_plan` round-trip step's argument digest moved for the same reason
  (it spreads that stamp back in). `run_projection`, `run_monte_carlo`,
  `batch_evaluate`, `run_optimizer`, `solve_max_spending`, `compare_scenarios`,
  `update_plan`, both `describe_plan_schema` payloads, and the round-trip
  summaries are unchanged. The golden-number suite passes without
  regeneration.

### Why this release exists

Engine 0.3.0 publishes two additive `YearResult` fields (`netPortfolioNeed`
and a `refusalCode` on inherited-account evidence), prunes 29 unused
`./actions/<name>` export subpaths (this package imports none of them; every
subpath it does import still resolves), and moves `decisionFixtures` to
`./testing/`. None of that reaches this server's wire surface, so this is a
coordination release: RetireGolden Pro can advance its shared engine copy to
0.3.0 without the MCP sidecar retaining a nested 0.2.0, and the 0.9.0 note
about planner-ui lagging on `^0.1.12` is closed.

## 0.9.0

**Updates the exact `@retiregolden/engine` dependency from 0.1.12 to 0.2.0,
which carries plan schema v5.** A minor rather than the patch this repository
usually ships an engine bump as, because the contract this server serves
changed shape: the Plan JSON Schema now REQUIRES `inflationAdjusted` on a
`oneTime` income stream, and `export_plan` stamps `schemaVersion: 5`.

### Changed

- Keep MCP calculations aligned with engine 0.2.0.
- `describe_plan_schema` (and the `plan-schema` resource) report plan schema
  **v5** with `schemaId` `https://retiregolden.org/schemas/plan/v5.json`. The
  complete v4 → v5 difference in the served artifact, taken from a leaf-level
  diff of the two `describe_plan_schema` payloads rather than from memory:
  - `properties.incomes.items`, the `oneTime` variant: a **required** boolean
    `inflationAdjusted`, the election `recurring` always had. `true` reads the
    amount as today's dollars grown to the year it pays; `false` reads it as
    that year's dollars, taken as written. This is the change that made v5
    a version.
  - `properties.accounts.items`, the `traditional` variant: an **optional**
    `employerPlanType` (`401k` | `403b` | `457b`).
  - `properties.accounts.items`, the `traditional` and `roth` variants: an
    **optional** `inherited.decedentId` string.
  The two account fields are additive and arrived in the engine between
  0.1.12 and 0.2.0 (IRC §4974 RMD shortfall excise work) without a schema
  bump; they appear here because the artifact is the whole schema as of
  0.2.0. Nothing was removed.
- `build_plan` with full plan JSON: a document written against v1–v4 still
  migrates in (the engine writes `inflationAdjusted: false` onto any pre-v5
  one-time income, preserving what it already projected). A document that
  declares `schemaVersion: 5` must carry the field, or `parsePlan` reports it in
  `issues[]` as before. Nothing on the typed `household`/`policy` path changes;
  it never authored a one-time income.
- The `retiregolden` skill's plan-JSON reference now documents the election on
  both income kinds, and no longer claims `schemaVersion` must be `1` — that
  was already stale, since the engine migrates any version it has shipped.

### Verified

- The protocol baseline was regenerated **deliberately**, and inspected
  before being trusted: across all 25 recorded tool envelopes, every
  engine-numeric step — `run_projection`, `run_monte_carlo` (seeded),
  `batch_evaluate`, `run_optimizer`, `solve_max_spending`,
  `compare_scenarios`, `update_plan`, and both round-trip summaries — is
  **byte-identical** to the 0.1.12 baseline. What moved is exactly the
  `engineVersion` stamp (`0.1.12` → `0.2.0`), the `schemaVersion` stamps
  (`4` → `5`), and the two `describe_plan_schema` payloads. No number changed.
- That is the expected shape for engine 0.2.0 **on this fixture**: a retired
  household with pensions and Social Security, no one-time income, default
  horizon. Its two behaviour changes — one-time income stops paying after the
  last household death, and the new election — cannot reach that fixture;
  everything else between the two tags is extraction the engine verified
  byte-identical in its own differential. A plan that authors one-time
  income, or runs stochastic longevity, can project differently on 0.2.0.
  That is the engine change, not baseline drift, and it is why the baseline
  was regenerated rather than the engine pinned back.

### Why this release exists

Engine 0.2.0 is the first breaking engine release (a required new field is
not additive). Until this package re-pinned, `describe_plan_schema` taught
assistants the v4 shape while the engine on `main` had moved to v5. This
release brings the served schema and the installed engine back into
lockstep **with each other**.

The web app is a separate axis, and it is NOT yet in lockstep: the published
`@retiregolden/planner-ui` 0.9.0 still resolves engine `^0.1.12` and writes
`schemaVersion: 4` documents. A payload copied from the app now migrates in
with a `plan-schema migration:` caveat — correct behaviour, visibly reported.
That gap closes when planner-ui republishes on `^0.2.0`.

**Known lag, by design:** `tests/planForAiRoundtrip.test.ts` runs the copied
payload through the *published* `@retiregolden/planner-ui` (0.9.0), which
still resolves engine `^0.1.12` and therefore stamps `schemaVersion: 4`. The
dev tree carries both engines until planner-ui republishes on `^0.2.0`; the
shipped artifact installs exactly one (0.2.0), which `test:packed` asserts.
The round-trip test treats that v4 → v5 migration as the release lag it is
rather than a payload defect, mirroring how it already treats engine-version
lag — and it stays non-vacuous by asserting the migration is reported, not
silent.

## 0.8.0

**Migrates the stdio server to the TypeScript MCP SDK v2, serving both 2025-era
and 2026-07-28 clients from the same command.** No tool names, schemas, or
calculation behavior change. Ordinary stdio configs (`npx -y @retiregolden/mcp`,
the `retiregolden-mcp` bin) are unchanged.

### Breaking (programmatic embedders only)

- Embedders that constructed a v1 `McpServer` from `@modelcontextprotocol/sdk`
  and passed it to `registerTools` must construct a v2 `McpServer` from
  `@modelcontextprotocol/server` instead — v1 server objects can no longer be
  passed in. `registerTools` / `registerResources` / `EDUCATIONAL` /
  `jsonResult` names and signatures are otherwise unchanged. Stdio users are
  unaffected.

### Changed

- Runtime depends on `@modelcontextprotocol/server` ^2.0.0. `startStdioServer`
  uses `serveStdio` so one factory instance is pinned per connection after the
  opening exchange selects the era (legacy `initialize`, or modern
  `server/discover`). Tool definitions do not fork by era.
- A `tools/call` whose `arguments` field is omitted was rejected by the v1 SDK's
  validation and now validates as `{}` (SDK v2 behavior). Affects no known client
  (normal clients always send `arguments`); listed for completeness.

## 0.7.5

**Updates the exact `@retiregolden/engine` dependency from 0.1.11 to 0.1.12.**

### Changed

- Keep MCP calculations aligned with engine 0.1.12.
- Workspace tooling switched from npm to pnpm (no published-artifact change).

### Why this release exists

Engine 0.1.12 ships the IRC §414(v)(7) high-earner designated Roth catch-up
for contribution years 2026+ (with its §415(c) exclusion and the
compensation-minus-other-electives cap), the Plan v4 schema carrying
`priorCalendarYearFicaWages`, and §408(d)(8)(A) post-70½ QCD offset
corrections on the aggregate `qcdAnnual` arm. This coordination release lets
RetireGolden Pro advance its shared engine copy to 0.1.12 (planner-ui 0.9.0
requires it) without the MCP sidecar retaining a nested engine 0.1.11.

## 0.7.4

**Updates the exact `@retiregolden/engine` dependency from 0.1.10 to 0.1.11.**

### Changed

- Keep MCP calculations aligned with engine 0.1.11.

### Why this release exists

Engine 0.1.11 ships the insight detector-governance contract (finding-level
severity, structured evidence tuples, detector versioning), the completed
advisory detector catalog, and the published per-entity facts layer — all
observation-only, with no projection-behavior change; the golden numbers are
verified unchanged under the new pin. This coordination release lets
RetireGolden Pro advance its shared engine copy to 0.1.11 without the MCP
sidecar retaining a nested engine 0.1.10.

## 0.7.3

**Updates the exact `@retiregolden/engine` dependency from 0.1.9 to 0.1.10.**

### Changed

- Keep MCP calculations aligned with engine 0.1.10.

### Why this release exists

RetireGolden Pro consumes the engine, planner UI, and MCP packages together and
requires them to resolve one shared engine copy. Engine 0.1.10 adds the advisor
tax cockpit's engine-side scenario surfaces — the `TaxOpportunityView` per-year
evidence/action view and the `TaxStrategyTradeoffs` seven-dimension comparison —
with no projection-behavior change; the golden numbers are verified unchanged
under the new pin. This coordination release prevents the MCP sidecar from
retaining a nested engine 0.1.9 while the desktop calculation surface advances
to 0.1.10.

## 0.7.2

**Updates the exact `@retiregolden/engine` dependency from 0.1.8 to 0.1.9.**

### Changed

- Keep MCP calculations aligned with engine 0.1.9.

### Why this release exists

RetireGolden Pro consumes the engine, planner UI, and MCP packages together and
requires them to resolve one shared engine copy. Engine 0.1.9 carries the
retirement-action execution-source-integrity work (named conversion, ordinary
withdrawal, and QCD sourcing), inherited-IRA compliance depth, the
tax-exempt-interest SS/MAGI cascade, per-donor QCD limits, IRA-funded annuity
staging, and the new `TaxStrategyEvaluation` strategy contract; this
coordination release prevents the MCP sidecar from retaining a nested engine
0.1.8 while the desktop calculation surface advances to 0.1.9.

## 0.7.1

**Updates the exact `@retiregolden/engine` dependency from 0.1.7 to 0.1.8.**

### Changed

- Keep MCP calculations aligned with engine 0.1.8.

### Why this release exists

RetireGolden Pro consumes the engine, planner UI, and MCP packages together and
requires them to resolve one shared engine copy. Engine 0.1.8 adds the
Advisor-meeting shared-path progress seam; this coordination release prevents
the MCP sidecar from retaining a nested engine 0.1.7 while the desktop
calculation surface advances to 0.1.8.

## 0.7.0

**Updates the exact `@retiregolden/engine` dependency from 0.1.6 to 0.1.7, and
raises the Node floor to 24.**

A minor rather than a patch because the Node requirement moved, which is
breaking for anyone on an older runtime.

### Changed

- Keep MCP calculations aligned with engine 0.1.7.
- `engines.node` is now `>=24`. Node 20 reached end of life in April 2026, and
  the rest of the RetireGolden projects standardized on 24 — the app, engine and
  planner-ui packages plus their CI, and RetireGolden-Pro, which already declared
  `>=24`. CI now tests Node 24 only, instead of a 20/22/24 matrix it would warn on.

### Why this release exists

`@retiregolden/planner-ui` 0.5.0 depends on `@retiregolden/engine` `^0.1.7`,
while this package pinned engine `0.1.6` exactly. A host installing both — the
Pro desktop app — could not resolve a single shared engine copy, and Pro asserts
exactly that invariant so its GUI and MCP sidecar can never compute on different
engine versions. Releasing this unblocks Pro from adopting planner-ui 0.5.0.

## 0.6.1

**Updates the exact `@retiregolden/engine` dependency from 0.1.5 to 0.1.6.**

### Changed

- Keep MCP calculations aligned with engine 0.1.6.

## 0.6.0

**Adds an optional authorization hook to `registerTools`, so a host can gate tool
calls without forking the tool table.** Pass `{ authorize }` as a third argument;
it is consulted before each handler and may allow, or refuse with the exact
payload the model should see. Omit it and behavior is unchanged — `registerTools`
runs the same two statements it always did, with no extra await, and
`tests/registerTools.test.ts` asserts identical tool inventories, identical
descriptors, and identical results across the with-callback and without-callback
paths. That baseline did not exist before this release; `registerTools` had no
test at all.

The callback receives the tool name and its table entry, and deliberately **not**
the call arguments. `build_plan` and `update_plan` accept whole plan documents,
so passing arguments would route a user's financial data into a host's policy
layer — and a host that logged its authorization decisions would be logging plan
contents by accident. Withholding them makes that a property of the signature
rather than a rule each caller has to remember. The trade: a callback cannot make
argument-dependent decisions, which belong in the caller's own handler.

A refusal returns a result, never a throw. The MCP SDK converts a thrown handler
into an opaque `isError` result that flattens to a message string, discarding any
structured code or remedy.

One behavior worth knowing: the SDK validates a call's argument shape *before*
invoking the handler, so a tool with required arguments called with none is
rejected by the SDK and never reaches the hook. No handler runs and nothing is
exposed, but a denied caller sending malformed arguments sees a validation error
rather than the policy refusal.

`ToolEntry` gains `dataScope: 'none' | 'session'`. Only `describe_plan_schema` is
`'none'` — it is a pure function of the package's own static data. This is the
only data distinction this package can honestly own; it has no library, no GUI
and no user account, so richer classes belong to the host that has them.

### Security

**The HTTP gateway is fenced.** It is an unauthenticated loopback listener that
accepts a client-supplied `x-session-id` and speaks a bespoke `/tool` protocol —
a cost/ops research surface, never a supported transport. It previously read
`RETIREGOLDEN_HTTP_HOST` straight into `server.listen`, so an environment
variable could bind it to a non-loopback interface. Now:

- it binds a literal loopback address only (`127.0.0.1`, `::1`), enforced on the
  resolved host so neither the environment variable nor the `opts.host` argument
  can push it off — the argument was a second, equally open channel. `localhost`
  is rejected too: it resolves through the hosts file and DNS, so it cannot
  guarantee what it names;
- it does not start at all unless `RETIREGOLDEN_HTTP_GATEWAY=1` is set, which
  also covers the `retiregolden-mcp http` / `azure` CLI subcommand; and
- `src/index.ts` records that omitting `startHttpGateway` from the public exports
  is deliberate, since it previously read as an oversight.

`PORT` / `FUNCTIONS_CUSTOMHANDLER_PORT` no longer select a default port implicitly,
and `docs/hosted-transport.md` no longer tells container users to bind `0.0.0.0` —
instructions that this release makes non-functional.

## 0.5.1

**Re-pinned to `@retiregolden/engine` 0.1.5, so a plan copied out of the RetireGolden
web app imports without a spurious provenance warning.** The web app's new "Copy plan
for your AI" export stamps the engine that produced the document; 0.5.0 pinned engine
0.1.4, so every such paste raised the `engineVersion` skew caveat — *defaults and
modeling semantics can differ between versions; re-run the projection here* — on a
document that was in fact current. The warning was truthful about the version numbers
and misleading about the risk: engine 0.1.5 adds only the `ENGINE_VERSION` constant the
export needs and moves no modeling whatsoever.

A caveat that fires on the ordinary path is worse than no caveat, because it trains the
reader to ignore the one that matters.

**No numbers change.** Engine 0.1.5 is additive over 0.1.4; the full suite (540 tests,
including the 0.5.0 browser-parity fixtures) passes unchanged.

### Changed

- `@retiregolden/engine` pinned `0.1.4 → 0.1.5`. The pin stays exact — provenance
  reporting is only meaningful if the version this package reports is the version it
  actually runs. The cost is this release: an engine bump a consumer depends on needs a
  matching MCP release to clear the caveat, and that lag is the intended, visible one.

## 0.5.0

**Projections now include state income tax, and therefore match the RetireGolden
web app.** Through 0.4.2 every simulating tool ran a **federal-only** tax stack, so
for a resident of any state that taxes income the MCP quietly answered a different
question than the app the plan came from. On the RetireGolden example couple — a
Kentucky household, start year 2026 — ending net worth came back **3,616,404**
where the app shows **3,202,991**: the MCP overstated it by **~13%**.

Minor rather than patch, because **the numbers move for almost everyone.** Nine
states levy no income tax (AK, FL, NH, NV, SD, TN, TX, WA, WY); in the other 42
jurisdictions every projection, Monte Carlo, batch objective, optimizer schedule
and spending solve changes. Nothing about a stored plan document changes — no
schema bump, no engine bump. Re-run anything you are still relying on.

### Fixed

- **`taxCalc()` now returns the app's combined stack** — `combineTaxCalculators(
  createFederalTaxCalculator(), createStateTaxCalculator({ overridePct, localPct }))`,
  configured from the plan's own assumptions, a literal match for the browser
  planner's `taxCalculatorFor`. It fed **six** call sites, all now corrected:
  `run_projection`, `run_monte_carlo`, `batch_evaluate`, `compare_plans`, the
  optimizer and the spending solver. A fix reaching only the projection would have
  left the rest answering the old question.
- **`compare_plans` prices each document with its own state.** `taxCalc` takes a
  plan rather than reading session state, so comparing a KY plan against an FL one
  no longer taxes both at whichever state came first — previously invisible,
  because neither side was being taxed by a state at all.

### Changed — a knob that never meant what it said

`stateEffectiveTaxPct` is an **override**, and the engine applies it only when it is
**above 0**. At 0 — the parsed-plan default — the engine uses the **modeled pack for
`household.state`**, and a pack ships for all 51 US jurisdictions. So the field never
switched state tax *on*; naming the state does that. The MCP's docs said the
opposite ("state income tax is modeled at 0% until you set `stateEffectiveTaxPct`"),
which was an accurate description of the federal-only bug and a false description of
the engine. Every statement of it is corrected: the `build_plan` caveat, the
`household.state` / `assumptions.state` / `stateEffectiveTaxPct` field descriptions,
the `assumptions` block description, `docs/clients.md`, `SKILL.md` and
`references/examples.md`.

Two consequences worth stating plainly:

- **There is no longer any way to model a taxing state with zero state tax.**
  `stateEffectiveTaxPct: 0` does not do it — that is the "use the modeled pack"
  signal. To model a household with no state income tax, name a state that levies
  none. `build_plan` and `update_plan` now emit a caveat whenever a caller pins 0
  in a taxing state, because the pre-0.5.0 docs actively taught that spelling.
- **The RetireBench replication recipe no longer reproduces its historical
  numbers.** Its conventions include `state: "KY"` with `stateEffectiveTaxPct: 0`,
  which was only ever growth-neutral because the state calculator was not being
  consulted. The bench harness pins the package version, so those numbers stay
  reproducible on the version that produced them.

### Added

- **Imported plan documents get the state-tax caveat too**, not just typed builds.
  A document is where `stateEffectiveTaxPct: 0` is most likely to sit — it is the
  app's own serialization, and it is what an LLM authoring a plan from the old docs
  would write — so the document path is the one that most needs the warning. It
  reports which state's rules are in force, but never the accusatory "you pinned 0"
  wording: `parsePlan` defaults the field to 0, so a stored 0 cannot be told apart
  from an omitted one.
- **`stateEffectiveTaxPct` and `localIncomeTaxPct` reject negative values.** The
  engine clamps a negative to 0, which then means "use the modeled pack" — so a
  deliberate-looking input would quietly model something else. Neither arm of the
  rule gives a negative any meaning, so it is refused at the boundary.
- **`explain_modeled_result` reports `taxStack`.** It described assumptions and
  caveats but never named the tax stack, so nothing in its output revealed that the
  numbers were federal-only. It now states the stack and the app-parity claim, and
  `limitations` gains the above-0 override rule.
- **`run_projection`'s description states the app-parity claim**, so an assistant
  handed a plan copied out of the app knows the numbers are comparable (given the
  exported `startYear`).
- **`tests/browserParity.test.ts`** — the test whose absence let this ship. Every
  existing test compared the MCP against its own past output, which a wrong-but-
  stable stack passes forever. This one reconstructs the app's calculator from the
  engine and asserts the adapter agrees with **it**, across the whole summary and
  the full per-year ledger, for a household in a modeled state — plus a direction
  check that the result is strictly more taxed than a federal-only run, so it
  cannot pass by transcription drift.

### Goldens

`tests/goldens.test.ts` is regenerated — the first refresh that was not an engine
bump. Both fixtures live in KY, so both sets moved, including the legacy
bench-convention set. The header explains why that is not the blocking regression
it would normally signal.

## 0.4.2

**An exported plan document now says which build wrote it, and a re-import warns
on version skew.** Delivers the `schemaVersion` stamp named in step 1 of
`enhancements/plan-ingestion-and-round-trip.md`. Additive — no engine bump, no
change to any calculation. All goldens hold **byte-identically**.

On that plan's open decision 3 (skew policy), this release implements **warn,
never refuse for everything the MCP controls**, and makes the one case it does
not control explicit rather than silent — see *Skew policy, precisely* below. The
decision is **not** fully closed: accepting a document written against a *newer*
plan schema needs engine-side work, so that half stays with the owner.

### Added

- **`export_plan` stamps the emitting build's identity.** Alongside the existing
  `plan` / `startYear` / `conventions` / `caveats`, the response now carries
  `schemaVersion` (the engine's `PLAN_SCHEMA_VERSION`, the same source
  `describe_plan_schema` reports — not a duplicated literal), plus `engineVersion`
  and `mcpVersion` from the shared `getVersions()` helper with the same
  best-effort semantics as `get_session` (either degrades to `null` rather than
  throwing). Every previously returned field is unchanged, and the clone-on-export
  contract now covers the **whole** response: `conventions` and `caveats` were
  returned by reference, so a programmatic consumer (Pro's `save_library_plan`
  calls this helper directly) could mutate live session state through the exported
  object. Both are now cloned.
- **`build_plan` accepts the provenance siblings `schemaVersion`,
  `engineVersion` and `mcpVersion`.** Pass an `export_plan` response's siblings
  straight back. Both version checks **warn and import anyway**; neither ever
  refuses:
  - `engineVersion` differing from the running engine adds a caveat. This is the
    skew that can genuinely occur between two shipped builds that can exchange
    documents at all — same plan schema, moved defaults and semantics (the
    0.1.3 → 0.1.4 adoption in 0.4.1 is exactly such a step).
  - `schemaVersion` differing from the installed `PLAN_SCHEMA_VERSION` adds a
    caveat attributed to the **caller**, because a document that reaches the
    accept path has already validated at the installed version — the label, not
    the document, is what disagreed.
  - `mcpVersion` is accepted and recorded but never warned on: for a full plan
    document, the document is the model.
  - `engineVersion` and `mcpVersion` accept **`null`** — the value `export_plan`
    itself emits when a package version cannot be resolved — so a whole export
    response spreads back in verbatim. A null is treated as "unknown" and warns on
    nothing.
  - Omitting all three — every document written before this release — imports
    exactly as it did, with no new caveat and no error.
  - Caveat wording tracks what actually happened to the document: when the caller
    also passed `conventions` (which rewrite IRMAA lookback MAGIs or withdrawal
    ordering before the caveat is emitted), the message says the document was
    accepted *with those conventions applied on top* rather than claiming it was
    imported unchanged.
- **A cross-plan-schema document is now explained instead of leaking a zod
  issue.** A document written by a build on a different plan schema declares that
  version *inside itself*, and the engine's `parsePlan` pins that field to
  `z.literal(PLAN_SCHEMA_VERSION)`. Previously such an import failed with a bare
  `schemaVersion: Invalid input: expected 1`. It now leads with a message naming
  both versions, the direction of the skew and the remedy, with the engine's own
  issues kept underneath. For a document written by a *newer* build the remedy
  named is to upgrade (or to supply an export produced under this build's schema) —
  not to re-export at the older version, which the newer build may have no way to
  do. Older-schema documents are first offered to the engine's
  `migratePlanToCurrent` (its documented pre-`parsePlan` step) and are imported
  with a migration caveat when it can upgrade them; the caller's `schemaVersion`
  sibling is still checked independently in that case, against the version the
  document itself declared, so a migration cannot mask a mismatched label.

### Notes

- **Skew policy, precisely.** Three distinct situations, deliberately handled
  differently:
  1. *Provenance label disagrees with an otherwise-valid document* (`schemaVersion`
     sibling) → **caveat, imported**.
  2. *Different engine build, same plan schema* (`engineVersion` sibling) →
     **caveat, imported**. This is the reachable, real-world case.
  3. *Document written against a different plan schema* → **refused by the
     engine's validator**, with an explanatory message. This is not a policy
     refusal the MCP could waive: the installed engine has no definition for
     another schema's shape, and accepting it would mean guessing at fields. For
     an older schema the engine's migration registry is consulted first; it is
     empty at plan-schema v1, so today only "newer than this build" reaches the
     refusal. Removing that limit is engine work (a v1→v2 migration step), which
     is why decision 3 is recorded above as partially open.
- Provenance siblings are honored only on the full-plan-JSON branch; the typed
  `household`/`policy` path builds a document from scratch at the current version
  and ignores them.
- `getVersions()` moved from `src/adapter.ts` into `src/versions.ts` so
  `buildPlan.ts` can compare engine versions without an import cycle.
  `adapter.getVersions` re-exports it — the import path every consumer
  (`get_session`, `export_plan`, `explain_modeled_result`, Pro) uses is unchanged.
- Tool-surface names and arm groupings are unchanged, so `schemas/tools.v1.json`
  needs no edit and the registry-parity / gateway-parity tests stay green.
- **Follow-up owed in RetireGolden-Docs (not this repo):**
  `enhancements/plan-ingestion-and-round-trip.md` still lists decision 3 as open
  with a "likely:" hedge and does not record the step-1 stamp shipping. Update it
  to say the warn-never-refuse half is resolved and shipped in
  `@retiregolden/mcp` 0.4.2, and that the newer-schema half remains open pending
  an engine migration path. Do this before tagging the release.

### Docs

- `docs/clients.md` skill-folder trees now list `references/plan-ingestion.md`
  (shipped in 0.4.0) alongside `examples.md` and `plan-json.md`, so a reader
  copying the folder knows to expect all three.
- `docs/hosted-transport.md` said the HTTP stub exposes "5 of the 11" tools; the
  stdio surface has been 14 since 0.4.0. Corrected to 5 of 14, with the 9
  unreachable tools named (`describe_plan_schema` and `update_plan` were missing
  from the list), and pointed at `schemas/tools.v1.json` as the count of record.
  `docs/` ships in the npm tarball, so this text reached readers.

## 0.4.1

### Engine

- **Bumped `@retiregolden/engine` 0.1.3 → 0.1.4** (exact pin retained). The
  engine Plan schema now accepts year-keyed historical MAGI values so IRMAA
  lookbacks can preserve distinct pre-horizon tax years. The existing scalar
  historical-MAGI input remains a backward-compatible fallback. The typed
  `pre_horizon_magi` pair and `irmaaLookbackMagis` convention now populate those
  exact years instead of collapsing them to one scalar, and `update_plan` can set
  the year-keyed history directly.

## 0.4.0

**Plan ingestion — an AI can now learn the plan format and build a plan up from
the user's real documents.** Adds the schema-discovery and incremental-mutation
half of the plan round-trip (`export_plan` shipped in 0.2.0). Governed by
`enhancements/plan-ingestion-and-round-trip.md` (steps 3–5). Additive — no change
to any existing tool's behavior or numeric output.

### Engine

- **Bumped `@retiregolden/engine` 0.1.2 → 0.1.3** (exact pin retained). Additive:
  0.1.3 adds the `@retiregolden/engine/schema` export (a zod-free versioned Plan
  JSON Schema + `PLAN_SCHEMA_VERSION`) and changes no calculation. All goldens
  hold **byte-identically**.

### Added

- **`describe_plan_schema`** — returns the engine's versioned Plan JSON Schema
  (the source of truth for authoring a full plan document) plus its
  `schemaVersion`. Optional `path` arg (dotted, e.g. `properties.accounts.items`,
  or JSON pointer, e.g. `/properties/accounts/items`) fetches a subtree to keep
  token cost down. Read-only meta tool. The same schema is **also served as an MCP
  resource** (`plan-schema`).
- **`update_plan`** — incremental merge-semantics mutation of the session plan via
  named domain operations (`add_account` / `replace_account` / `remove_account` by
  id, `add_income` / `replace_income` / `remove_income` by id, `set_assumption`,
  `set_expense`). The mutated plan is validated through the engine **before
  commit**: on failure the session plan is left **unchanged** (never
  half-applied), and `issues` are returned. Requires a seeded plan (`build_plan`
  first; `NO_PLAN` otherwise). Enables multi-document ingestion without rebuilding
  each turn.

### Docs

- New `skills/retiregolden/references/plan-ingestion.md` walking the ingestion
  loop (`describe_plan_schema` → extract → `update_plan` → `validate_plan` →
  repeat) with a worked brokerage-statement-to-account example and guidance on
  asking the user for missing required fields. Pointer added from `SKILL.md`.

### Notes

- Both new tools are stdio-only (`httpExposed: false`), matching the existing
  read-only/authoring tools (`validate_plan`, `export_plan`); the five-tool HTTP
  gateway surface is unchanged. `schemas/tools.v1.json` is updated so the
  three-surface registry-parity test stays green.

## 0.3.0

**The typed `build_plan` path now defaults to real-world, end-user modeling
instead of RetireBench conventions.** The MCP is marketed as a general-purpose
retirement calculator; through 0.2.x the documented easy path silently applied
bench conventions (0% inflation, Kentucky residency, retired-household) to real
users. This release flips those defaults. See the governing plan,
`enhancements/mcp-end-user-realignment.md` WS1.3.

### Breaking

- **Typed-path defaults flipped to the engine's own defaults.** A typed
  `build_plan` with no `assumptions` block no longer forces the growth-neutral
  zeros. The engine's `createEmptyPlan` defaults now flow through:
  **inflation 2.5%/yr** (was 0%), **SS COLA `matchInflation`** i.e. tracking
  inflation (was fixed 0%), **healthcare extra inflation +3%/yr** (was 0%),
  **fallback return 5.5%** for accounts without an explicit rate (was 0%). State
  and local income tax stay at the engine default **0%** (unchanged — set
  `stateEffectiveTaxPct` / `localIncomeTaxPct` to model them). Existing numeric
  results from a bare typed build **will change** (real inflation, non-zero COLA).
- **`household.state` is now REQUIRED.** The old hardcoded `KY` default is gone;
  the engine requires a residence state, so the typed household must supply a
  2-letter `state` code. A typed build that omits it is rejected with
  `household.state is required: provide a 2-letter state-of-residence code …`.
  `assumptions.state` remains an override of the value used, but the household
  must still declare one.
- **A non-zero `wage` is now a hard error.** Previously a person's `wage` was
  silently unmapped with a caveat; the typed path is a retired-household contract,
  so a non-zero wage now fails the build with
  `person <i>: wages are not modeled; remove wage or use full plan JSON`. Model
  pre-retirement earnings via the full plan JSON path.

### Changed

- **`household.growth.*` is documented as NOMINAL, not real.** These fractions have
  always been written straight into the engine's nominal `annualReturnPct`; the prior
  "real annual return rates" wording was identity-safe only while inflation was forced
  to 0. With the new ~2.5% default inflation the distinction matters, so the schema,
  `SKILL.md`, `docs/clients.md`, and `examples.md` now say nominal (real ≈ growth −
  inflation). This is a documentation/label fix — no numeric behavior changed, and the
  new-default goldens already reflect nominal returns.
- The state-income-tax footgun caveat now fires on the primary typed path too (whenever
  `stateEffectiveTaxPct` is left unset, not only when `assumptions.state` is used), so a
  plain `household.state: "CA"` build is still warned that state tax is modeled at 0%.
- `dobMonthDay` (default `06-15`), `sex` (default `average`), and `qualifiedRatio`
  (default `0.85`) are unchanged as neutral, overridable defaults — their tool/schema
  descriptions now state they are defaults, not bench artifacts.
- Every tool description, `SKILL.md`, `skills/retiregolden/references/`, and
  `docs/clients.md` updated to document the new defaults, the required `state`
  field, and the wage hard error, and to explain when to still pass `assumptions`.

### Compatibility

- **RetireBench is unaffected.** It pins `@retiregolden/mcp` at `0.2.x` and, as of
  its WS1.2 change, passes every convention explicitly through the `assumptions`
  block (plus `state: 'KY'`), so its scored numbers do not move with this flip.
- **RetireGolden-Pro is not updated here.** Pro pins `^0.1.1`/`0.2.x` and needs a
  deliberate bump to consume 0.3.0 (plan WS5.11) — intentionally out of scope.
- The golden-number suite proves both directions: the legacy bench literals still
  reproduce exactly when the conventions are passed explicitly (legacy override
  path preserved), and a second golden set pins the new engine-default outputs.

### Dependencies

- Adopts **`@retiregolden/engine` 0.1.2** (tax withdrawal fixed-point convergence
  fix plus graceful handling of tax-solver discontinuities). The engine is now
  **exact-pinned** (`0.1.2`, no caret). Projection, tax, conversion, and batch
  golden/expected numbers have been refreshed to reflect 0.1.2 output; Monte Carlo
  success rates (pathCount 300 / seed 7) are unchanged.

## 0.2.1

No functional changes. This release validates the switch to npm Trusted
Publishing (OIDC): the publish workflow now authenticates via GitHub OIDC
instead of a long-lived `NPM_TOKEN`, and OIDC auth can only be exercised by a
real publish (a dry-run never authenticates). The `package-lock.json` version
fields, left at 0.1.1 through the 0.2.0 release, are also realigned to match.

## 0.2.0

### Breaking

- **`run_projection` default response shape changed.** It now defaults to
  `detail: 'summary'`, returning `startYear` / `endYear` / `summary` / `caveats`
  only and **omitting the per-year `years[]` array** that 0.1.x always returned.
  Pass `detail: 'years'` to get the full per-year ledger (taxes, penalties, MAGI,
  Medicare premiums, IRMAA tier, Roth conversions, withdrawals, shortfall).
  Callers that read `years[]` must now request `detail: 'years'` explicitly.
- **`run_projection` no longer accepts a `startYear` override.** A projection
  always runs from the session plan's `startYear`; rebuild via `build_plan`
  (`startYear` there) to change it. This keeps the projection window consistent
  with the plan the session was built from.

### Added

- **`assumptions` block on `build_plan`.** Optional overrides for the typed-path
  modeling defaults: `inflationPct`, `healthcareExtraInflationPct`,
  `defaultReturnPct`, `ssColaPct`, `state`, `stateEffectiveTaxPct`,
  `localIncomeTaxPct`, `qualifiedRatio`, `dobMonthDay`, `sex`. Omitted fields keep
  the bench defaults (0% inflation, 0% SS COLA, state KY with 0% state tax,
  June-15 DOBs, sex `average`, qualifiedRatio 0.85). `*Pct` fields are percents
  (2.5 = 2.5%); `household`/`policy` rates remain fractions (0.05 = 5%).
  `dobMonthDay` is calendar-validated (month 01-12, day within that month, 02-29
  allowed). Setting `state` alone does not switch on state income tax — a caveat
  reminds you to also set `stateEffectiveTaxPct`; a single `sex`/`dobMonthDay`
  applies to every person in a multi-person household (also caveated).
- **Monte Carlo percentiles.** `run_monte_carlo` now surfaces the ending
  investable-balance distribution as `percentiles` (`p10`/`p25`/`p50`/`p75`/`p90`)
  alongside `successRate` and `requiredFloorSuccessRate`.
- **`export_plan` tool.** Exports the session plan as full engine plan JSON plus
  the session `startYear` and `conventions`, round-trippable via
  `build_plan({ plan, startYear, conventions })`. Returns a clone, so mutating the
  exported document does not affect the live session. Pass the exported `startYear`
  back on re-import or a non-2026 session's projection will diverge.
- **Provenance fields.** `get_session` and `explain_modeled_result` report the
  running `mcpVersion` and `engineVersion` (best-effort; each degrades to `null`
  if it cannot be resolved).
- **Declarative tool table.** A single tool registry (`src/toolTable.ts`) is now
  the one source of truth for the tool surface; both the stdio registration and
  the HTTP gateway drive off it, and `schemas/tools.v1.json` is kept honest
  against it by a parity test.

### Notes

- When full plan JSON is supplied to `build_plan`, it takes precedence and any
  typed `household`/`policy`/`conversion`/`assumptions` supplied alongside it are
  ignored — a caveat now lists exactly which fields were ignored.
