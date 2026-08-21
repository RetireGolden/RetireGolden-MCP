/**
 * Stdio MCP server entry — one factory instance = one connection = one
 * in-memory session. `serveStdio` pins that instance for the connection
 * lifetime after the opening exchange selects the era. A `server/discover`
 * probe may construct-and-discard an instance before the connection is
 * pinned, so the factory must be side-effect-free per call.
 */

import { createRequire } from 'node:module'
import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { createSession } from './session.js'
import { registerTools, registerResources } from './tools.js'

const require = createRequire(import.meta.url)
const { version } = require('../package.json') as { version: string }

/**
 * Construct one server for one serving unit (a pinned stdio connection, or a
 * discarded discover probe). `era` is recorded by a dual-era host; tool
 * definitions must not fork on it.
 */
export function buildServer({ era }: { era: 'legacy' | 'modern' }): McpServer {
  void era
  const server = new McpServer({
    name: 'retiregolden-mcp',
    version,
  })
  const session = createSession()
  registerTools(server, session)
  registerResources(server)
  return server
}

/**
 * Serve MCP over stdio from {@link buildServer}. Default `legacy: 'serve'`
 * (not passed): a 2025-era opening is pinned to a legacy instance; a modern
 * opening pins a modern instance. Same tools either way.
 *
 * Factory and start failures surface through the `onerror` hook because
 * `serveStdio` constructs lazily; the CLI's `main().catch` cannot observe them.
 */
export async function startStdioServer(): Promise<void> {
  const handle = serveStdio(({ era }) => buildServer({ era }), {
    onerror: (error) => {
      console.error(error)
    },
  })
  void handle
}
