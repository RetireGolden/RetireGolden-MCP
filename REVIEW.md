```review-policy
{"version":1,"review":{"profile":"code"}}
```

# Review guidance

Public **AGPL-3.0** MCP server (`@retiregolden/mcp`); skills under `skills/` are **MIT**. No private planning or competitor material.

This package is a thin, read-only adapter over the pinned [`@retiregolden/engine`](https://www.npmjs.com/package/@retiregolden/engine). Money math, tax rules, and projections stay in the engine—do not reimplement them here.

Tool contracts live in `src/toolTable.ts`. Keep `schemas/tools.v1.json` in parity via `pnpm run contract:generate`. Flag drift between schema, handler validation, and documented tool behavior—not style preferences.

Prioritize in-memory session lifecycle, input validation, objective/constraint preservation, and honest statistical scope and unsupported limitations per [DISCLAIMER.md](DISCLAIMER.md): educational decision-support only, no invented advice, no disk persistence, no telemetry or plan-data exfiltration.

For behavioral bugs, trace a concrete repro from the default stdio entrypoint (`retiregolden-mcp`) through the tool handler to the engine. Contract or schema questions alone are not defects.

HTTP research transport: see [src/http/REVIEW.md](src/http/REVIEW.md).
