/**
 * Stdio MCP server entry — in-memory session per process.
 */

import { createRequire } from 'node:module'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createSession } from './session.js'
import { registerTools } from './tools.js'

const require = createRequire(import.meta.url)
const { version } = require('../package.json') as { version: string }

export async function startStdioServer(): Promise<void> {
  const server = new McpServer({
    name: 'retiregolden-mcp',
    version,
  })
  const session = createSession()
  registerTools(server, session)
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
