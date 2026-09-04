/**
 * Shared dual-era MCP client harness.
 *
 * Two suites drive the same server through both protocol eras: the checkout
 * lane (`tests/dualEra.test.ts`, launching `dist/cli.js`) and the release gate
 * (`tests/packedArtifact.test.ts`, launching the npm-installed tarball's CLI).
 * They differ only in what they launch, what they label the child clients, and
 * whether they also capture a malformed call — everything else was ~200 lines
 * of byte-for-byte duplicated harness. That copy is here, once, parameterized
 * on exactly those differences.
 *
 * Not a test file (no `*.test.ts` suffix), so vitest's
 * `include: ['tests/**\/*.test.ts']` never collects it as a suite.
 */

import { expect } from 'vitest'
import {
  Client as V2Client,
  type ProtocolEra,
  type VersionNegotiationOptions,
} from '@modelcontextprotocol/client'
import { StdioClientTransport as V2Stdio } from '@modelcontextprotocol/client/stdio'
import { Client as V1Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport as V1Stdio } from '@modelcontextprotocol/sdk/client/stdio.js'
import { TOOL_TABLE } from '../../src/toolTable.js'
import { singleHousehold, singlePolicy } from '../fixtures.js'

/** The modern protocol revision this server pins. */
export const PINNED_MODERN = '2026-07-28' as const

/** Per-response serverInfo key modern envelopes carry and legacy ones cannot. */
export const MODERN_SERVER_INFO_META = 'io.modelcontextprotocol/serverInfo'

/** The public tool inventory, in table order. */
export const TOOL_NAMES = TOOL_TABLE.map((tool) => tool.name)

/** The build_plan arguments every primary lane seeds its session with. */
export const SEED_ARGS = {
  household: singleHousehold,
  policy: singlePolicy,
  startYear: 2026,
}

export type Canonicalize = (value: unknown) => unknown
export type EnvelopeView = (result: unknown) => unknown

export interface StdioTransport {
  pid?: number | null
  onclose?: () => void
  onerror?: (error: Error) => void
}

export interface ToolClient {
  listTools(): Promise<{ tools: Array<{ name: string }> }>
  listResources(): Promise<{ resources: Array<{ name?: string; uri: string }> }>
  readResource(req: { uri: string }): Promise<{
    contents: Array<{ mimeType?: string; text?: string; uri?: string }>
  }>
  callTool(req: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>
  close(): Promise<void>
}

export interface SessionHandle {
  client: ToolClient
  close(): Promise<void>
}

/** What a lane spawns: a CLI entry point and the cwd to spawn it in. */
export interface LaunchTarget {
  cliPath: string
  cwd: string
}

export interface CallCapture {
  payload: unknown
  envelope: unknown
  // Raw pre-normalization cache hints: plan-bearing responses must never be
  // publicly cacheable, so these stay available for assertion before
  // envelopeView drops them.
  rawCacheScope: unknown
  rawTtlMs: unknown
}

export interface LaneCapture {
  era: ProtocolEra
  inventory: unknown
  toolNames: string[]
  resourceMimeType: string
  resourceBody: unknown
  calls: {
    primary: CallCapture[]
    /** Present only when the harness was created with `captureMalformed`. */
    malformed?: CallCapture
    isolatedNoPlan: CallCapture
  }
}

export function waitFor(
  promise: Promise<unknown>,
  milliseconds: number,
  description: string,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), milliseconds)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * First text content block, parsed as JSON.
 *
 * SDK-authored validation errors are plain text rather than a JSON envelope, so
 * unparseable text degrades to a `{ kind: 'text', text }` record instead of
 * throwing — that shape is what the malformed-input assertions read.
 */
export function parsePayload(result: unknown): unknown {
  const content = (result as { content?: Array<{ type: string; text: string }> }).content
  const text = content?.find((entry) => entry.type === 'text')?.text
  expect(text, 'tool returned no text content').toBeTruthy()
  try {
    return JSON.parse(text as string)
  } catch {
    return { kind: 'text', text }
  }
}

