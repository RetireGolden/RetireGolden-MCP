---
name: retiregolden
description: Use RetireGolden MCP calculation tools for US retirement planning math (projections, conversions, claiming, IRMAA, RMDs). Educational decision-support only — not advice.
---

# RetireGolden calculator skill

You have access to RetireGolden MCP tools over a **headless, in-memory** engine session.

## Rules

1. Tools are **educational / decision-support only**. Do not prescribe securities trades or claim results are advice.
2. Prefer `build_plan` with typed `household` + `policy` (or full plan JSON), then `run_projection` / `batch_evaluate`.
3. For combinatorial search, use `batch_evaluate` with a modest policy list rather than thousands of single projections.
4. Call `explain_modeled_result` when summarizing so caveats and limitations stay visible.
5. End user-facing numeric answers with a clear final value; for RetireBench, use `ANSWER: <value>`.

## Typical calculator flow

1. `build_plan` — household + policy (+ optional `conventions`)
2. `run_projection` — inspect year ledger / summary
3. `batch_evaluate` — compare alternate policies (claim ages, conversion brackets, ordering)
4. Optionally `run_optimizer` when asked to delegate search to the engine optimizer

## Conventions

Pass `conventions` on `build_plan` when the scenario specifies law-sunset freeze, dual IRMAA MAGIs, or withdrawal ordering. Read returned `caveats` — some engine knobs are best-effort.
