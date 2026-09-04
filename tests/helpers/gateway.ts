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

import type { AddressInfo } from 'node:net'

export interface TestGateway {
  /** Origin of the listening gateway, e.g. `http://127.0.0.1:54321`. */
  base: string
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
  // explicit opt-in; these suites are exercising it deliberately.
  process.env.RETIREGOLDEN_HTTP_GATEWAY = '1'
  const { startHttpGateway } = await import('../../src/http/gateway.js')
  const server = await startHttpGateway({ port: 0, host: '127.0.0.1' })
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  return {
    base,
    post(body, headers = {}) {
      return fetch(`${base}/tool`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      })
    },
    close() {
      return new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
