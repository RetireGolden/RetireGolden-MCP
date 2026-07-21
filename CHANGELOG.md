# Changelog

All notable changes to `@retiregolden/mcp` are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

## 0.4.2

**An exported plan document now says which build wrote it, and a re-import warns
on version skew.** Closes the `schemaVersion` acceptance criterion of step 1 of
`enhancements/plan-ingestion-and-round-trip.md` and settles its open decision 3
(skew policy) as **warn, never refuse**. Additive — no engine bump, no change to
any calculation. All goldens hold **byte-identically**.

### Added

- **`export_plan` stamps the emitting build's identity.** Alongside the existing
  `plan` / `startYear` / `conventions` / `caveats`, the response now carries
  `schemaVersion` (the engine's `PLAN_SCHEMA_VERSION`, the same source
  `describe_plan_schema` reports — not a duplicated literal), plus `engineVersion`
  and `mcpVersion` from the shared `getVersions()` helper with the same
  best-effort semantics as `get_session` (either degrades to `null` rather than
  throwing). Every previously returned field, and the clone-on-export behavior,
  is unchanged.
- **`build_plan` accepts an optional top-level `schemaVersion` and warns on
  skew.** When a full `plan` document is supplied together with a `schemaVersion`
  that differs from the installed `PLAN_SCHEMA_VERSION`, the build **succeeds**
  and appends a caveat naming both versions and stating the plan was accepted
  anyway. The plan is never refused on skew. Omitting `schemaVersion` — every
  document written before this release — imports exactly as it did, with no new
  caveat and no error.

### Notes

- **Where the skew signal is read from, and why.** The check reads the
  **top-level `build_plan` argument only**, not `plan.schemaVersion` inside the
  document. Two reasons. (1) It matches how a caller actually round-trips an
  export: `export_plan` returns `schemaVersion` as a *sibling* of `plan`, exactly
  as `startYear` and `conventions` are siblings, so the round-trip is the natural
  `build_plan({ plan, startYear, conventions, schemaVersion })`. (2) The engine's
  own `parsePlan` pins the in-document `schemaVersion` to a literal equal to the
  installed version, so an embedded mismatch is **hard-rejected by the engine**
  before this code could ever see it — a caveat derived from the embedded field
  could never coexist with an accepted import, which is precisely the behavior
  the warn-not-refuse policy requires. Keeping provenance on the sibling channel
  keeps it out of the engine's gate.
- `schemaVersion` is honored only on the full-plan-JSON branch; the typed
  `household`/`policy` path builds a document from scratch at the current version
  and ignores it.
- Tool-surface names and arm groupings are unchanged, so `schemas/tools.v1.json`
  needs no edit and the registry-parity / gateway-parity tests stay green.

### Docs

- `docs/clients.md` skill-folder trees now list `references/plan-ingestion.md`
  (shipped in 0.4.0) alongside `examples.md` and `plan-json.md`, so a reader
  copying the folder knows to expect all three.

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
