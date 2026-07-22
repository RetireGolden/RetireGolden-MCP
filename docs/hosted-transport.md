# Hosted / Azure Function transport (Phase 6)

Official RetireBench scored runs use **ephemeral stdio** (`npx @retiregolden/mcp` /
`retiregolden-mcp`) with pinned package versions.

This package also exposes an experimental **HTTP stub**, started with
`RETIREGOLDEN_HTTP_GATEWAY=1 retiregolden-mcp http`. The opt-in is required: the
stub is unauthenticated and accepts a client-supplied session id, so it must not
be one typo away from the default invocation. Without the variable the command
exits with an explanation instead of listening.

It is a cost/ops experiment — wrap it in an Azure Function (or Container App) only
after proving bit-identical tool results vs stdio for a fixture matrix.

## Stub surface (partial)

The stub is **not** at parity with stdio: it exposes only **5 of the 14** tools,
each mapped onto the same adapter handlers:

- `build_plan`
- `run_projection`
- `batch_evaluate`
- `run_optimizer`
- `explain_modeled_result`

The remaining 9 stdio tools (Monte Carlo, spending solver, scenario compare, plan
validation, `describe_plan_schema`, `update_plan`, `export_plan`, session
inspect/clear) are not reachable over HTTP yet. Do not build a full parity matrix
against this surface. The count of record is `schemas/tools.v1.json`, which the
registry-parity test holds equal to `TOOL_TABLE`.

## Request contract

- `POST /tool` with body `{ tool, arguments }`.
- An `x-session-id` header (max 128 chars) is **required** on every `/tool` request;
  each id maps to its own isolated in-memory session. Missing header →
  `400 MISSING_SESSION_ID`; over-long id → `400 INVALID_SESSION_ID`.
- Sessions expire after 30 min idle and are capped (excess → `429 TOO_MANY_SESSIONS`).
  A session slot is only allocated once a request fully validates — malformed
  JSON, unknown tools, and invalid arguments never consume one.
- Request bodies are capped at 1 MiB → `413 PAYLOAD_TOO_LARGE`. Excess payload is
  discarded (never buffered) and the 413 is sent once the upload completes, so
  clients reliably receive it; drain time is bounded by the 30s request timeout.
- Tool arguments are validated with the same zod schemas as stdio (`household`/
  `policy` shapes, `batch_evaluate` policies 1–500, objective enum) → `400 INVALID_ARGS`.
- `GET /health` is unauthenticated and reports only `{ ok, transport, sessions }`
  (a session count, never another session's plan state).

## Binding

The server binds `127.0.0.1`, and **only** a literal loopback address
(`127.0.0.1` or `::1`). `RETIREGOLDEN_HTTP_HOST` is no longer read, and passing a
non-loopback `host` programmatically is rejected before `listen`. `localhost` is
not accepted either — it resolves through the hosts file and DNS, so it is not a
reliable way to say "loopback".

**This removes the previous Azure/Container App instruction to set
`RETIREGOLDEN_HTTP_HOST=0.0.0.0`.** An unauthenticated listener on a routable
interface is not something this package will help you do. To expose the stub in a
container, publish it through a reverse proxy or sidecar that terminates auth and
forwards to loopback — the authentication has to live somewhere, and it is not in
here.

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