/**
 * Connect a client over a stdio transport and hand back a close() that also
 * waits for the child process to exit (killing it if the wait times out).
 */
export async function openStdio(
  client: ToolClient,
  transport: StdioTransport,
  childDescription = 'the stdio child process to exit',
): Promise<SessionHandle> {
  let shuttingDown = false
  let resolveClose!: () => void
  let rejectClose!: (error: Error) => void
  const childClosed = new Promise<void>((resolveClosePromise, rejectClosePromise) => {
    resolveClose = resolveClosePromise
    rejectClose = rejectClosePromise
  })
  const priorClose = transport.onclose
  const priorError = transport.onerror
  transport.onclose = () => {
    priorClose?.()
    resolveClose()
  }
  transport.onerror = (error) => {
    priorError?.(error)
    if (shuttingDown) resolveClose()
    else rejectClose(error)
  }
  try {
    await (client as unknown as { connect(transport: unknown): Promise<void> }).connect(transport)
  } catch (connectError) {
    // A rejected initialize/discover means no SessionHandle is returned, so
    // the caller's finally can never close the child — do it here.
    shuttingDown = true
    try {
      await (transport as unknown as { close?: () => Promise<void> }).close?.()
    } catch {
      // the connect failure is the signal
    }
    throw connectError
  }
  return {
    client,
    async close() {
      shuttingDown = true
      let closeError: unknown
      try {
        await client.close()
      } catch (error) {
        closeError = error
      }
      try {
        await waitFor(childClosed, 5_000, childDescription)
      } catch (error) {
        const pid = transport.pid
        if (typeof pid === 'number') {
          try {
            process.kill(pid)
          } catch {
            // The child already exited or could not be signalled; the close
            // timeout remains the operator-facing signal.
          }
        }
        if (!closeError) closeError = error
      }
      if (closeError) throw closeError
    },
  }
}

export async function captureCall(
  client: ToolClient,
  tool: string,
  args: Record<string, unknown>,
  canonicalize: Canonicalize,
  envelopeView: EnvelopeView,
): Promise<CallCapture> {
  const raw = await client.callTool({ name: tool, arguments: args })
  const rawRecord = raw as { cacheScope?: unknown; ttlMs?: unknown }
  return {
    payload: canonicalize(parsePayload(raw)),
    envelope: envelopeView(raw),
    rawCacheScope: rawRecord.cacheScope,
    rawTtlMs: rawRecord.ttlMs,
  }
}

/** tools/list plus the advertised plan-schema resource, read through its own URI. */
export async function exercisePrimary(
  client: ToolClient,
  canonicalize: Canonicalize,
): Promise<Omit<LaneCapture, 'era' | 'calls'>> {
  const listed = await client.listTools()
  const inventory = canonicalize(listed)
  const toolNames = listed.tools.map((tool) => tool.name)

  const resources = await client.listResources()
  const resource = resources.resources.find((candidate) => candidate.name === 'plan-schema')
  expect(resource?.uri, 'resources/list did not advertise plan-schema').toBeTruthy()
  const read = await client.readResource({ uri: resource!.uri })
  expect(read.contents.length).toBeGreaterThan(0)
  const content = read.contents[0]!

  return {
    inventory,
    toolNames,
    resourceMimeType: content.mimeType ?? '',
    resourceBody: JSON.parse(content.text as string),
  }
}

export async function exercisePrimaryCalls(
  client: ToolClient,
  canonicalize: Canonicalize,
  envelopeView: EnvelopeView,
): Promise<CallCapture[]> {
  // Strictly sequential: the point of this sequence is that build_plan state
  // reaches the later calls on ONE connection, so ordering must be enforced by
  // awaiting, not left to in-flight request interleaving.
  const build = await captureCall(client, 'build_plan', SEED_ARGS, canonicalize, envelopeView)
  const projection = await captureCall(
    client,
    'run_projection',
    { detail: 'summary' },
    canonicalize,
    envelopeView,
  )
  const exported = await captureCall(client, 'export_plan', {}, canonicalize, envelopeView)
  return [build, projection, exported]
}

