# Hosted / Azure Function transport (Phase 6)

Official RetireBench scored runs use **ephemeral stdio** (`npx @retiregolden/mcp` /
`retiregolden-mcp`) with pinned package versions.

This package also exposes a **HTTP stub** (`retiregolden-mcp http`) that calls the
**same adapter handlers**. It is a cost/ops experiment — wrap it in an Azure
Function (or Container App) only after proving bit-identical tool results vs
stdio for a fixture matrix.

## Cost comparison checklist

| Path | Billable unit | Notes |
|---|---|---|
| GitHub Actions + stdio MCP | Actions minutes | Spools Node per job; model API usually dominates |
| Azure Function HTTP | Executions + GB-s | Wins if Actions cold-start/runtime for MCP dominates |

## Suggested Function shape

- HTTP trigger → map `{ tool, arguments }` → adapter (see `src/http/gateway.ts`)
- Per-request or sticky session memory with short TTL
- Auth (function key / Entra) before exposing beyond private VNet
- Pin `@retiregolden/mcp` + `@retiregolden/engine` versions identically to CI

Do not treat hosted results as official leaderboard evidence until parity tests
pass.
