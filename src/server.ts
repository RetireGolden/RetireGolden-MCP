/**
 * Stdio MCP server entry — in-memory session per process.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createSession } from './session.js'
import { registerTools } from './tools.js'

export async function startStdioServer(): Promise<void> {
  const server = new McpServer({
    name: 'retiregolden-mcp',
    version: '0.1.0',
  })
  const session = createSession()
  registerTools(server, session)
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
