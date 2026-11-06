/**
 * The HTTP gateway is a RetireBench research transport, not a product API: it is
 * It accepts a client-supplied session id. These tests pin the
 * two properties that keep it from becoming a liability in a package a desktop
 * app depends on — it binds loopback only, and it does not start by accident.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { HTTP_GATEWAY_OPT_IN_ENV } from '../src/http/gateway.js'

// The exported constant, not a copy of its value: a rename that missed this
// suite would otherwise leave it setting a variable nothing reads, and the
// refusal tests would pass for the wrong reason. (`startHttpGateway` is still
// imported dynamically inside each test; only the name is taken statically.)
const OPT_IN = HTTP_GATEWAY_OPT_IN_ENV

afterEach(() => {
  delete process.env[OPT_IN]
  delete process.env.RETIREGOLDEN_HTTP_HOST
  delete process.env.RETIREGOLDEN_HTTP_GATEWAY_TOKEN
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
    // 'localhost' is refused deliberately: it resolves through the hosts file
    // and DNS, so a machine that maps it elsewhere would bind non-loopback.
    for (const host of ['0.0.0.0', '::', '192.168.1.10', 'localhost']) {
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

  it('rejects malformed configured tokens', async () => {
    process.env[OPT_IN] = '1'
    const { startHttpGateway } = await import('../src/http/gateway.js')
    await expect(startHttpGateway({ port: 0, token: 'too short' })).rejects.toThrow(/opts\.token must be at least 32 printable ASCII/i)
    process.env.RETIREGOLDEN_HTTP_GATEWAY_TOKEN = 'also short'
    await expect(startHttpGateway({ port: 0 })).rejects.toThrow(/RETIREGOLDEN_HTTP_GATEWAY_TOKEN must be at least 32 printable ASCII/i)
  })

  it('mints a distinct programmatic token without printing it', async () => {
    process.env[OPT_IN] = '1'
    delete process.env.RETIREGOLDEN_HTTP_GATEWAY_TOKEN
    const { getHttpGatewayToken, startHttpGateway } = await import('../src/http/gateway.js')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write)
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as typeof process.stderr.write)
    let a: Awaited<ReturnType<typeof startHttpGateway>> | undefined
    let b: Awaited<ReturnType<typeof startHttpGateway>> | undefined
    try {
      a = await startHttpGateway({ port: 0 })
      b = await startHttpGateway({ port: 0 })
      const tokenA = getHttpGatewayToken(a)
      const tokenB = getHttpGatewayToken(b)
      expect(tokenA).toMatch(/^[\x21-\x7e]{32,}$/)
      expect(tokenB).not.toBe(tokenA)
      const output = [consoleError, consoleLog, stdout, stderr]
        .flatMap((spy) => spy.mock.calls.flat())
        .map(String)
        .join('\n')
      expect(output).not.toContain(tokenA)
      expect(output).not.toContain(tokenB)
    } finally {
      if (a) await new Promise<void>((resolve) => a!.close(() => resolve()))
      if (b) await new Promise<void>((resolve) => b!.close(() => resolve()))
      consoleError.mockRestore()
      consoleLog.mockRestore()
      stdout.mockRestore()
      stderr.mockRestore()
    }
  })
})
