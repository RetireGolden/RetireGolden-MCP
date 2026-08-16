# RetireGolden-MCP — standing agent rules

Public AGPL-3.0 Model Context Protocol server (`@retiregolden/mcp`).
Skills under `skills/` are MIT.

## Ground truth

This package is a thin, in-memory adapter over
[`@retiregolden/engine`](https://www.npmjs.com/package/@retiregolden/engine).
Read [README.md](README.md), [CONTRIBUTING.md](CONTRIBUTING.md), and
[DISCLAIMER.md](DISCLAIMER.md) before changing code.

Do not invent tax, statute, or product behavior. Money math stays in the
engine; this repo must not reimplement tax or projection rules.

Do not add private planning, strategy, or competitor material here.

## Invariants

- Educational / decision-support only. Keep that framing in tool text.
- Session state is in memory. No disk persistence, no telemetry, no
  exfiltration of plan data.
- Tool surface lives in `src/toolTable.ts`. Keep `schemas/tools.v1.json`
  in parity. Keep schemas and auth/secrets tight: do not put plan
  arguments on authorization callbacks; do not add credentials to tool
  input.
- The HTTP gateway is an unauthenticated research stub. It stays opt-in
  (`RETIREGOLDEN_HTTP_GATEWAY=1`) and loopback-only.
- No comparisons to, or integrations with, third-party retirement engines.

## Tooling

pnpm + Corepack (`packageManager` in `package.json`). Node 24+; Node 25+
needs `npm install -g corepack` before `corepack enable`.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm test
pnpm run build
```

## Pull requests

- Ready for review, never drafts.
- One PR per repo per phase. Follow-ups on the same branch.
- No publish, release, or tag unless the user asked for that activation step.
- Do not merge unless the user said to. They admin-override CLA on their own
  agent PRs.
- Never add `cursoragent` to the CLA allowlist. Do not modify
  `.github/workflows/cla.yml`.
