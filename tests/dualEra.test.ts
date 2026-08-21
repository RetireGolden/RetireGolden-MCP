/**
 * WS1 acceptance: the same CLI serves 2025-era (legacy initialize) and
 * 2026-07-28 (modern, via server/discover) clients. Tool definitions do not
 * fork by era. Isolation is a second stdio child because one stdio
 * connection is one process — the primary sequence stays on a single child.
 */

import { execFile as execFileCallback } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  Client as V2Client,
  type ProtocolEra,
  type VersionNegotiationOptions,
} from '@modelcontextprotocol/client'
import { StdioClientTransport as V2Stdio } from '@modelcontextprotocol/client/stdio'
import { Client as V1Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport as V1Stdio } from '@modelcontextprotocol/sdk/client/stdio.js'
import { TOOL_TABLE } from '../src/toolTable.js'
import { singleHousehold, singlePolicy } from './fixtures.js'

const execFile = promisify(execFileCallback)
const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url))
const captureModuleUrl = new URL('../scripts/capture-protocol-baseline.mjs', import.meta.url).href

const TOOL_NAMES = TOOL_TABLE.map((t) => t.name)
const seed = { household: singleHousehold, policy: singlePolicy, startYear: 2026 }
const PINNED_MODERN = '2026-07-28' as const

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = `${directory}/${entry.name}`
      if (entry.isDirectory()) return sourceFiles(fullPath)
      return entry.isFile() ? [fullPath] : []
    }),
  )
  return nested.flat()
}

async function buildIsCurrent(): Promise<boolean> {
  const sources = (await sourceFiles(`${packageRoot}/src`)).filter((file) => file.endsWith('.ts'))
  const expectedOutputs = sources.map((file) =>
    file.replace(`${packageRoot}/src`, `${packageRoot}/dist`).replace(/\.ts$/, '.js'),
  )
  let sourceStats
  let outputStats
  try {
    ;[sourceStats, outputStats] = await Promise.all([
      Promise.all(sources.map((source) => stat(source))),
      Promise.all(expectedOutputs.map((file) => stat(file))),
    ])
  } catch {
    return false
  }
  const newestSource = Math.max(...sourceStats.map((s) => s.mtimeMs))
  const oldestOutput = Math.min(...outputStats.map((s) => s.mtimeMs))
  return newestSource < oldestOutput
}

async function ensureBuild(): Promise<void> {
  if (await buildIsCurrent()) return
  await execFile('pnpm', ['run', 'build'], {
    cwd: packageRoot,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
    shell: process.platform === 'win32',
  })
}

function waitFor(promise: Promise<unknown>, milliseconds: number, description: string): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), milliseconds)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

type StdioTransport = {
  pid?: number | null
  onclose?: () => void
  onerror?: (error: Error) => void
}

function parsePayload(result: unknown): unknown {
  const content = (result as { content?: { type: string; text: string }[] }).content
  const text = content?.find((c) => c.type === 'text')?.text
  expect(text, 'tool returned no text content').toBeTruthy()
  return JSON.parse(text as string)
}

interface CallCapture {
  payload: unknown
  envelope: unknown
}

interface LaneCapture {
  era: ProtocolEra
  inventory: unknown
  toolNames: string[]
  resourceMimeType: string
  resourceBody: unknown
  calls: {
    primary: CallCapture[]
    isolatedNoPlan: CallCapture
  }
}

interface ToolClient {
  listTools(): Promise<{ tools: Array<{ name: string }> }>
  listResources(): Promise<{ resources: Array<{ name?: string; uri: string }> }>
  readResource(req: { uri: string }): Promise<{
    contents: Array<{ mimeType?: string; text?: string; uri?: string }>
  }>
  callTool(req: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>
  close(): Promise<void>
}

interface SessionHandle {
  client: ToolClient
  close(): Promise<void>
}

async function openStdio(client: ToolClient, transport: StdioTransport): Promise<SessionHandle> {
  let shuttingDown = false
  let resolveClose!: () => void
  let rejectClose!: (error: Error) => void
  const childClosed = new Promise<void>((resolve, reject) => {
    resolveClose = resolve
    rejectClose = reject
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
  await (client as unknown as { connect(t: unknown): Promise<void> }).connect(transport)
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
        await waitFor(childClosed, 5_000, 'the stdio child process to exit')
      } catch (error) {
        const pid = transport.pid
        if (typeof pid === 'number') {
          try {
            process.kill(pid)
          } catch {
            // best-effort; timeout is still the operator-facing signal
          }
        }
        if (!closeError) closeError = error
      }
      if (closeError) throw closeError
    },
  }
}

