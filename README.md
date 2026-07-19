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
`npx @retiregolden/mcp`) over stdio.

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

## Tools (v1, read-only)

| Tool | Purpose |
|---|---|
| `build_plan` | Build an in-memory plan from typed household/policy params or full plan JSON |
| `validate_plan` | Validate the current session plan (or supplied JSON) |
| `run_projection` | Deterministic year-by-year projection |
| `run_monte_carlo` | Stochastic success / percentile summary |
| `batch_evaluate` | Evaluate many policies against one household (search-friendly) |
| `run_optimizer` | Engine optimizer / conversion schedule search |
| `solve_max_spending` | Sustainable-spending bisection |
| `compare_scenarios` | Diff two projection summaries |
| `explain_modeled_result` | Compact evidence / assumptions / limitations payload |
| `get_session` / `clear_session` | Inspect or reset in-memory session |

## Agent skill

See [`skills/retiregolden/SKILL.md`](skills/retiregolden/SKILL.md) (MIT). Bench
and product runners should pin the skill file digest used for scored runs.

## Development

```bash
npm ci
npm test
npm run build
npm run mcp
```

## Related

- Engine: https://github.com/RetireGolden/RetireGolden/tree/main/packages/engine
- Benchmark harness: https://github.com/RetireGolden/RetireBench
- Free planner (no MCP — browser only): https://retiregolden.app/

## Trademark

See [TRADEMARKS.md](TRADEMARKS.md). Forks must rename.
