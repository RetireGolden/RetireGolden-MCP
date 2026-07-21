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
import { TOOL_TABLE, jsonResult } from './toolTable.js'

export { EDUCATIONAL, jsonResult } from './toolTable.js'

export function registerTools(server: McpServer, session: SessionState): void {
  for (const tool of TOOL_TABLE) {
    server.tool(tool.name, tool.description, tool.inputShape, async (args) => {
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
