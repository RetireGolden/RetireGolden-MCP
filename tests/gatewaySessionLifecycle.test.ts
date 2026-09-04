/**
 * The gateway's session store belongs to one gateway instance, not to the
 * module. Two properties follow, and both are security properties rather than
 * tidiness: in-memory plan state must not leak from one listener to another
 * inside a process, and it must not outlive the listener that accepted it.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { singleHousehold, singlePolicy } from './fixtures.js'
import { startTestGateway, type TestGateway } from './helpers/gateway.js'

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
    const first = await start()
    const built = await first.post(buildBody, { 'x-session-id': 'released' })
    expect(built.status).toBe(200)
    expect(
      ((await (await fetch(`${first.base}/health`)).json()) as { sessions: number }).sessions,
    ).toBe(1)
    await first.close()
    open.length = 0

    const second = await start()
    const health = (await (await fetch(`${second.base}/health`)).json()) as { sessions: number }
    expect(health.sessions).toBe(0)

    const after = await second.post(
      { tool: 'explain_modeled_result' },
      { 'x-session-id': 'released' },
    )
    expect(((await after.json()) as { hasPlan: boolean }).hasPlan).toBe(false)
  })
})
