# HTTP research transport

Official RetireBench scored runs use **ephemeral stdio** (`npx @retiregolden/mcp` /
`retiregolden-mcp`) with pinned package versions.

This package also carries an **HTTP research transport**, started with
`RETIREGOLDEN_HTTP_GATEWAY=1 retiregolden-mcp http`. The opt-in is required: the
transport is unauthenticated and accepts a client-supplied session id, so it must
not be one typo away from the default invocation. Without the variable the
command exits with an explanation instead of listening.

It exists to measure one thing — whether the same adapter behind a different
transport returns the same numbers as stdio for a fixture matrix. It is not a
product API, it is not exported from the package index, and it has no subpath in
the `exports` map. From an installed package the only way in is this CLI
subcommand; working in a clone of the repository you can also call
`startHttpGateway()` in `src/http/gateway.ts` directly.

Paths below that begin `src/` or `tests/` are repository paths. Neither
directory is in the published tarball, so they are references for people reading
this file in the repo, not files you can open from `node_modules`.

## Exposed surface (partial)

The transport is **not** at parity with stdio: it exposes only **5 of the 14**
tools (the `httpExposed` entries in `src/toolTable.ts`), each mapped onto the
same adapter handlers:

- `build_plan`
- `run_projection`
- `batch_evaluate`
- `run_optimizer`
- `explain_modeled_result`

The remaining 9 stdio tools (Monte Carlo, spending solver, scenario compare, plan
validation, `describe_plan_schema`, `update_plan`, `export_plan`, session
inspect/clear) are not reachable over HTTP. Do not build a full parity matrix
against this surface. The count of record is `schemas/tools.v1.json`, which the
registry-parity test holds equal to `TOOL_TABLE`;
`tests/gatewayParity.test.ts` holds this transport equal to the `httpExposed`
flags.

## Request contract

- `POST /tool` with body `{ tool, arguments }`.
- An `x-session-id` header (max 128 chars) is **required** on every `/tool` request;
  each id maps to its own isolated in-memory session. Missing header →
  `400 MISSING_SESSION_ID`; over-long id → `400 INVALID_SESSION_ID`.
- Sessions expire after 30 min idle and are capped (excess → `429 TOO_MANY_SESSIONS`).
  A session slot is only allocated once a request fully validates — malformed
  JSON, unknown tools, and invalid arguments never consume one. The store belongs
  to the running server: it is swept on a timer as well as per request, and it is
  cleared when the server closes, so plan state never outlives its listener and
  is never shared with another gateway in the same process.
- Request bodies are capped at 1 MiB → `413 PAYLOAD_TOO_LARGE`. Excess payload is
  discarded (never buffered) and the 413 is sent once the upload completes, so
  clients reliably receive it; drain time is bounded by the 30s request timeout.
- Tool arguments are validated with the same zod schemas as stdio (`household`/
  `policy` shapes, `batch_evaluate` policies 1–500, objective enum) → `400 INVALID_ARGS`.
- An exception out of a tool handler answers `500 TOOL_FAILED` and nothing else.
  The exception is written to the server's stderr; it is never echoed in the
  response body, which would leak internals to an unauthenticated caller.
- `GET /health` is unauthenticated and reports only
  `{ ok, transport: 'http-research', sessions }` (a session count, never another
  session's plan state).

## Binding

The server binds `127.0.0.1`, and **only** a literal loopback address
(`127.0.0.1` or `::1`). `RETIREGOLDEN_HTTP_HOST` is not read, and passing a
non-loopback `host` programmatically is rejected before `listen`. `localhost` is
not accepted either — it resolves through the hosts file and DNS, so it is not a
reliable way to say "loopback". `tests/httpGatewayFencing.test.ts` pins both the
clamp and the opt-in.

An unauthenticated listener on a routable interface is not something this package
will help you do, so there are no hosting instructions here. If you need this
surface reachable from anywhere but the machine it runs on, the authentication
has to live somewhere, and it is not in here.

Do not treat results from this transport as official leaderboard evidence until
parity tests pass.
