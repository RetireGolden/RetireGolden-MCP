/**
 * Optional HTTP / Azure Functions-style gateway over the same tool handlers.
 *
 * Official RetireBench scored runs stay on ephemeral stdio until this path
 * proves bit-identical results. This module is a cost/ops experiment surface:
 * same adapter, different transport.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createSession, type SessionState } from '../session.js'
import { getTool, validateToolArgs } from '../toolTable.js'

/**
 * FENCED SURFACE. This gateway is a RetireBench cost/ops research transport,
 * not a supported product API: it is unauthenticated, it accepts a
 * client-supplied session id, and it speaks a bespoke /tool protocol rather
 * than Streamable HTTP. It is not exported from the package index and cannot be
 * imported by subpath (the `exports` map has no entry for it), so the only ways
 * in are this module directly and the CLI subcommand — both now opt-in.
 *
 * Two rules hold regardless of environment or arguments:
 *  - it binds loopback only, and
 *  - it does not start unless RETIREGOLDEN_HTTP_GATEWAY=1 is set.
 *
 * The host clamp is enforced against `opts.host` and not just the environment,
 * because opts is a second, equally open channel into `server.listen`.
 */
export const HTTP_GATEWAY_OPT_IN_ENV = 'RETIREGOLDEN_HTTP_GATEWAY'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

function assertLoopback(host: string): string {
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `RetireGolden HTTP gateway refuses to bind ${host}: loopback only ` +
        `(${[...LOOPBACK_HOSTS].join(', ')}).`,
    )
  }
  return host
}

function assertOptedIn(): void {
  if (process.env[HTTP_GATEWAY_OPT_IN_ENV] !== '1') {
    throw new Error(
      'RetireGolden HTTP gateway is a research surface and is off by default. ' +
        `Set ${HTTP_GATEWAY_OPT_IN_ENV}=1 to start it.`,
    )
  }
}

const DEFAULT_PORT = 8787
const DEFAULT_HOST = '127.0.0.1'

const MAX_BODY_BYTES = 1024 * 1024
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
 * The tool surface, arg schemas, and handlers are shared with stdio via the
 * declarative table (src/toolTable.ts); only the tools flagged httpExposed are
 * reachable here (build_plan, run_projection, batch_evaluate, run_optimizer,
 * explain_modeled_result). Everything else answers UNKNOWN_TOOL.
 *
 * Resolves with the listening http.Server so embedders and tests can close it.
 */
export async function startHttpGateway(
  opts: { port?: number; host?: string } = {},
): Promise<Server> {
  assertOptedIn()
  const port = opts.port ?? DEFAULT_PORT
  const host = assertLoopback(opts.host ?? DEFAULT_HOST)

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

    const toolEntry = typeof tool === 'string' ? getTool(tool) : undefined
    if (!toolEntry || !toolEntry.httpExposed) {
      res.writeHead(400)
      res.end(JSON.stringify({ error: 'UNKNOWN_TOOL', tool }))
      return
    }

    const invalid = validateToolArgs(toolEntry, args)
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

    try {
      const result = await toolEntry.handler(session, args)
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