export async function exerciseIsolation(
  client: ToolClient,
  canonicalize: Canonicalize,
  envelopeView: EnvelopeView,
): Promise<CallCapture> {
  return captureCall(client, 'run_projection', { detail: 'summary' }, canonicalize, envelopeView)
}

export interface EraHarnessOptions {
  /** What each lane spawns. */
  target: LaunchTarget
  /** Client-name prefix, e.g. `dual-era` → `dual-era-v1-isolation`. */
  labelPrefix: string
  /** Also send a schema-violating build_plan on the primary connection. */
  captureMalformed?: boolean
  /** Wording for the child-exit timeout message. */
  childDescription?: string
  canonicalize: Canonicalize
  envelopeView: EnvelopeView
}

export interface EraHarness {
  runV1Lane(): Promise<LaneCapture>
  runV2Lane(options: {
    negotiation?: VersionNegotiationOptions
    expectedEra: ProtocolEra
  }): Promise<LaneCapture>
}

/**
 * Build the v1/v2 lane runners for one launch target.
 *
 * Both lanes run the same sequence: an optional malformed call, the primary
 * inventory/resource capture and the stateful call sequence on one connection,
 * then a SECOND stdio child that must not see the first child's plan — one
 * stdio connection is one process, so isolation needs its own child.
 */
export function createEraHarness(options: EraHarnessOptions): EraHarness {
  const { target, labelPrefix, captureMalformed, canonicalize, envelopeView } = options
  const childDescription = options.childDescription ?? 'the stdio child process to exit'

  const drivePrimary = async (session: SessionHandle) => {
    let captured: Omit<LaneCapture, 'era' | 'calls'>
    let primaryCalls: CallCapture[]
    let malformed: CallCapture | undefined
    try {
      // Malformed input first (stateless): every lane, including modern
      // dispatch, must surface schema rejection as a structured isError result.
      if (captureMalformed) {
        malformed = await captureCall(
          session.client,
          'build_plan',
          { household: 42 },
          canonicalize,
          envelopeView,
        )
      }
      captured = await exercisePrimary(session.client, canonicalize)
      primaryCalls = await exercisePrimaryCalls(session.client, canonicalize, envelopeView)
    } finally {
      await session.close()
    }
    return { captured, primaryCalls, malformed }
  }

  const driveIsolation = async (session: SessionHandle) => {
    try {
      return await exerciseIsolation(session.client, canonicalize, envelopeView)
    } finally {
      await session.close()
    }
  }

  return {
    async runV1Lane(): Promise<LaneCapture> {
      const connect = async (label: string) => {
        const transport = new V1Stdio({
          command: process.execPath,
          args: [target.cliPath],
          cwd: target.cwd,
        })
        return openStdio(
          new V1Client({ name: label, version: '0.0.0' }) as ToolClient,
          transport,
          childDescription,
        )
      }

      const { captured, primaryCalls, malformed } = await drivePrimary(
        await connect(`${labelPrefix}-v1`),
      )
      const isolatedNoPlan = await driveIsolation(await connect(`${labelPrefix}-v1-isolation`))
      return {
        era: 'legacy',
        ...captured,
        calls: { primary: primaryCalls, ...(malformed ? { malformed } : {}), isolatedNoPlan },
      }
    },

    async runV2Lane(laneOptions): Promise<LaneCapture> {
      const connect = async (label: string) => {
        const transport = new V2Stdio({
          command: process.execPath,
          args: [target.cliPath],
          cwd: target.cwd,
        })
        const client = new V2Client(
          { name: label, version: '0.0.0' },
          laneOptions.negotiation ? { versionNegotiation: laneOptions.negotiation } : undefined,
        )
        const session = await openStdio(client as ToolClient, transport, childDescription)
        try {
          expect(client.getProtocolEra(), `${label} protocol era`).toBe(laneOptions.expectedEra)
          if (laneOptions.expectedEra === 'modern') {
            expect(client.getNegotiatedProtocolVersion(), `${label} modern revision`).toBe(
              PINNED_MODERN,
            )
          }
          if (laneOptions.negotiation?.mode === 'auto') {
            expect(client.getDiscoverResult(), `${label} server/discover result`).toBeDefined()
          }
          if (laneOptions.negotiation == null) {
            expect(client.getDiscoverResult(), `${label} must not probe`).toBeUndefined()
          }
          return session
        } catch (error) {
          await session.close()
          throw error
        }
      }

      const { captured, primaryCalls, malformed } = await drivePrimary(
        await connect(`${labelPrefix}-v2`),
      )
      const isolatedNoPlan = await driveIsolation(await connect(`${labelPrefix}-v2-isolation`))
      return {
        era: laneOptions.expectedEra,
        ...captured,
        calls: { primary: primaryCalls, ...(malformed ? { malformed } : {}), isolatedNoPlan },
      }
    },
  }
}

