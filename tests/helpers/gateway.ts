/**
 * Start/stop plumbing shared by the HTTP gateway integration suites.
 *
 * This file is deliberately NOT named `*.test.ts`: `vitest.config.ts` pins
 * discovery to `tests/**\/*.test.ts`, so nothing under `tests/helpers/` is
 * collected as a suite. It is still typechecked — `tsconfig.json` includes
 * `tests/**\/*.ts`.
 *
 * `tests/httpGatewayFencing.test.ts` does not use this helper and should not:
 * it exercises the start-refusal paths (no opt-in, non-loopback host) and owns
 * the opt-in variable itself, so it has to call `startHttpGateway` directly.
 */

import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface TestGateway {
  /** Origin of the listening gateway, e.g. `http://127.0.0.1:54321`. */
  base: string
  /**
   * The underlying server. Exposed so a suite can assert on the instance
   * itself — notably that closing it releases its session store, which is only
   * observable by re-listening the same server and re-reading `/health`.
   */
  server: Server
  /**
   * POST to `/tool`. A string body is sent verbatim (so a suite can post
   * malformed JSON); anything else is JSON-stringified.
   */
  post(body: unknown, headers?: Record<string, string>): Promise<Response>
  /** Close the server and resolve once it has stopped listening. */
  close(): Promise<void>
}

export async function startTestGateway(): Promise<TestGateway> {
  // The gateway is a fenced research surface and refuses to start without an
  // explicit opt-in; these suites are exercising it deliberately. Vitest gives
  // each test file its own worker, so this cannot reach another suite today —
  // but the opt-in is the fence, and a helper that leaves it set is exactly how
  // a future refusal-path test would silently stop testing a refusal. Restore
  // it on close.
  const priorOptIn = process.env.RETIREGOLDEN_HTTP_GATEWAY
  process.env.RETIREGOLDEN_HTTP_GATEWAY = '1'
  const restoreOptIn = (): void => {
    if (priorOptIn === undefined) delete process.env.RETIREGOLDEN_HTTP_GATEWAY
    else process.env.RETIREGOLDEN_HTTP_GATEWAY = priorOptIn
  }

  const { startHttpGateway } = await import('../../src/http/gateway.js')
  let server: Server
  try {
    server = await startHttpGateway({ port: 0, host: '127.0.0.1' })
  } catch (e) {
    restoreOptIn()
    throw e
  }
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  return {
    base,
    server,
    post(body, headers = {}) {
      return fetch(`${base}/tool`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      })
    },
    close() {
      restoreOptIn()
      return new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
