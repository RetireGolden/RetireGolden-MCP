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
| `growth.trad` / `growth.roth` / `growth.taxable` | fraction — **nominal** annual return | `0.05` = 5% headline (real ≈ 5% − inflation) |
| `conversion_bracket` | fraction (tax bracket top) | `0.24` = the 24% bracket |
| `heir_ordinary_rate` | fraction | `0.24` = 24% |
| `assumptions.*Pct` (the `Pct`-suffixed overrides) | **percent** | `2.5` = 2.5% |
| `assumptions.qualifiedRatio` | fraction (0–1) | `0.85` |
| `pia` | **monthly** dollars at FRA | `3000` = $3,000/mo |
| `pension` | **annual** dollars | `24000` = $24k/yr |
| `wage` | **not modeled** — a non-zero value is a hard error | omit it (retired household) or use full plan JSON |
| `state` (household) | **2-letter code, REQUIRED** | `"OH"`, `"CA"` |
| `taxable` / `trad` / `roth` | dollars (balance) | `400000` |
| `taxable_basis` | dollars (cost basis) | `250000` |
| `spending` | annual dollars | `90000` |
| `claim_ages[]` | whole years | `70` (not `70.5`) |
| `horizon` | whole years | `30` |

> Full worked `build_plan` calls (single filer, MFJ with pension, batch sweep): **`references/examples.md`**.

## Typed-path defaults and assumptions (v0.3.0)

As of **v0.3.0** the typed `household`/`policy` path defaults to **end-user-appropriate, real-world modeling** — no more baked-in RetireBench conventions. With no `assumptions` block the ENGINE's own defaults flow through:

- **~2.5%/yr inflation** (was 0%), **SS COLA tracking inflation** (was fixed 0%), **+3%/yr healthcare inflation above general**, **5.5% fallback return** (for accounts without an explicit rate).
- **0% state & local income tax** — the engine models these at 0 until you set `stateEffectiveTaxPct` / `localIncomeTaxPct`. **Naming a state does not by itself switch on that state's income tax.**
- Neutral, overridable placeholders: **June-15 birthdays**, `sex` **average**, `qualifiedRatio` **0.85**.

Two things are now **required / hard errors**, not silent assumptions:

1. **`household.state` is REQUIRED** (2-letter code). A typed build that omits it is rejected with a clear issue. `assumptions.state` can override the value used, but the household must still declare one.
2. **Wages are not modeled.** A non-zero `wage` on any person is a **hard build error** (`wages are not modeled; remove wage or use full plan JSON`) — the typed path is a retired-household contract. Model pre-retirement earnings via full plan JSON.

When to still pass an **`assumptions`** block: to model a specific inflation/return regime, a real state income-tax rate, a specific COLA, or real birth dates — and **state the assumptions you used** in your answer. Override fields (all optional; each omitted field keeps the engine default):

`inflationPct`, `ssColaPct`, `defaultReturnPct`, `healthcareExtraInflationPct`, `stateEffectiveTaxPct`, `localIncomeTaxPct` — all **percents** (`2.5` = 2.5%) · `state` (2-letter override; omitted uses `household.state`) · `qualifiedRatio` (fraction 0–1) · `dobMonthDay` (`"MM-DD"`, e.g. `"06-15"`) · `sex` (`male` / `female` / `average`).

> RetireBench replication: to reproduce the pre-0.3.0 growth-neutral numbers, pass every convention explicitly (`inflationPct: 0`, `ssColaPct: 0`, `state: "KY"`, `stateEffectiveTaxPct: 0`, etc.). The bench harness does exactly this and pins the package version.

See `references/examples.md` for a real-household MFJ call with overrides.

## Error & caveat semantics

- Tools return their failures **as successful MCP results** with `ok: false` and an `error` code — inspect the JSON body, do not treat these as tool crashes. Codes include `NO_PLAN` (call `build_plan` first), `OPTIMIZER_FAILED`, `SPENDING_SOLVER_FAILED`, `INVALID_PLAN_A` / `INVALID_PLAN_B`. Invalid `build_plan` input returns `ok: false` with an `issues[]` array — including the two v0.3.0 hard errors: a **missing/invalid `household.state`** and a **non-zero `wage`** (wages are not modeled).
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

## Building a plan from the user's documents (ingestion loop)

To assemble a plan from real statements (401k/brokerage/IRA exports), use the ingestion loop: **`describe_plan_schema`** (learn the plan format, or a subtree via `path`) → seed a minimal plan with `build_plan` → **`update_plan`** (merge each extracted fragment with named ops: `add_account`, `replace_income`, `set_assumption`, …) → `validate_plan` → repeat → `export_plan`. `update_plan` validates the mutated plan **before commit** and leaves the session plan untouched on failure. Extraction (reading the document) is **your** job — the MCP does no OCR/PDF parsing. Ask the user for required fields a statement omits (especially the account **type** and any inferred dollar figure). The same schema is also served as an MCP **resource** (`plan-schema`). **Full loop + a worked brokerage-statement→account example: `references/plan-ingestion.md`.**

## References

- `references/examples.md` — complete `build_plan` calls (single, MFJ + pension + assumptions, batch sweep).
- `references/plan-json.md` — one full engine-plan JSON with a note per section, for the `plan` JSON path.
- `references/plan-ingestion.md` — the document-ingestion loop (`describe_plan_schema` → `update_plan` → `validate_plan`) with a worked statement-to-account example.
