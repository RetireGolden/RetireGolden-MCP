#!/usr/bin/env node
/**
 * CLI entry: stdio MCP by default; `http` subcommand reserved for hosted transport.
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
