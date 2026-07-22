/**
 * MCP tool registration over the headless adapter.
 *
 * The tool surface itself lives in the declarative table (src/toolTable.ts);
 * this module just iterates it and wraps each handler's payload in the MCP
 * content envelope. EDUCATIONAL and jsonResult are re-exported for consumers
 * (RetireGolden-Pro) that import them from the package root.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  planJsonSchema,
  PLAN_SCHEMA_ID,
  PLAN_SCHEMA_VERSION,
} from '@retiregolden/engine/schema'
import type { SessionState } from './session.js'
import { TOOL_TABLE, jsonResult, type ToolEntry } from './toolTable.js'

export { EDUCATIONAL, jsonResult } from './toolTable.js'

/**
 * What an authorization callback is told about a pending call.
 *
 * Deliberately carries NO tool arguments. `build_plan` and `update_plan` accept
 * whole plan documents, so passing args here would route a user's financial data
 * into a host's policy layer — and a host that logged its authorization
 * decisions would then be logging plan contents by accident. Withholding them
 * makes "no plan data reaches a policy or diagnostic surface" a property of this
 * signature rather than a rule every caller has to remember.
 *
 * The trade is real and worth stating: a callback cannot make argument-dependent
 * decisions. Per-tool granularity is the intended axis. An argument-aware gate
 * belongs in the caller's own handler, not here.
 */
export interface ToolAuthorizationRequest {
  name: string
  entry: ToolEntry
}

/**
 * Allow, or refuse with the exact payload the model should see.
 *
 * A refusal returns a `result` rather than throwing. The SDK turns a thrown
 * handler into an opaque `isError` result that flattens to a message string,
 * discarding any structured code or remedy — which is precisely the
 * unexplainable failure a consuming host would be adding this hook to remove.
 */
export type ToolAuthorizationDecision =
  | { allow: true }
  | { allow: false; result: unknown }

export type AuthorizeTool = (
  request: ToolAuthorizationRequest,
) => ToolAuthorizationDecision | Promise<ToolAuthorizationDecision>

export interface RegisterToolsOptions {
  /**
   * Consulted before each tool handler runs. Omit it and registration behaves
   * exactly as it always has — tests/registerTools.test.ts asserts inventory and
   * result identity across the with-callback and without-callback paths.
   */
  authorize?: AuthorizeTool
}

export function registerTools(
  server: McpServer,
  session: SessionState,
  options: RegisterToolsOptions = {},
): void {
  const { authorize } = options
  for (const tool of TOOL_TABLE) {
    server.tool(tool.name, tool.description, tool.inputShape, async (args) => {
      // Guarded rather than defaulted to a no-op callback: with no `authorize`,
      // the handler runs the same two statements it always did.
      if (authorize) {
        const decision = await authorize({ name: tool.name, entry: tool })
        if (!decision.allow) return jsonResult(decision.result)
      }
      const result = await tool.handler(session, args as Record<string, unknown>)
      return jsonResult(result)
    })
  }
}

/**
 * Register the Plan JSON Schema as an MCP resource, serving the same
 * engine-owned document as the describe_plan_schema tool (the plan calls for
 * "tool + MCP resource"). Read-only; the resource carries no session state, so
 * it is registered once against the server.
 *
 * No authorization hook here, deliberately: this serves one static document —
 * the engine's own schema, identical to what `npx @retiregolden/mcp` publishes —
 * through a callback that receives no session and so cannot reach user data.
 */
export function registerResources(server: McpServer): void {
  server.resource(
    'plan-schema',
    PLAN_SCHEMA_ID,
    {
      description: `RetireGolden engine Plan JSON Schema (v${PLAN_SCHEMA_VERSION}) — the source of truth for authoring a full plan document.`,
      mimeType: 'application/json',
    },
    () => ({
      contents: [
        {
          uri: PLAN_SCHEMA_ID,
          mimeType: 'application/json',
          text: JSON.stringify(planJsonSchema),
        },
      ],
    }),
  )
}
