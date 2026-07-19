/**
 * Optional HTTP / Azure Functions-style gateway over the same tool handlers.
 *
 * Official RetireBench scored runs stay on ephemeral stdio until this path
 * proves bit-identical results. This module is a cost/ops experiment surface:
 * same adapter, different transport.
 */

import { createServer } from 'node:http'
import { createSession } from '../session.js'
import * as adapter from '../adapter.js'
import type { BuildPlanInput, PolicyParams } from '../buildPlan.js'

const PORT = Number(process.env.PORT ?? process.env.FUNCTIONS_CUSTOMHANDLER_PORT ?? 8787)

/**
 * Minimal JSON-RPC-ish HTTP facade for smoke tests and future Azure Functions
 * wrapping. Not a full MCP Streamable HTTP implementation yet — Phase 6 stub.
 */
export async function startHttpGateway(): Promise<void> {
  const session = createSession()

  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200)
      res.end(JSON.stringify({ ok: true, transport: 'http-stub', hasPlan: session.plan != null }))
      return
    }
    if (req.method !== 'POST' || req.url !== '/tool') {
      res.writeHead(404)
      res.end(JSON.stringify({ error: 'NOT_FOUND' }))
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    let body: { tool?: string; arguments?: Record<string, unknown> }
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof body
    } catch {
      res.writeHead(400)
      res.end(JSON.stringify({ error: 'INVALID_JSON' }))
      return
    }
    const tool = body.tool
    const args = body.arguments ?? {}
    let result: unknown
    try {
      switch (tool) {
        case 'build_plan':
          result = adapter.setPlanFromBuild(session, args as BuildPlanInput)
          break
        case 'run_projection':
          result = adapter.runProjection(session, args.startYear as number | undefined)
          break
        case 'batch_evaluate':
          result = adapter.batchEvaluate(
            session,
            (args.policies as PolicyParams[]) ?? [],
            (args.objective as 'after_tax_estate') ?? 'after_tax_estate',
          )
          break
        case 'run_optimizer':
          result = await adapter.runOptimizer(session)
          break
        case 'explain_modeled_result':
          result = adapter.explainModeledResult(session)
          break
        default:
          res.writeHead(400)
          res.end(JSON.stringify({ error: 'UNKNOWN_TOOL', tool }))
          return
      }
      res.writeHead(200)
      res.end(JSON.stringify(result))
    } catch (e) {
      res.writeHead(500)
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }))
    }
  })

  server.listen(PORT, () => {
    console.error(`RetireGolden MCP HTTP stub listening on :${PORT} (Phase 6 transport experiment)`)
  })
}
