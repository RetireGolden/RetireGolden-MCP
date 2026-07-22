#!/usr/bin/env node
/**
 * CLI entry: stdio MCP by default.
 *
 * The `http`/`azure` subcommand starts a fenced research transport and is off
 * unless RETIREGOLDEN_HTTP_GATEWAY=1 — see src/http/gateway.ts for why. Without
 * the opt-in a typo like `retiregolden-mcp htp` falling through to `http` used
 * to open an unauthenticated listener.
 */

import { startStdioServer } from './server.js'

const mode = process.argv[2] ?? 'stdio'

async function main(): Promise<void> {
  if (mode === 'http' || mode === 'azure') {
    const { startHttpGateway } = await import('./http/gateway.js')
    await startHttpGateway()
    return
  }
  await startStdioServer()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
