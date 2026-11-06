/**
 * Optional HTTP research transport over the same tool handlers.
 *
 * Official RetireBench scored runs stay on ephemeral stdio until this path
 * proves bit-identical results. This module is the same adapter behind a
 * different transport, kept behind the fence described below.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createSession, type SessionState } from '../session.js'
import { getTool, parseToolArgs } from '../toolTable.js'
import { stringifyBoundedJson } from '../limits.js'

/**
 * FENCED SURFACE. This gateway is a RetireBench cost/ops research transport,
 * not a supported product API: it accepts a
 * client-supplied session id, and it speaks a bespoke /tool protocol rather
 * than Streamable HTTP. It is not exported from the package index and cannot be
 * imported by subpath (the `exports` map has no entry for it), so the only ways
 * in are this module directly and the CLI subcommand — both now opt-in.
 *
 * Two rules hold regardless of environment or arguments:
 *  - it binds a literal loopback address only, and
 *  - it does not start unless RETIREGOLDEN_HTTP_GATEWAY=1 is set.
 *
 * The host clamp is enforced against `opts.host` and not just the environment,
 * because opts is a second, equally open channel into `server.listen`.
 */
export const HTTP_GATEWAY_OPT_IN_ENV = 'RETIREGOLDEN_HTTP_GATEWAY'
export const HTTP_GATEWAY_TOKEN_ENV = 'RETIREGOLDEN_HTTP_GATEWAY_TOKEN'
const gatewayTokens = new WeakMap<Server, string>()

export function getHttpGatewayToken(server: Server): string | undefined {
  return gatewayTokens.get(server)
}

function validToken(token: string): boolean {
  return token.length >= 32 && /^[\x21-\x7e]+$/u.test(token)
}

function resolveToken(explicit?: string): string {
  const configured = explicit ?? process.env[HTTP_GATEWAY_TOKEN_ENV]
  if (configured === undefined) return randomBytes(32).toString('base64url')
  const source = explicit !== undefined ? 'opts.token' : HTTP_GATEWAY_TOKEN_ENV
  if (!validToken(configured)) throw new Error(`${source} must be at least 32 printable ASCII characters with no whitespace`)
  return configured
}

function tokenMatches(actual: string, expected: string): boolean {
  const a = createHash('sha256').update(actual).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

/**
 * Literal loopback addresses only. `localhost` is deliberately NOT accepted:
 * it resolves through the hosts file and DNS, so a machine that maps it to a
 * routable address would bind there and defeat the rule this list exists to
 * enforce. Callers pass an address, not a name.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1'])

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
const SESSION_SWEEP_INTERVAL_MS = 60 * 1000

interface SessionEntry {
  state: SessionState
  lastSeen: number
}

function sweepExpired(sessions: Map<string, SessionEntry>, now: number): void {
  for (const [id, entry] of sessions) {
    if (now - entry.lastSeen > SESSION_TTL_MS) sessions.delete(id)
  }
}

/**
 * Read the request body up to MAX_BODY_BYTES. On overflow, responds 413 before
 * tearing the connection down and returns null.
 */
function readBody(req: IncomingMessage, res: ServerResponse): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
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
    req.on('error', (error) => {
      if (settled) return
      settled = true
      if (req.aborted || req.destroyed || (error as NodeJS.ErrnoException).code === 'ECONNRESET') {
        resolve(null)
      } else {
        reject(error)
      }
    })
    req.on('aborted', () => {
      if (settled) return
      settled = true
      resolve(null)
    })
  })
}

/**
 * Minimal JSON-RPC-ish HTTP facade for smoke tests on the research transport.
 * Not a full MCP Streamable HTTP implementation, and not a supported product
 * API: bearer-authenticated, loopback-only, and opt-in (see the fence note above).
 *
 * The tool surface, arg schemas, and handlers are shared with stdio via the
 * declarative table (src/toolTable.ts); only the tools flagged httpExposed are
 * reachable here (build_plan, run_projection, batch_evaluate, run_optimizer,
 * explain_modeled_result). Everything else answers UNKNOWN_TOOL.
 *
 * Resolves with the listening http.Server so embedders and tests can close it.
 */
