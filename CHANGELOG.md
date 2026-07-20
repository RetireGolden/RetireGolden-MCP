# Changelog

All notable changes to `@retiregolden/mcp` are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

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
