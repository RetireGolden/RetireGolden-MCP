/**
 * Optional HTTP / Azure Functions-style gateway over the same tool handlers.
 *
 * Official RetireBench scored runs stay on ephemeral stdio until this path
 * proves bit-identical results. This module is a cost/ops experiment surface:
 * same adapter, different transport.
 */

import { createServer } from 'node:http'
import { createSession, type SessionState } from '../session.js'
import * as adapter from '../adapter.js'
import type { BuildPlanInput, PolicyParams } from '../buildPlan.js'

const PORT = Number(process.env.PORT ?? process.env.FUNCTIONS_CUSTOMHANDLER_PORT ?? 8787)
const HOST = process.env.RETIREGOLDEN_HTTP_HOST ?? '127.0.0.1'

const MAX_BODY_BYTES = 1024 * 1024
const MAX_POLICIES = 500
const MAX_SESSIONS = 100
const SESSION_TTL_MS = 30 * 60 * 1000

interface SessionEntry {
  state: SessionState
  lastSeen: number
}

const sessions = new Map<string, SessionEntry>()

function sweepExpired(now: number): void {
  for (const [id, entry] of sessions) {
    if (now - entry.lastSeen > SESSION_TTL_MS) sessions.delete(id)
  }
}

function isPolicyShape(p: unknown): p is PolicyParams {
  if (typeof p !== 'object' || p === null) return false
  const o = p as Record<string, unknown>
  if (!Array.isArray(o.claim_ages) || !o.claim_ages.every((a) => typeof a === 'number')) return false
  if (typeof o.ordering !== 'string') return false
  return true
}

/** Enforce the same caps the stdio zod schemas apply. Returns an error code or null. */
function validateArgs(tool: string, args: Record<string, unknown>): string | null {
  if (tool === 'build_plan') {
    if (args.plan == null && (typeof args.household !== 'object' || args.household === null)) {
      return 'Provide either `plan` JSON or `household` + `policy`'
    }
    if (args.policy != null && !isPolicyShape(args.policy)) {
      return 'Invalid `policy` shape'
    }
  }
  if (tool === 'batch_evaluate') {
    const policies = args.policies
    if (!Array.isArray(policies)) return 'policies must be an array'
    if (policies.length > MAX_POLICIES) return `policies exceeds max of ${MAX_POLICIES}`
    if (!policies.every(isPolicyShape)) return 'Invalid policy in policies[]'
  }
  return null
}

/**
 * Minimal JSON-RPC-ish HTTP facade for smoke tests and future Azure Functions
 * wrapping. Not a full MCP Streamable HTTP implementation yet — Phase 6 stub.
 *
 * Exposes 5 of the 11 stdio tools: build_plan, run_projection, batch_evaluate,
 * run_optimizer, explain_modeled_result.
 */
export async function startHttpGateway(): Promise<void> {
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    const now = Date.now()
    sweepExpired(now)

    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200)
      res.end(JSON.stringify({ ok: true, transport: 'http-stub', sessions: sessions.size }))
      return
    }
    if (req.method !== 'POST' || req.url !== '/tool') {
      res.writeHead(404)
      res.end(JSON.stringify({ error: 'NOT_FOUND' }))
      return
    }

    const sessionId = req.headers['x-session-id']
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      res.writeHead(400)
      res.end(JSON.stringify({ error: 'MISSING_SESSION_ID' }))
      return
    }

    let entry = sessions.get(sessionId)
    if (!entry) {
      if (sessions.size >= MAX_SESSIONS) {
        res.writeHead(429)
        res.end(JSON.stringify({ error: 'TOO_MANY_SESSIONS' }))
        return
      }
      entry = { state: createSession(), lastSeen: now }
      sessions.set(sessionId, entry)
    }
    entry.lastSeen = now
    const session = entry.state

    const chunks: Buffer[] = []
    let received = 0
    let tooLarge = false
    for await (const chunk of req) {
      received += (chunk as Buffer).length
      if (received > MAX_BODY_BYTES) {
        tooLarge = true
        req.destroy()
        break
      }
      chunks.push(chunk as Buffer)
    }
    if (tooLarge) {
      if (!res.headersSent) {
        res.writeHead(413)
        res.end(JSON.stringify({ error: 'PAYLOAD_TOO_LARGE' }))
      }
      return
    }

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

    if (typeof tool !== 'string') {
      res.writeHead(400)
      res.end(JSON.stringify({ error: 'UNKNOWN_TOOL', tool }))
      return
    }

    const invalid = validateArgs(tool, args)
    if (invalid) {
      res.writeHead(400)
      res.end(JSON.stringify({ error: 'INVALID_ARGS', message: invalid }))
      return
    }

    let result: unknown
    try {
      switch (tool) {
        case 'build_plan':
          result = adapter.setPlanFromBuild(session, args as BuildPlanInput)
          break
        case 'run_projection':
          result = adapter.runProjection(session)
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

  server.requestTimeout = 30_000

  server.listen(PORT, HOST, () => {
    console.error(
      `RetireGolden MCP HTTP stub listening on ${HOST}:${PORT} (Phase 6 transport experiment)`,
    )
  })
}
