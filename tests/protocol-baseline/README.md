# Protocol baseline

This directory holds the pre-v2 public MCP protocol baseline for `@retiregolden/mcp`. It is deliberately a wire-level companion to `tests/goldens.test.ts`: goldens freeze the pinned engine's numeric behavior, while this file freezes what an MCP client observes from the v1 SDK. With the engine pin unchanged, a mismatch is an SDK/wire regression.

`baseline.json` is generated, reviewed, and committed deliberately. It contains:

- the negotiated stdio protocol version, sentineled `serverInfo`, and the initialize `serverCapabilities` and `serverInstructions` returned by the client;
- the complete `tools/list` result and its digest;
- the complete `resources/list` and `resources/read` responses and their digests, plus the `plan-schema` resource identity, content URI (must match the advertised URI), and canonical schema digest;
- deterministic payload hashes and envelope fingerprints for one long-lived stdio session and the authorization-refusal in-memory lane.

The capture canonicalizes every value before it is stored or hashed:

- Object keys sort recursively; array order is preserved.
- Every property named `mcpVersion` is replaced with `"<mcp-version>"`, including in exports and re-import arguments. The initialize `serverInfo.version` and `meta.mcpPackage` use the same sentinel. The package's real version remains visible in git history and `CHANGELOG`.
- Every property named `solveMs` is replaced with `"<timing>"` (the optimizer's wall-clock solve time), and every property named `updatedAtIso` or `createdAtIso` with `"<timestamp>"` (engine-stamped wall-clock timestamps on plan documents). Diagnostic timing and timestamps are not part of the calculation contract.
- Sentinels apply only when the value has the expected shape: `mcpVersion` must be a string (null stays null), `solveMs` must be finite, and ISO timestamp fields must match the ISO-8601 pattern. A volatile field that changes type is drift, not noise.
- Numbers use ordinary `JSON.stringify` serialization. Nothing is rounded; byte equality is the contract.
- Hashes are lowercase SHA-256 hex digests of the canonical `JSON.stringify` text.
- Each successful tool call stores both a `payloadHash` (first text block parsed as JSON) and an `envelopeHash` over the full `CallToolResult` shape: `isError`, every content block canonicalized in full (text blocks spread all fields except `text`, which becomes parsed canonical JSON or stripped plain text; non-text blocks are canonicalized whole), and optional `structuredContent` / `_meta` when present. Reordering, adding, or removing content blocks therefore fails the baseline even when the first text payload is unchanged.
- `resources/list` and `resources/read` each get a digest over the complete SDK response. Capture verifies that the read content item's `uri` equals the URI advertised in `resources/list`; the schema must be served under its advertised URI, not merely as the first content item.
- Capture refuses to run unless the resolved `@modelcontextprotocol/sdk` dev dependency is v1 (`1.*`). The baseline observer stays the frozen v1 client even after the server migrates to v2 packages under different names; do not observe the migration through the SDK generation being migrated to.
- Machine-local paths are stripped before error messages and non-JSON text enter a fingerprint. Known checkout and home-directory roots (including paths with spaces) and the current username are replaced before generic path regexes run.
- A malformed tool call may be a JSON-RPC protocol error rather than a tool result. Its code and a digest of the message after machine-local paths are stripped are recorded, never a raw local path.

Build the package first if needed, then regenerate with:

```bash
pnpm run baseline:capture
```

Regenerate only as a deliberate, reviewed consequence of an engine bump or an intentional public protocol-contract change. Never regenerate casually to turn a red baseline test green: if the engine pin did not change, investigate the SDK/wire change as a blocking regression.