async function captureCall(
  client: ToolClient,
  tool: string,
  args: Record<string, unknown>,
  canonicalize: (value: unknown) => unknown,
  envelopeView: (result: unknown) => unknown,
): Promise<CallCapture> {
  const raw = await client.callTool({ name: tool, arguments: args })
  return {
    payload: canonicalize(parsePayload(raw)),
    envelope: envelopeView(raw),
  }
}

async function exercisePrimary(
  client: ToolClient,
  canonicalize: (value: unknown) => unknown,
): Promise<Omit<LaneCapture, 'era' | 'calls'>> {
  const listed = await client.listTools()
  const inventory = canonicalize(listed)
  const toolNames = listed.tools.map((t) => t.name)

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

async function exercisePrimaryCalls(
  client: ToolClient,
  canonicalize: (value: unknown) => unknown,
  envelopeView: (result: unknown) => unknown,
): Promise<CallCapture[]> {
  // Strictly sequential: the point of this sequence is that build_plan state
  // reaches the later calls, so ordering must be enforced by awaiting, not
  // left to in-flight request interleaving.
  const build = await captureCall(client, 'build_plan', seed, canonicalize, envelopeView)
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

async function exerciseIsolation(
  client: ToolClient,
  canonicalize: (value: unknown) => unknown,
  envelopeView: (result: unknown) => unknown,
): Promise<CallCapture> {
  return captureCall(client, 'run_projection', { detail: 'summary' }, canonicalize, envelopeView)
}

async function runV1Lane(
  canonicalize: (value: unknown) => unknown,
  envelopeView: (result: unknown) => unknown,
): Promise<LaneCapture> {
  const primaryTransport = new V1Stdio({
    command: process.execPath,
    args: [cliPath],
    cwd: packageRoot,
  })
  const primary = await openStdio(
    new V1Client({ name: 'dual-era-v1', version: '0.0.0' }) as ToolClient,
    primaryTransport,
  )
  let captured: Omit<LaneCapture, 'era' | 'calls'>
  let primaryCalls: CallCapture[]
  try {
    captured = await exercisePrimary(primary.client, canonicalize)
    primaryCalls = await exercisePrimaryCalls(primary.client, canonicalize, envelopeView)
  } finally {
    await primary.close()
  }

  const isolationTransport = new V1Stdio({
    command: process.execPath,
    args: [cliPath],
    cwd: packageRoot,
  })
  const isolation = await openStdio(
    new V1Client({ name: 'dual-era-v1-isolation', version: '0.0.0' }) as ToolClient,
    isolationTransport,
  )
  let isolatedNoPlan: CallCapture
  try {
    isolatedNoPlan = await exerciseIsolation(isolation.client, canonicalize, envelopeView)
  } finally {
    await isolation.close()
  }

  return { era: 'legacy', ...captured, calls: { primary: primaryCalls, isolatedNoPlan } }
}

async function runV2Lane(
  options: {
    negotiation?: VersionNegotiationOptions
    expectedEra: ProtocolEra
  },
  canonicalize: (value: unknown) => unknown,
  envelopeView: (result: unknown) => unknown,
): Promise<LaneCapture> {
  const connect = async (label: string) => {
    const transport = new V2Stdio({
      command: process.execPath,
      args: [cliPath],
      cwd: packageRoot,
    })
    const client = new V2Client(
      { name: label, version: '0.0.0' },
      options?.negotiation ? { versionNegotiation: options.negotiation } : undefined,
    )
    const session = await openStdio(client as ToolClient, transport)
    try {
      const era = client.getProtocolEra()
      expect(era, `${label} protocol era`).toBe(options.expectedEra)
      if (options.expectedEra === 'modern') {
        expect(client.getNegotiatedProtocolVersion(), `${label} modern revision`).toBe(PINNED_MODERN)
      }
      if (options.negotiation?.mode === 'auto') {
        expect(client.getDiscoverResult(), `${label} server/discover result`).toBeDefined()
      }
      if (options.negotiation == null) {
        expect(client.getDiscoverResult(), `${label} must not probe`).toBeUndefined()
      }
      return session
    } catch (error) {
      await session.close()
      throw error
    }
  }

  const primary = await connect('dual-era-v2')
  let captured: Omit<LaneCapture, 'era' | 'calls'>
  let primaryCalls: CallCapture[]
  try {
    captured = await exercisePrimary(primary.client, canonicalize)
    primaryCalls = await exercisePrimaryCalls(primary.client, canonicalize, envelopeView)
  } finally {
    await primary.close()
  }

  const isolation = await connect('dual-era-v2-isolation')
  let isolatedNoPlan: CallCapture
  try {
    isolatedNoPlan = await exerciseIsolation(isolation.client, canonicalize, envelopeView)
  } finally {
    await isolation.close()
  }

  return { era: options.expectedEra, ...captured, calls: { primary: primaryCalls, isolatedNoPlan } }
}

function assertLane(label: string, lane: LaneCapture, era: ProtocolEra): void {
  expect(lane.era, `${label} era`).toBe(era)
  expect(lane.toolNames, `${label} tools/list`).toEqual(TOOL_NAMES)
  expect(TOOL_NAMES, 'TOOL_TABLE drifted from the 14-tool contract').toHaveLength(14)
  expect(lane.resourceMimeType, `${label} plan-schema mimeType`).toBe('application/json')
  expect((lane.calls.primary[0]?.payload as { ok?: boolean }).ok, `${label} build_plan`).toBe(true)
  expect((lane.calls.primary[1]?.payload as { ok?: boolean }).ok, `${label} run_projection`).toBe(true)
  expect((lane.calls.primary[2]?.payload as { ok?: boolean }).ok, `${label} export_plan`).toBe(true)
  expect(lane.calls.isolatedNoPlan.payload, `${label} two-connection isolation`).toMatchObject({
    ok: false,
    error: 'NO_PLAN',
  })
}

function canonicalJson(canonicalize: (value: unknown) => unknown, value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function assertCanonicalEqual(
  canonicalize: (value: unknown) => unknown,
  left: unknown,
  right: unknown,
  label: string,
): void {
  expect(canonicalJson(canonicalize, left), label).toBe(canonicalJson(canonicalize, right))
}

const MODERN_SERVER_INFO_META = 'io.modelcontextprotocol/serverInfo'

/**
 * Modern responses carry era-specific envelope metadata a legacy response
 * structurally cannot have: per-response serverInfo under _meta and cache
 * hint fields (cacheScope/ttlMs). That metadata is transport envelope, not
 * result content, so it is asserted separately (modern-only) and stripped
 * before cross-era equality.
 */
function stripEraEnvelope(value: unknown): unknown {
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

describe('dual-era stdio serving', () => {
  let canonicalize!: (value: unknown) => unknown
  let envelopeView!: (result: unknown) => unknown
  let v1Legacy!: LaneCapture
  let v2Default!: LaneCapture
  let v2Auto!: LaneCapture
  let v2Pinned!: LaneCapture

  beforeAll(async () => {
    await ensureBuild()
    const capture = (await import(captureModuleUrl)) as {
      canonicalize: (value: unknown) => unknown
      envelopeView: (result: unknown) => unknown
    }
    canonicalize = capture.canonicalize
    envelopeView = capture.envelopeView
    v1Legacy = await runV1Lane(canonicalize, envelopeView)
    v2Default = await runV2Lane({ expectedEra: 'legacy' }, canonicalize, envelopeView)
    v2Auto = await runV2Lane(
      {
        negotiation: { mode: 'auto' },
        expectedEra: 'modern',
      },
      canonicalize,
      envelopeView,
    )
    v2Pinned = await runV2Lane(
      {
        negotiation: { mode: { pin: PINNED_MODERN } },
        expectedEra: 'modern',
      },
      canonicalize,
      envelopeView,
    )
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
