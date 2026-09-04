/**
 * WS1 acceptance: the same CLI serves 2025-era (legacy initialize) and
 * 2026-07-28 (modern, via server/discover) clients. Tool definitions do not
 * fork by era. Isolation is a second stdio child because one stdio
 * connection is one process — the primary sequence stays on a single child.
 *
 * The client harness itself lives in tests/helpers/eraHarness.ts, shared with
 * the packed-artifact release gate; this file supplies the checkout's own
 * dist/cli.js as the launch target and keeps the era assertions.
 */

import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  PINNED_MODERN,
  assertCanonicalEqual,
  assertLane,
  createEraHarness,
  stripEraEnvelope,
  type Canonicalize,
  type EnvelopeView,
  type LaneCapture,
} from './helpers/eraHarness.js'
import { PACKAGE_ROOT, ensureBuild } from './helpers/build.js'

const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url))
const captureModuleUrl = new URL('../scripts/capture-protocol-baseline.mjs', import.meta.url).href

describe('dual-era stdio serving', () => {
  let canonicalize!: Canonicalize
  let v1Legacy!: LaneCapture
  let v2Default!: LaneCapture
  let v2Auto!: LaneCapture
  let v2Pinned!: LaneCapture

  beforeAll(async () => {
    await ensureBuild()
    const capture = (await import(captureModuleUrl)) as {
      canonicalize: Canonicalize
      envelopeView: EnvelopeView
    }
    canonicalize = capture.canonicalize
    const harness = createEraHarness({
      target: { cliPath, cwd: PACKAGE_ROOT },
      labelPrefix: 'dual-era',
      canonicalize,
      envelopeView: capture.envelopeView,
    })
    v1Legacy = await harness.runV1Lane()
    v2Default = await harness.runV2Lane({ expectedEra: 'legacy' })
    v2Auto = await harness.runV2Lane({ negotiation: { mode: 'auto' }, expectedEra: 'modern' })
    v2Pinned = await harness.runV2Lane({
      negotiation: { mode: { pin: PINNED_MODERN } },
      expectedEra: 'modern',
    })
  }, 120_000)

  it('a. v1 SDK client speaks the legacy initialize era', () => {
    assertLane('v1 SDK', v1Legacy, 'legacy')
  })

  it('b. v2 client default speaks the legacy era with no probe', () => {
    assertLane('v2 default', v2Default, 'legacy')
  })

  it('c. v2 client auto negotiation reports the modern era after server/discover', () => {
    assertLane('v2 auto', v2Auto, 'modern')
  })

  it('d. v2 client pinned modern connects modern with no silent fallback', () => {
    assertLane('v2 pinned', v2Pinned, 'modern')
  })

  it('modern responses carry only the conservative cache posture', () => {
    // The plan's safe fallback: cacheable modern results are private with no
    // TTL. Asserted here, excluded from cross-era result equality below.
    const inventory = v2Pinned.inventory as { cacheScope?: string; ttlMs?: number }
    expect(inventory.cacheScope, 'modern tools/list cacheScope').toBe('private')
    expect(inventory.ttlMs ?? 0, 'modern tools/list ttlMs').toBe(0)
  })

  it('legacy v1-client payloads deep-equal pinned-modern payloads', () => {
    assertCanonicalEqual(
      canonicalize,
      stripEraEnvelope(v1Legacy.inventory),
      stripEraEnvelope(v2Pinned.inventory),
      'tools/list inventory',
    )
    assertCanonicalEqual(
      canonicalize,
      v1Legacy.resourceBody,
      v2Pinned.resourceBody,
      'plan-schema resource body',
    )

    const primaryLabels = ['build_plan', 'run_projection summary', 'export_plan']
    for (const [index, label] of primaryLabels.entries()) {
      assertCanonicalEqual(
        canonicalize,
        v1Legacy.calls.primary[index]?.payload,
        v2Pinned.calls.primary[index]?.payload,
        `${label} payload`,
      )
      assertCanonicalEqual(
        canonicalize,
        stripEraEnvelope(v1Legacy.calls.primary[index]?.envelope),
        stripEraEnvelope(v2Pinned.calls.primary[index]?.envelope),
        `${label} envelope`,
      )
    }

    assertCanonicalEqual(
      canonicalize,
      v1Legacy.calls.isolatedNoPlan.payload,
      v2Pinned.calls.isolatedNoPlan.payload,
      'isolated run_projection payload',
    )
    assertCanonicalEqual(
      canonicalize,
      stripEraEnvelope(v1Legacy.calls.isolatedNoPlan.envelope),
      stripEraEnvelope(v2Pinned.calls.isolatedNoPlan.envelope),
      'isolated run_projection envelope',
    )
  })
})