export async function startHttpGateway(
  opts: { port?: number; host?: string; token?: string } = {},
): Promise<Server> {
  assertOptedIn()
  const port = opts.port ?? DEFAULT_PORT
  const host = assertLoopback(opts.host ?? DEFAULT_HOST)
  const token = resolveToken(opts.token)

  // One store per gateway instance, not per module. Plan state is in-memory and
  // must not outlive the listener that accepted it: a module-global map is
  // shared by every instance started in the process (so two gateways would see
  // each other's sessions) and survives close(), leaving plan data resident in a
  // process that no longer has a listener.
  const sessions = new Map<string, SessionEntry>()

  let server: Server
  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    res.setHeader('Content-Type', 'application/json')
    const address = server.address()
    if (!address || typeof address !== 'object') throw new Error('gateway has no bound address')
    const expectedAuthority = host === '::1' ? `[::1]:${address.port}` : `127.0.0.1:${address.port}`
    if (req.headers.host !== expectedAuthority) {
      res.writeHead(403)
      res.end(JSON.stringify({ error: 'INVALID_HOST' }))
      return
    }
    const origin = req.headers.origin
    if (origin !== undefined && origin !== `http://${expectedAuthority}`) {
      res.writeHead(403)
      res.end(JSON.stringify({ error: 'INVALID_ORIGIN' }))
      return
    }
    const fetchSite = req.headers['sec-fetch-site']
    if (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none') {
      res.writeHead(403)
      res.end(JSON.stringify({ error: 'INVALID_FETCH_SITE' }))
      return
    }
    const authorization = req.headers.authorization
    const supplied = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
    if (!supplied || !tokenMatches(supplied, token)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Bearer' })
      res.end(JSON.stringify({ error: 'UNAUTHORIZED' }))
      return
    }
    const now = Date.now()
    sweepExpired(sessions, now)

    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200)
      res.end(JSON.stringify({ ok: true, transport: 'http-research', sessions: sessions.size }))
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
      const decoded: unknown = JSON.parse(raw.toString('utf8'))
      if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) throw new Error('shape')
      body = decoded as typeof body
    } catch {
      res.writeHead(400)
      res.end(JSON.stringify({ error: 'INVALID_JSON' }))
      return
    }
    const tool = body.tool
    if (body.arguments !== undefined && (typeof body.arguments !== 'object' || body.arguments === null || Array.isArray(body.arguments))) {
      res.writeHead(400)
      res.end(JSON.stringify({ error: 'INVALID_ARGS' }))
      return
    }
    const args = body.arguments ?? {}

    const toolEntry = typeof tool === 'string' ? getTool(tool) : undefined
    if (!toolEntry || !toolEntry.httpExposed) {
      res.writeHead(400)
      res.end(JSON.stringify({ error: 'UNKNOWN_TOOL', tool }))
      return
    }

    const validated = parseToolArgs(toolEntry, args)
    if (!validated.ok) {
      res.writeHead(400)
      res.end(JSON.stringify({ error: 'INVALID_ARGS', message: validated.message }))
      return
    }
    // The PARSED arguments, not the raw body: the tool shapes are non-strict, so
    // parsing prunes unknown and retired keys exactly as the stdio transport's
    // SDK does. Handing the handler the raw body let an HTTP caller push e.g.
    // `conventions.lawSunsetFreezeYear` into session state on one transport only.
    // @see toolTable.parseToolArgs
    const toolArgs = validated.args

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
      const result = await toolEntry.handler(session, toolArgs)
      const text = stringifyBoundedJson(result)
      res.writeHead(200)
      res.end(text)
    } catch (e) {
      // The response body carries a fixed code, never the exception text. An
      // unexpected throw out of a handler can quote engine internals, a file
      // path, or a fragment of the caller's own plan data, and this listener is
      // outside the response. The detail goes to the operator's stderr instead.
      console.error('RetireGolden HTTP gateway: tool handler threw', e)
      res.writeHead(500)
      res.end(JSON.stringify({ error: 'TOOL_FAILED' }))
    }
  }
  server = createServer((req, res) => {
    void handleRequest(req, res).catch((error: unknown) => {
      if (req.aborted || res.destroyed || res.writableEnded) return
      console.error('RetireGolden HTTP gateway: request failed', error)
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'INTERNAL_ERROR' }))
      } else {
        res.destroy()
      }
    })
  })
  gatewayTokens.set(server, token)

  server.requestTimeout = 30_000

  // The per-request sweep only runs while traffic arrives, so an idle gateway
  // would hold expired plan state indefinitely. This timer expires it anyway.
  // unref() so it never by itself keeps the process alive.
  const sweepTimer = setInterval(
    () => sweepExpired(sessions, Date.now()),
    SESSION_SWEEP_INTERVAL_MS,
  )
  sweepTimer.unref()

  server.on('close', () => {
    clearInterval(sweepTimer)
    sessions.clear()
  })

  await new Promise<void>((resolve, reject) => {
    // A bind failure (EADDRINUSE on the default port is the likely one) arrives
    // as an 'error' event, not a throw. With no listener that is an uncaught
    // exception, and the caller never learns the gateway is not listening. Fail
    // the start instead, and release what the start already allocated — the
    // sweep timer is armed above and the 'close' handler that would clear it
    // never runs for a server that never listened.
    const onListenError = (err: Error): void => {
      clearInterval(sweepTimer)
      sessions.clear()
      reject(err)
    }
    server.once('error', onListenError)
    server.listen(port, host, () => {
      server.removeListener('error', onListenError)
      const addr = server.address()
      const boundPort = addr && typeof addr === 'object' ? addr.port : port
      console.error(
        `RetireGolden MCP HTTP research transport listening on ${host}:${boundPort} ` +
          `(bearer-authenticated, loopback-only, opt-in)`,
      )
      resolve()
    })
  })
  return server
}
