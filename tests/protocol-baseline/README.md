# Protocol baseline

This directory holds the pre-v2 public MCP protocol baseline for `@retiregolden/mcp`. It is deliberately a wire-level companion to `tests/goldens.test.ts`: goldens freeze the pinned engine's numeric behavior, while this file freezes what an MCP client observes from the v1 SDK. With the engine pin unchanged, a mismatch is an SDK/wire regression.

`baseline.json` is generated, reviewed, and committed deliberately. It contains:

- the negotiated stdio protocol version and sentineled `serverInfo`;
- the complete `tools/list` result and its digest;
- the `plan-schema` resource identity and canonical schema digest;
- deterministic payload hashes for one long-lived stdio session and the authorization-refusal in-memory lane.

The capture canonicalizes every value before it is stored or hashed:

- Object keys sort recursively; array order is preserved.
- Every property named `mcpVersion` is replaced with `"<mcp-version>"`, including in exports and re-import arguments. The initialize `serverInfo.version` and `meta.mcpPackage` use the same sentinel. The package's real version remains visible in git history and `CHANGELOG`.
- Every property named `solveMs` is replaced with `"<timing>"` (the optimizer's wall-clock solve time), and every property named `updatedAtIso` or `createdAtIso` with `"<timestamp>"` (engine-stamped wall-clock timestamps on plan documents). Diagnostic timing and timestamps are not part of the calculation contract.
- Numbers use ordinary `JSON.stringify` serialization. Nothing is rounded; byte equality is the contract.
- Hashes are lowercase SHA-256 hex digests of the canonical `JSON.stringify` text.
- A malformed tool call may be a JSON-RPC protocol error rather than a tool result. Its code and a digest of the message after machine-local paths are stripped are recorded, never a raw local path.

Build the package first if needed, then regenerate with:

```bash
pnpm run baseline:capture
```

Regenerate only as a deliberate, reviewed consequence of an engine bump or an intentional public protocol-contract change. Never regenerate casually to turn a red baseline test green: if the engine pin did not change, investigate the SDK/wire change as a blocking regression.
