---
name: retiregolden
description: Use RetireGolden MCP calculation tools for US retirement planning math (projections, conversions, claiming, IRMAA, RMDs). Educational decision-support only — not advice.
---

# RetireGolden calculator skill

You have access to RetireGolden MCP tools over a **headless, in-memory** engine session.

## Rules

1. Tools are **educational / decision-support only**. Do not prescribe securities trades or claim results are advice.
2. Prefer `build_plan` with typed `household` + `policy` (or full plan JSON), then `run_projection` / `batch_evaluate`.
3. For combinatorial search use `batch_evaluate`, not thousands of single projections. Prefer **<= 40 policies per call** and **one call per sweep** — cap total agent tool calls sensibly rather than fanning out.
4. Call `explain_modeled_result` when summarizing so caveats and limitations stay visible.
5. End user-facing numeric answers with a clear final value; for RetireBench, use `ANSWER: <value>`.

## Units — the #1 failure mode

Household/policy rates are **fractions** (`0.05` = 5%); passing `5` where `0.05` is meant inflates a return 100x. The one exception is the `assumptions` override block, whose `Pct`-suffixed fields are **percents** (`2.5` = 2.5%) — see that table row and the assumptions section below.

| Field | Unit | Example |
|---|---|---|
| `growth.trad` / `growth.roth` / `growth.taxable` | fraction (annual return) | `0.05` = 5% |
| `conversion_bracket` | fraction (tax bracket top) | `0.24` = the 24% bracket |
| `heir_ordinary_rate` | fraction | `0.24` = 24% |
| `assumptions.*Pct` (the `Pct`-suffixed overrides) | **percent** | `2.5` = 2.5% |
| `assumptions.qualifiedRatio` | fraction (0–1) | `0.85` |
| `pia` | **monthly** dollars at FRA | `3000` = $3,000/mo |
| `pension` / `wage` | **annual** dollars | `24000` = $24k/yr |
| `taxable` / `trad` / `roth` | dollars (balance) | `400000` |
| `taxable_basis` | dollars (cost basis) | `250000` |
| `spending` | annual dollars | `90000` |
| `claim_ages[]` | whole years | `70` (not `70.5`) |
| `horizon` | whole years | `30` |

> Full worked `build_plan` calls (single filer, MFJ with pension, batch sweep): **`references/examples.md`**.

## Typed-path assumptions — READ BEFORE ANSWERING REAL USERS

> **⚠️ The typed `household`/`policy` path defaults to RetireBench conventions, not the real world.**
> With no overrides it bakes in: **0% inflation, 0% SS COLA, state KY with 0% state/local tax, June-15 birthdays, `qualifiedRatio` 0.85, and a retired household (wages are unmapped/ignored).** These are correct for bench replication and **wrong for a real household.**

For any real-user question, pass an **`assumptions`** block on `build_plan` to override each convention, and **state the assumptions you used** in your answer. Fields (all optional; each falls back to the bench default):

`inflationPct`, `ssColaPct`, `defaultReturnPct`, `healthcareExtraInflationPct`, `stateEffectiveTaxPct`, `localIncomeTaxPct` — all **percents** (`2.5` = 2.5%) · `state` (2-letter code, e.g. `"OH"`; null/omitted keeps KY) · `qualifiedRatio` (fraction 0–1) · `dobMonthDay` (`"MM-DD"`, e.g. `"06-15"`) · `sex` (`male` / `female` / `average`).

Do NOT flip the defaults yourself — set real values explicitly. See `references/examples.md` for a real-household MFJ call with overrides.

## Error & caveat semantics

- Tools return their failures **as successful MCP results** with `ok: false` and an `error` code — inspect the JSON body, do not treat these as tool crashes. Codes include `NO_PLAN` (call `build_plan` first), `OPTIMIZER_FAILED`, `SPENDING_SOLVER_FAILED`, `INVALID_PLAN_A` / `INVALID_PLAN_B`. Invalid `build_plan` input returns `ok: false` with an `issues[]` array.
- **`caveats[]` accumulates approximations** (e.g. IRMAA single-scalar MAGI, `traditional-first` ordering under sequential drain, best-effort law-sunset freeze). It rides along on build, projection, and batch results — **surface it to the user**; never drop it.
- `explain_modeled_result` returns `framing`, `assumptions`, `conventions`, `caveats`, and `limitations`. Call it when summarizing so the modeling boundaries stay visible.

## Typical calculator flow

1. `build_plan` — `household` + `policy` (+ `assumptions` for real users, + optional `conventions`)
2. `run_projection` — inspect year ledger / summary
3. `batch_evaluate` — sweep alternate policies (claim ages, conversion brackets, ordering)
4. `run_optimizer` / `solve_max_spending` — delegate search to the engine when asked
5. `explain_modeled_result` — surface assumptions and caveats in the answer

## Conventions knob

Pass `conventions` on `build_plan` for law-sunset freeze, dual IRMAA lookback MAGIs, or a withdrawal-ordering override. Read returned `caveats` — some engine knobs are best-effort.

## References

- `references/examples.md` — complete `build_plan` calls (single, MFJ + pension + assumptions, batch sweep).
- `references/plan-json.md` — one full engine-plan JSON with a note per section, for the `plan` JSON path.
