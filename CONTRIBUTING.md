# Contributing to RetireGolden-MCP

Thanks for helping improve the RetireGolden Model Context Protocol server.

## Before you start

- This package is a thin, read-only adapter over
  [`@retiregolden/engine`](https://www.npmjs.com/package/@retiregolden/engine).
  Money math stays in the engine; this repo should not reimplement tax or
  projection rules.
- Read [DISCLAIMER.md](DISCLAIMER.md) and keep tool descriptions educational /
  decision-support only.

## Development

```bash
corepack enable   # installs the packageManager pnpm shim
pnpm install --frozen-lockfile
pnpm test
pnpm run build
pnpm run mcp   # stdio MCP server
```

**Requirements:** Node.js 20+ with Corepack. `packageManager` in
`package.json` pins pnpm; `corepack enable` is what creates the `pnpm`
executable. Newer Node releases may need Corepack installed separately
(see [Corepack](https://github.com/nodejs/corepack#how-to-install)).

## Licensing of contributions

Server code is **AGPL-3.0-only** ([LICENSE](LICENSE)). Skills under `skills/`
are **MIT** ([skills/LICENSE](skills/LICENSE)).

RetireGolden, LLC also ships a commercial desktop edition that may consume this
package. **All contributions require signing our [Contributor License
Agreement](CLA.md)** — a one-time step on your first pull request (CLA bot).
You keep copyright; the CLA lets the LLC relicense for the commercial edition
while this repo stays AGPL.

- Employer-owned work needs a [Corporate CLA](CLA-CORPORATE.md) on file.
- Disclose material generative-AI contributions in the PR.

## What makes a good PR

- One focused change; tests updated alongside it.
- No new runtime dependencies without discussion.
- No telemetry or network exfiltration of plan data.
- Do not add comparisons to, or integrations with, third-party retirement
  engines in this repository.

## Security

See [SECURITY.md](SECURITY.md).
