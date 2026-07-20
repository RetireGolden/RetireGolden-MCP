/**
 * MCP tool registration over the headless adapter.
 *
 * The tool surface itself lives in the declarative table (src/toolTable.ts);
 * this module just iterates it and wraps each handler's payload in the MCP
 * content envelope. EDUCATIONAL and jsonResult are re-exported for consumers
 * (RetireGolden-Pro) that import them from the package root.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
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
