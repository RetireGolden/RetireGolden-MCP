/**
 * The HTTP gateway is a RetireBench research transport, not a product API: it is
 * unauthenticated and accepts a client-supplied session id. These tests pin the
 * two properties that keep it from becoming a liability in a package a desktop
 * app depends on — it binds loopback only, and it does not start by accident.
 */

import { afterEach, describe, expect, it } from 'vitest'

const OPT_IN = 'RETIREGOLDEN_HTTP_GATEWAY'

afterEach(() => {
  delete process.env[OPT_IN]
  delete process.env.RETIREGOLDEN_HTTP_HOST
})

describe('HTTP gateway fencing', () => {
  it('is not reachable from the package index', async () => {
    const index = await import('../src/index.js')
    expect(Object.keys(index)).not.toContain('startHttpGateway')
  })

  it('refuses to start without an explicit opt-in', async () => {
    const { startHttpGateway } = await import('../src/http/gateway.js')
    await expect(startHttpGateway({ port: 0, host: '127.0.0.1' })).rejects.toThrow(
      /off by default/i,
    )
  })

  it('refuses a non-loopback host even when opted in', async () => {
    process.env[OPT_IN] = '1'
    const { startHttpGateway } = await import('../src/http/gateway.js')
    for (const host of ['0.0.0.0', '::', '192.168.1.10']) {
      await expect(startHttpGateway({ port: 0, host })).rejects.toThrow(/loopback only/i)
    }
  })

  it('cannot be pushed off loopback by an environment variable', async () => {
    // The historical hazard: RETIREGOLDEN_HTTP_HOST fed straight into listen().
    // The clamp is on the resolved host, so the variable has no effect at all.
    process.env[OPT_IN] = '1'
    process.env.RETIREGOLDEN_HTTP_HOST = '0.0.0.0'
    const { startHttpGateway } = await import('../src/http/gateway.js')
    const server = await startHttpGateway({ port: 0 })
    try {
      const address = server.address()
      expect(typeof address === 'object' && address?.address).toBe('127.0.0.1')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('starts on loopback when opted in', async () => {
    process.env[OPT_IN] = '1'
    const { startHttpGateway } = await import('../src/http/gateway.js')
    const server = await startHttpGateway({ port: 0, host: '127.0.0.1' })
    try {
      expect(server.listening).toBe(true)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
