/**
 * The gateway's session store belongs to one gateway instance, not to the
 * module. Two properties follow, and both are security properties rather than
 * tidiness: in-memory plan state must not leak from one listener to another
 * inside a process, and it must not outlive the listener that accepted it.
 */

import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { singleHousehold, singlePolicy } from './fixtures.js'
import { startTestGateway, type TestGateway } from './helpers/gateway.js'

async function sessionCount(base: string): Promise<number> {
  return ((await (await fetch(`${base}/health`)).json()) as { sessions: number }).sessions
}

const buildBody = {
  tool: 'build_plan',
  arguments: { household: singleHousehold, policy: singlePolicy, startYear: 2026 },
}

const open: TestGateway[] = []

async function start(): Promise<TestGateway> {
  const gateway = await startTestGateway()
  open.push(gateway)
  return gateway
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((gateway) => gateway.close()))
})

describe('gateway session store lifecycle', () => {
  it('does not share sessions between two gateway instances in one process', async () => {
    const a = await start()
    const b = await start()

    const built = await a.post(buildBody, { 'x-session-id': 'shared-id' })
    expect(built.status).toBe(200)
    expect(((await built.json()) as { ok: boolean }).ok).toBe(true)

    // Same session id, other listener: a module-global store would hand this
    // request the plan built above.
    const onB = await b.post({ tool: 'explain_modeled_result' }, { 'x-session-id': 'shared-id' })
    expect(onB.status).toBe(200)
    expect(((await onB.json()) as { hasPlan: boolean }).hasPlan).toBe(false)

    // And the plan is still there on the instance that accepted it.
    const onA = await a.post({ tool: 'explain_modeled_result' }, { 'x-session-id': 'shared-id' })
    expect(((await onA.json()) as { hasPlan: boolean }).hasPlan).toBe(true)
  })

  it('releases sessions when the server closes', async () => {
    const gateway = await start()
    const built = await gateway.post(buildBody, { 'x-session-id': 'released' })
    expect(built.status).toBe(200)
    expect(await sessionCount(gateway.base)).toBe(1)

    await gateway.close()
    open.length = 0

    // The store is a closure variable, so "it was cleared" is only observable
    // through the *same* server: re-listen it and ask again. A second
    // startHttpGateway() call would report 0 whether or not close() cleared
    // anything, because it gets a fresh map either way.
    const { server } = gateway
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    try {
      const relisted = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      expect(await sessionCount(relisted)).toBe(0)

      const after = await fetch(`${relisted}/tool`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-session-id': 'released' },
        body: JSON.stringify({ tool: 'explain_modeled_result' }),
      })
      expect(((await after.json()) as { hasPlan: boolean }).hasPlan).toBe(false)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('sweeps idle sessions on a timer, and clears that timer on close', async () => {
    // Mirrors src/http/gateway.ts. Not exported: the point of the assertion is
    // that the gateway arms a sweep at this cadence, so reading the value from
    // the module under test would assert nothing.
    const SWEEP_INTERVAL_MS = 60 * 1000
    const TTL_MS = 30 * 60 * 1000

    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval')
    try {
      const gateway = await start()

      const index = setIntervalSpy.mock.calls.findIndex((call) => call[1] === SWEEP_INTERVAL_MS)
      expect(index, `no setInterval at ${SWEEP_INTERVAL_MS}ms`).toBeGreaterThanOrEqual(0)
      const sweep = setIntervalSpy.mock.calls[index][0] as () => void
      const handle = setIntervalSpy.mock.results[index].value as NodeJS.Timeout
      // unref'd, so an idle gateway's sweep never by itself holds the process open.
      expect(handle.hasRef()).toBe(false)

      expect((await gateway.post(buildBody, { 'x-session-id': 'idle' })).status).toBe(200)
      expect(await sessionCount(gateway.base)).toBe(1)

      // Fire the timer's own callback with the clock past the TTL, then put the
      // clock back before the next request. Sweeping under a still-advanced
      // clock would prove nothing: the per-request sweep on the `/health` call
      // would expire the session too.
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + TTL_MS + 1)
      try {
        sweep()
      } finally {
        nowSpy.mockRestore()
      }
      expect(await sessionCount(gateway.base)).toBe(0)

      await gateway.close()
      open.length = 0
      expect(clearIntervalSpy).toHaveBeenCalledWith(handle)
    } finally {
      setIntervalSpy.mockRestore()
      clearIntervalSpy.mockRestore()
    }
  })

  it('rejects the start when the port is already bound, and arms no stray timer', async () => {
    const taken = await start()
    const port = (taken.server.address() as AddressInfo).port

    process.env.RETIREGOLDEN_HTTP_GATEWAY = '1'
    const { startHttpGateway } = await import('../src/http/gateway.js')
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval')
    try {
      // An unhandled 'error' event here would fail the run outright rather than
      // reject; the contract is that the caller is told the bind failed.
      await expect(startHttpGateway({ port, host: '127.0.0.1' })).rejects.toMatchObject({
        code: 'EADDRINUSE',
      })
      const index = setIntervalSpy.mock.calls.findIndex((call) => call[1] === 60 * 1000)
      expect(index, 'expected the failed start to have armed a sweep timer').toBeGreaterThanOrEqual(
        0,
      )
      const handle = setIntervalSpy.mock.results[index].value as NodeJS.Timeout
      expect(clearIntervalSpy).toHaveBeenCalledWith(handle)
    } finally {
      setIntervalSpy.mockRestore()
      clearIntervalSpy.mockRestore()
    }
  })
})
