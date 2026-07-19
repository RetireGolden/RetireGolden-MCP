#!/usr/bin/env node
import { startStdioServer } from '../dist/server.js'

const mode = process.argv[2] ?? 'stdio'

async function main() {
  if (mode === 'http' || mode === 'azure') {
    const { startHttpGateway } = await import('../dist/http/gateway.js')
    await startHttpGateway()
    return
  }
  await startStdioServer()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
