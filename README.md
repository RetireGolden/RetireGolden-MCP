# RetireGolden MCP

**Headless Model Context Protocol server** for the
[`@retiregolden/engine`](https://www.npmjs.com/package/@retiregolden/engine)
retirement-planning calculator.

Run it locally over **stdio**, connect your AI client (Claude Desktop, Cursor,
etc.), and call typed tools: build/validate a plan, run projections, Monte
Carlo, batch policy evaluation, and optimization — with session state held
**in memory** (no disk required).

**npm:** `@retiregolden/mcp`  
**License:** AGPL-3.0-only (server); MIT (skills under `skills/`)

RetireGolden **Pro** ships this same package pre-wired in the desktop app for
out-of-the-box convenience. Anyone can install and run the public package.

## Disclaimer

Educational / decision-support only — **not** tax, legal, or financial advice.
See [DISCLAIMER.md](DISCLAIMER.md).

## Quick start

```bash
npx @retiregolden/mcp
# or
npm install -g @retiregolden/mcp
retiregolden-mcp
```

Configure your MCP client to launch `retiregolden-mcp` (or
`npx @retiregolden/mcp`) over stdio. The same command serves both 2025-era
(legacy `initialize`) and 2026-07-28 (modern `server/discover`) clients —
existing configs do not change.

### Run from a checkout

Working on this repository instead of installing the package? Build once, then
launch the same stdio server the published `bin` entry point runs:

```bash
pnpm install --frozen-lockfile
pnpm run build
pnpm run mcp
```

### Example Claude Desktop / Cursor snippet

```json
{
  "mcpServers": {
    "retiregolden": {
      "command": "npx",
      "args": ["-y", "@retiregolden/mcp"]
    }
  }
}
```

## Connect your AI client

Per-client, copy-paste setup for Claude Desktop, Claude Code, Cursor, and Codex
(MCP config + agent skill / rules) is in [`docs/clients.md`](docs/clients.md).

## Tools (v1)

Read-only with respect to your finances and disk: no trades, no persistence.
Session state (e.g. `build_plan`, `clear_session`) is held in memory only.

| Tool | Purpose |
|---|---|
| `build_plan` | Build an in-memory plan from typed household/policy params or full plan JSON |
| `validate_plan` | Validate the current session plan (or supplied JSON) |
| `run_projection` | Deterministic year-by-year projection |
| `run_monte_carlo` | Stochastic success rate and required-floor success rate |
| `batch_evaluate` | Evaluate many policies against one household (search-friendly) |
| `run_optimizer` | Engine optimizer / conversion schedule search |
| `solve_max_spending` | Sustainable-spending bisection |
| `compare_scenarios` | Diff two projection summaries |
| `explain_modeled_result` | Compact evidence / assumptions / limitations payload |
| `export_plan` | Return the session plan as full plan JSON (round-trips via `build_plan`) |
| `describe_plan_schema` | Return the engine's versioned Plan JSON Schema (full or a `path` subtree); also served as the `plan-schema` MCP resource |
| `update_plan` | Incrementally merge account/income/assumption/expense fragments into the session plan (validate-before-commit) |
| `get_session` / `clear_session` | Inspect or reset in-memory session |

## Agent skill

See [`skills/retiregolden/SKILL.md`](skills/retiregolden/SKILL.md) (MIT). Bench
and product runners should pin the skill file digest used for scored runs.

## npm publish

Releases are tag-driven: pushing a `mcp-v<version>` tag triggers the publish
workflow (see [`.github/workflows/publish-mcp.yml`](.github/workflows/publish-mcp.yml)).

## Related

- Engine: https://github.com/RetireGolden/RetireGolden/tree/main/packages/engine
- Benchmark harness: https://github.com/RetireGolden/RetireBench
- Free planner (no MCP — browser only): https://retiregolden.app/

## Trademark

See [TRADEMARKS.md](TRADEMARKS.md). Forks must rename.

## Automated code review

Repository review guidance lives in [REVIEW.md](REVIEW.md), with HTTP-specific notes in [src/http/REVIEW.md](src/http/REVIEW.md). The policy format follows the [OpenRouter PR review action reference](https://github.com/FlyOverCoderKY/openrouter-pr-review-action/blob/188cd5557765c858a37c1da78960cd353bcbcd60/docs/review-policy.md).

The workflow loads effective guidance from the **target branch** (typically `main`) at review time. Edits on an open PR affect later runs only **after merge**; changed source files on the PR branch are still reviewed. Review policy cannot exclude file coverage—new or touched source remains in scope.

This repository caller enables both `review_policy: base` and `review_profiles_enabled: true`. With profiles enabled, the root `REVIEW.md` selects the trusted registry's `code` profile through its `review.profile` metadata. The registry defines that profile's models and budgets; policy cannot invent models or grant CI authorization. Nested `REVIEW.md` files add scoped guidance and cannot change the root profile.

Manual review dispatches review the full PR while retaining its finding ledger and rebuttals. Leave `reset_review` false for normal reruns; profile-enabled reviews reject `reset_review: true`. When reading review results through the GitHub API, paginate reviews, inline comments, and issue comments, including every continuation part.


## Review profiles and CI proof

The caller enables trusted profiles from the [organization workflow](https://github.com/RetireGolden/.github/blob/3d92f63176b55e5ade2dbe4a081c21ad249826ea/README.md). Code uses required Grok plus optional GLM; deep adds required Astra Flex. This preserves the standing baseline; `REVIEW.md` cannot name arbitrary models or remove required lanes.

From Actions → **OpenRouter code review**, dispatch from `main` with a PR number and `review_level: auto`, `deep`, or `cancel`. Deep requests require repository write/maintain/admin permission, retain existing findings, and stay pending across retries and pushes until their own required review succeeds. Cancel removes a manual pending request; it cannot lower a policy requirement. Leave `reset_review` false.

**OpenRouter profile completion** checks the exact PR head, effective current policy, required lanes, and accepted requests. The `openrouter-profile` status supplements the existing first-pass gate and repository CI. A successful review workflow alone does not establish a clean or complete review.

Profile artifacts retain 30 days (requests 90 days), and the gate accepts PRs younger than 25 days. Open a replacement PR for older work. Missing evidence fails closed. An automatic policy refresh is requested at most once per head/configuration; use a manual rerun if that request fails. Maintainer labels and automatic path escalation are not enabled in this rollout.
