# HTTP research gateway

Optional transport under `src/http/` (`gateway.ts`). Not exported as a product API; documented in [`docs/hosted-transport.md`](../../docs/hosted-transport.md).

**Opt-in:** requires `RETIREGOLDEN_HTTP_GATEWAY=1` and the `http` CLI subcommand. Without both, the gateway does not listen. Default invocation remains stdio-only.

**Loopback only:** binds literal `127.0.0.1` or `::1` only (`localhost` is rejected). **Unauthenticated** by design—a RetireBench research stub, not production auth.

Do not flag missing production authentication in isolation. Report actual widening of documented bind, access, or data boundaries, or broken opt-in/env validation.

Exposes a subset of tools (`httpExposed` in `toolTable.ts`); stdio parity is not a goal. Reproduce issues with opt-in set, following the request through the shared handler to the engine. Contract or exposure questions are design context, not invented bugs.
