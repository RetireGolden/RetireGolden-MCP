#!/usr/bin/env node
/**
 * CLI entry: stdio MCP by default.
 *
 * The `http`/`azure` subcommand starts a fenced research transport. It needs an
 * explicit subcommand AND RETIREGOLDEN_HTTP_GATEWAY=1 — see src/http/gateway.ts
 * for why an unauthenticated listener should not be one word away from the
 * default invocation.
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
