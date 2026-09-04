/**
 * Stdio MCP server entry — one factory instance = one connection = one
 * in-memory session. `serveStdio` pins that instance for the connection
 * lifetime after the opening exchange selects the era. A `server/discover`
 * probe may construct-and-discard an instance before the connection is
 * pinned, so the factory must be side-effect-free per call.
 */

import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { createSession } from './session.js'
import { registerTools, registerResources } from './tools.js'
import { getVersions } from './versions.js'

/**
 * The version this server reports in `serverInfo`. Read through
 * `getVersions()`, which is the one place that resolves package identity (and
 * the same value `get_session` and `export_plan` report), rather than through a
 * second `createRequire('../package.json')` of its own: two readers is two
 * chances to disagree about what "the running version" means, and this one had
 * no fallback — an unresolvable package.json threw at module load instead of
 * degrading. `getVersions` never throws, so the sentinel is the visible
 * '0.0.0'.
 */
const version = getVersions().mcpVersion ?? '0.0.0'

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
