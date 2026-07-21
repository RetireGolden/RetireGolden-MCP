# Changelog

All notable changes to `@retiregolden/mcp` are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

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
