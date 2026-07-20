/**
 * Optional HTTP / Azure Functions-style gateway over the same tool handlers.
 *
 * Official RetireBench scored runs stay on ephemeral stdio until this path
 * proves bit-identical results. This module is a cost/ops experiment surface:
 * same adapter, different transport.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { z } from 'zod'
import { createSession, type SessionState } from '../session.js'
import * as adapter from '../adapter.js'
import {
  HouseholdParamsSchema,
  PolicyParamsSchema,
  ConversionSchema,
  type BuildPlanInput,
  type PolicyParams,
} from '../buildPlan.js'

const DEFAULT_PORT = Number(process.env.PORT ?? process.env.FUNCTIONS_CUSTOMHANDLER_PORT ?? 8787)
const DEFAULT_HOST = process.env.RETIREGOLDEN_HTTP_HOST ?? '127.0.0.1'

const MAX_BODY_BYTES = 1024 * 1024
const MAX_POLICIES = 500
const MAX_SESSIONS = 100
const MAX_SESSION_ID_LENGTH = 128
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

const PoliciesSchema = z.array(PolicyParamsSchema).min(1).max(MAX_POLICIES)
const ObjectiveSchema = z.enum(['after_tax_estate', 'cumulative_tax', 'ending_trad'])

function zodIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
}

/** Enforce the same constraints the stdio zod schemas apply. Returns an error message or null. */
function validateArgs(tool: string, args: Record<string, unknown>): string | null {
  if (tool === 'build_plan') {
    if (args.plan == null) {
      if (args.household == null || args.policy == null) {
        return 'Provide either `plan` JSON or both `household` and `policy`'
      }
      const h = HouseholdParamsSchema.safeParse(args.household)
      if (!h.success) return `Invalid household: ${zodIssues(h.error)}`
      const p = PolicyParamsSchema.safeParse(args.policy)
      if (!p.success) return `Invalid policy: ${zodIssues(p.error)}`
    }
    if (args.conversion != null) {
      const c = ConversionSchema.safeParse(args.conversion)
      if (!c.success) return `Invalid conversion: ${zodIssues(c.error)}`
    }
  }
  if (tool === 'batch_evaluate') {
    const policies = PoliciesSchema.safeParse(args.policies)
    if (!policies.success) return `Invalid policies: ${zodIssues(policies.error)}`
    if (args.objective != null && !ObjectiveSchema.safeParse(args.objective).success) {
      return 'Invalid objective: expected after_tax_estate | cumulative_tax | ending_trad'
    }
  }
  return null
}

/**
 * Read the request body up to MAX_BODY_BYTES. On overflow, responds 413 before
 * tearing the connection down and returns null.
 */
function readBody(req: IncomingMessage, res: ServerResponse): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let received = 0
    let tooLarge = false
    let settled = false
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return
      received += chunk.length
      if (received > MAX_BODY_BYTES) {
        // Discard the payload but keep consuming the stream: responding while
        // the client is still uploading races the socket close (observed as
        // ECONNRESET on macOS). The 413 is sent once the request stream ends,
        // so it always reaches the client; time is bounded by requestTimeout.
        tooLarge = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      if (tooLarge) {
        res.writeHead(413)
        res.end(JSON.stringify({ error: 'PAYLOAD_TOO_LARGE' }))
        resolve(null)
        return
      }
      resolve(Buffer.concat(chunks))
    })
    req.on('error', () => {
      if (settled) return
      settled = true
      resolve(null)
    })
  })
}

/**
 * Minimal JSON-RPC-ish HTTP facade for smoke tests and future Azure Functions
 * wrapping. Not a full MCP Streamable HTTP implementation yet — Phase 6 stub.
 *
 * Exposes 5 of the 11 stdio tools: build_plan, run_projection, batch_evaluate,
 * run_optimizer, explain_modeled_result.
 *
 * Resolves with the listening http.Server so embedders and tests can close it.
 */
export async function startHttpGateway(
  opts: { port?: number; host?: string } = {},
): Promise<Server> {
  const port = opts.port ?? DEFAULT_PORT
  const host = opts.host ?? DEFAULT_HOST

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
    if (sessionId.length > MAX_SESSION_ID_LENGTH) {
      res.writeHead(400)
      res.end(
        JSON.stringify({
          error: 'INVALID_SESSION_ID',
          message: `x-session-id exceeds ${MAX_SESSION_ID_LENGTH} characters`,
        }),
      )
      return
    }

    const raw = await readBody(req, res)
    if (raw == null) return

    let body: { tool?: string; arguments?: Record<string, unknown> }
    try {
      body = JSON.parse(raw.toString('utf8')) as typeof body
    } catch {
      res.writeHead(400)
      res.end(JSON.stringify({ error: 'INVALID_JSON' }))
      return
    }
    const tool = body.tool
    const args = body.arguments ?? {}

    const KNOWN_TOOLS = [
      'build_plan',
      'run_projection',
      'batch_evaluate',
      'run_optimizer',
      'explain_modeled_result',
    ]
    if (typeof tool !== 'string' || !KNOWN_TOOLS.includes(tool)) {
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

    // Allocate the session only for a fully validated request so malformed or
    // oversized traffic cannot exhaust the session cap.
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
            args.policies as PolicyParams[],
            (args.objective as 'after_tax_estate') ?? 'after_tax_estate',
          )
          break
        case 'run_optimizer':
          result = await adapter.runOptimizer(session)
          break
        case 'explain_modeled_result':
          result = adapter.explainModeledResult(session)
          break
      }
      res.writeHead(200)
      res.end(JSON.stringify(result))
    } catch (e) {
      res.writeHead(500)
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }))
    }
  })

  server.requestTimeout = 30_000

  await new Promise<void>((resolve) => {
    server.listen(port, host, () => {
      const addr = server.address()
      const boundPort = addr && typeof addr === 'object' ? addr.port : port
      console.error(
        `RetireGolden MCP HTTP stub listening on ${host}:${boundPort} (Phase 6 transport experiment)`,
      )
      resolve()
    })
  })
  return server
}
