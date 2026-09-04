/**
 * A built MFJ session, the starting point several adapter-level suites share.
 *
 * Not a test file (no `*.test.ts` suffix), so vitest does not collect it.
 */

import { expect } from 'vitest'
import { createSession } from '../../src/session.js'
import * as adapter from '../../src/adapter.js'
import { mfjHousehold, mfjPolicy } from '../fixtures.js'

/** Fresh 2026 session with the MFJ fixture plan already built into it. */
export function mfjSession() {
  const s = createSession(2026)
  const built = adapter.setPlanFromBuild(s, { household: mfjHousehold, policy: mfjPolicy })
  expect(built.ok).toBe(true)
  return s
}
