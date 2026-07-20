/**
 * Version reporting: get_session and explain_modeled_result surface the running
 * @retiregolden/mcp version (this package.json) and the installed
 * @retiregolden/engine version (its package.json), resolved at runtime.
 */

import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { createSession } from '../src/session.js'
import * as adapter from '../src/adapter.js'
import { getTool } from '../src/toolTable.js'

const require = createRequire(import.meta.url)
const mcpPkg = require('../package.json') as { name: string; version: string }
const enginePkg = require('@retiregolden/engine/package.json') as { name: string; version: string }

describe('version reporting', () => {
  it('getVersions resolves the real package versions', () => {
    const v = adapter.getVersions()
    expect(v.mcpVersion).toBe(mcpPkg.version)
    expect(v.engineVersion).toBe(enginePkg.version)
  })

  it('get_session reports mcpVersion and engineVersion', () => {
    const session = createSession()
    const tool = getTool('get_session')!
    const out = tool.handler(session, {}) as {
      mcpVersion: string | null
      engineVersion: string | null
    }
    expect(out.mcpVersion).toBe(mcpPkg.version)
    expect(out.engineVersion).toBe(enginePkg.version)
  })

  it('explain_modeled_result reports mcpVersion and engineVersion', () => {
    const session = createSession()
    const res = adapter.explainModeledResult(session)
    expect(res.mcpVersion).toBe(mcpPkg.version)
    expect(res.engineVersion).toBe(enginePkg.version)
  })
})