/**
 * The era-invariant contract every lane must satisfy: the 14-tool inventory,
 * the JSON plan-schema resource, a successful stateful call sequence, and a
 * second connection that cannot see the first connection's plan.
 *
 * With `expectMalformed`, also asserts the schema-rejection surface.
 */
export function assertLane(
  label: string,
  lane: LaneCapture,
  era: ProtocolEra,
  expectations: { expectMalformed?: boolean } = {},
): void {
  expect(lane.era, `${label} era`).toBe(era)
  expect(lane.toolNames, `${label} tools/list inventory`).toEqual(TOOL_NAMES)
  expect(TOOL_NAMES, 'TOOL_TABLE drifted from the 14-tool public contract').toHaveLength(14)
  expect(lane.resourceMimeType, `${label} plan-schema mimeType`).toBe('application/json')
  expect((lane.calls.primary[0]?.payload as { ok?: boolean }).ok, `${label} build_plan`).toBe(true)
  expect((lane.calls.primary[1]?.payload as { ok?: boolean }).ok, `${label} run_projection`).toBe(true)
  expect((lane.calls.primary[2]?.payload as { ok?: boolean }).ok, `${label} export_plan`).toBe(true)
  expect(lane.calls.isolatedNoPlan.payload, `${label} second-connection isolation`).toMatchObject({
    ok: false,
    error: 'NO_PLAN',
  })
  if (!expectations.expectMalformed) return
  const malformed = lane.calls.malformed
  expect(malformed, `${label} malformed input capture`).toBeDefined()
  const malformedEnvelope = malformed!.envelope as { isError?: boolean; content?: unknown[] }
  expect(malformedEnvelope.isError, `${label} malformed input isError`).toBe(true)
  expect(malformedEnvelope.content?.length ?? 0, `${label} malformed input envelope`).toBeGreaterThan(0)
  const malformedPayload = malformed!.payload as { kind?: string; text?: string }
  expect(malformedPayload.text ?? '', `${label} malformed input message`).toContain(
    'Input validation error',
  )
}

export function canonicalJson(canonicalize: Canonicalize, value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

export function assertCanonicalEqual(
  canonicalize: Canonicalize,
  left: unknown,
  right: unknown,
  label: string,
): void {
  expect(canonicalJson(canonicalize, left), label).toBe(canonicalJson(canonicalize, right))
}

/**
 * Modern responses carry era-specific envelope metadata a legacy response
 * structurally cannot have: per-response serverInfo under _meta and cache
 * hint fields (cacheScope/ttlMs). That metadata is transport envelope, not
 * result content, so it is asserted separately (modern-only) and stripped
 * before cross-era equality.
 */
export function stripEraEnvelope(value: unknown): unknown {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return value
  const clone = JSON.parse(JSON.stringify(value)) as Record<string, unknown>
  delete clone.cacheScope
  delete clone.ttlMs
  for (const metaKey of ['_meta', 'meta']) {
    const meta = clone[metaKey]
    if (meta != null && typeof meta === 'object' && !Array.isArray(meta)) {
      delete (meta as Record<string, unknown>)[MODERN_SERVER_INFO_META]
      if (Object.keys(meta as Record<string, unknown>).length === 0) delete clone[metaKey]
    }
  }
  return clone
}
