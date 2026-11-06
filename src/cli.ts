#!/usr/bin/env node
/**
 * CLI entry: stdio MCP by default.
 *
 * The `http` subcommand starts the fenced research transport. It needs an
 * explicit subcommand AND RETIREGOLDEN_HTTP_GATEWAY=1 — see src/http/gateway.ts
 * for why this local listener should not be one word away from the default
 * invocation.
 */

import { startStdioServer } from './server.js'

const mode = process.argv[2] ?? 'stdio'

async function main(): Promise<void> {
  if (mode === 'http') {
    const { startHttpGateway } = await import('./http/gateway.js')
    const token = process.env.RETIREGOLDEN_HTTP_GATEWAY_TOKEN
    if (token === undefined) {
      throw new Error('RETIREGOLDEN_HTTP_GATEWAY_TOKEN must be set for CLI HTTP mode')
    }
    await startHttpGateway({ token })
    return
  }
  await startStdioServer()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
