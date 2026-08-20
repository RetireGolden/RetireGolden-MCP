/**
 * Protocol baseline capture for the pre-v2 stdio server.
 *
 * This deliberately exercises the public MCP wire surface, not adapter helpers:
 * the baseline is the referee for the SDK migration. Keep the fixture matrix
 * deterministic and regenerate it only for an intentional engine-contract change.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

export const MCP_VERSION_SENTINEL = '<mcp-version>'
export const TIMING_SENTINEL = '<timing>'
export const TIMESTAMP_SENTINEL = '<timestamp>'
export const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
export const BASELINE_PATH = resolve(PACKAGE_ROOT, 'tests/protocol-baseline/baseline.json')

let machineHomedir
try {
  machineHomedir = os.homedir()
} catch {
  // skip when homedir is unavailable
}

let machineUsername
try {
  machineUsername = os.userInfo().username
} catch {
  // skip when userInfo is unavailable
}

const require = createRequire(import.meta.url)
const FIXED_REFUSAL = {
  ok: false,
  error: 'AUTHORIZATION_REFUSED',
  code: 'BASELINE_FIXTURE',
  remedy: 'fixed refusal fixture',
}

const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

/** Recursively sort object keys while preserving array order and masking package version noise. */
export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value != null && typeof value === 'object') {
    const result = {}
    for (const key of Object.keys(value).sort()) {
      const raw = value[key]
      // mcpVersion legitimately moves on release; solveMs is wall-clock solver
      // timing; updatedAtIso/createdAtIso are engine-stamped wall-clock
      // timestamps. None are part of the calculation contract this baseline
      // referees. Sentinels apply only when the value has the expected shape so
      // a type regression surfaces as drift instead of being masked.
      result[key] =
        key === 'mcpVersion' && typeof raw === 'string'
          ? MCP_VERSION_SENTINEL
          : key === 'solveMs' && Number.isFinite(raw)
            ? TIMING_SENTINEL
            : (key === 'updatedAtIso' || key === 'createdAtIso') &&
                typeof raw === 'string' &&
                ISO_TIMESTAMP_PATTERN.test(raw)
              ? TIMESTAMP_SENTINEL
              : canonicalize(raw)
    }
    return result
  }
  return value
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value))
}

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function canonicalSha256(value) {
  return sha256(canonicalJson(value))
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Remove local paths before an error message enters the baseline fingerprint. */
export function stripMachineLocalPaths(message) {
  let normalized = String(message)
  for (const root of [PACKAGE_ROOT, machineHomedir].filter(Boolean)) {
    for (const variant of [root, root.replace(/\\/g, '/'), root.replace(/\//g, '\\')]) {
      if (!variant) continue
      normalized = normalized.replace(new RegExp(escapeRegex(variant), 'g'), '<path>')
    }
  }
  if (machineUsername) {
    normalized = normalized.replace(new RegExp(`\\b${escapeRegex(machineUsername)}\\b`, 'g'), '<user>')
  }
  return normalized
    .replace(/[A-Za-z]:[\\/](?:[^\s()[\]{}<>]+[\\/])*[^\s()[\]{}<>]+/g, '<path>')
    .replace(/\/(?:[^\s()[\]{}<>]+\/)*[^\s()[\]{}<>]+/g, '<path>')
}

function isRecord(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function resultPayload(result) {
  const content = result?.content
  const text = Array.isArray(content) ? content.find((item) => item?.type === 'text')?.text : undefined
  if (typeof text !== 'string') throw new Error('MCP tool result contained no text payload')
  try {
    return JSON.parse(text)
  } catch {
    // This can occur when SDK validation returns an isError tool result instead
    // of a JSON-RPC protocol error. Preserve the surface without local paths.
    return { kind: 'text', text: stripMachineLocalPaths(text) }
  }
}

function protocolSurface(error) {
  const code = isRecord(error) && 'code' in error ? error.code : 'UNKNOWN'
  const message = error instanceof Error ? error.message : String(error)
  return {
    kind: 'protocol-error',
    code,
    messageDigest: sha256(stripMachineLocalPaths(message)),
  }
}

function envelopeView(result) {
  const view = {
    isError: result.isError === true,
    content: (Array.isArray(result.content) ? result.content : []).map((block) => {
      if (block?.type === 'text' && typeof block.text === 'string') {
        const { text, ...rest } = block
        try {
          return { ...canonicalize(rest), json: canonicalize(JSON.parse(text)) }
        } catch {
          return { ...canonicalize(rest), text: stripMachineLocalPaths(text) }
        }
      }
      return canonicalize(block)
    }),
  }
  if ('structuredContent' in result) view.structuredContent = canonicalize(result.structuredContent)
  if ('_meta' in result) view.meta = canonicalize(result._meta)
  return view
}

async function captureToolCall({ client, lane, step, tool, args, includePayload = true }) {
  const base = { step, tool, lane, argsDigest: canonicalSha256(args) }
  try {
    const result = await client.callTool({ name: tool, arguments: args })
    const payload = resultPayload(result)
    const canonicalPayload = canonicalize(payload)
    const entry = {
      ...base,
      kind: 'result',
      isError: result.isError === true,
      payloadHash: canonicalSha256(payload),
      envelopeHash: canonicalSha256(envelopeView(result)),
      ...(includePayload ? { payload: canonicalPayload } : {}),
    }
    return { entry, payload }
  } catch (error) {
    const surface = protocolSurface(error)
    return {
      entry: {
        ...base,
        ...surface,
        payloadHash: canonicalSha256(surface),
        surface: canonicalize(surface),
      },
      payload: undefined,
    }
  }
}

function requireSuccessfulResult(record, label) {
  if (record.entry.kind !== 'result' || record.entry.isError || !isRecord(record.payload)) {
    throw new Error(`${label} did not return a successful MCP result`)
  }
  return record.payload
}

function requireOkResult(record, label) {
  const payload = requireSuccessfulResult(record, label)
  if (payload.ok !== true) throw new Error(`${label} returned an unsuccessful tool payload`)
  return payload
}

function requireExport(record) {
  const exported = requireOkResult(record, 'export_plan')
  if (!('plan' in exported)) {
    throw new Error('export_plan did not return an exportable plan document')
  }
  return exported
}

async function captureInventoryAndResource(client) {
  const listed = await client.listTools()
  const inventory = { canonical: canonicalize(listed), sha256: canonicalSha256(listed) }

  const resources = await client.listResources()
  const resource = resources.resources.find((candidate) => candidate.name === 'plan-schema')
  if (!resource?.uri) throw new Error('resources/list did not advertise the plan-schema resource')
  const read = await client.readResource({ uri: resource.uri })
  const content = read.contents.find((candidate) => candidate.uri === resource.uri) ?? read.contents[0]
  if (!content || typeof content.text !== 'string') {
    throw new Error('resources/read did not return JSON text for the plan-schema resource')
  }
  if (content.uri !== resource.uri) {
    throw new Error(
      `resources/read content.uri (${String(content.uri)}) did not match the advertised resource URI (${resource.uri})`,
    )
  }
  if (content.mimeType !== 'application/json') {
    throw new Error(`plan-schema resource mimeType drifted to ${String(content.mimeType)}`)
  }

  return {
    inventory,
    resource: {
      uri: resource.uri,
      contentUri: content.uri ?? null,
      mimeType: content.mimeType,
      sha256: canonicalSha256(JSON.parse(content.text)),
      listSha256: canonicalSha256(resources),
      readSha256: canonicalSha256(read),
    },
  }
}

async function replayStdioMatrix(client, fixtures) {
  const { singleHousehold, singlePolicy } = fixtures
  const matrix = []
  const call = async (step, tool, args, includePayload = true) => {
    const record = await captureToolCall({ client, lane: 'stdio', step, tool, args, includePayload })
    matrix.push(record.entry)
    return record
  }

  await call('run_projection_no_plan', 'run_projection', {})
  await call('build_plan_invalid', 'build_plan', { household: 42 })
  requireOkResult(
    await call('build_plan_fixture', 'build_plan', {
      household: singleHousehold,
      policy: singlePolicy,
      startYear: 2026,
    }),
    'build_plan fixture',
  )
  requireOkResult(await call('validate_plan_session', 'validate_plan', {}), 'validate_plan session')
  requireOkResult(
    await call('run_projection_years', 'run_projection', { detail: 'years' }, false),
    'run_projection years',
  )
  requireOkResult(
    await call('run_monte_carlo_seeded', 'run_monte_carlo', { pathCount: 300, seed: 7 }),
    'run_monte_carlo seeded',
  )
  requireOkResult(await call('batch_evaluate_fixture', 'batch_evaluate', {
    policies: [
      singlePolicy,
      { ...singlePolicy, conversion_bracket: null, conversion_years: 0 },
    ],
    objective: 'after_tax_estate',
  }), 'batch_evaluate fixture')
  requireOkResult(await call('run_optimizer_default', 'run_optimizer', {}), 'run_optimizer default')
  requireOkResult(
    await call('solve_max_spending_default', 'solve_max_spending', {}),
    'solve_max_spending default',
  )

  const firstExport = await call('export_plan_before_update', 'export_plan', {})
  const exportedBeforeUpdate = requireExport(firstExport)
  requireOkResult(await call('compare_scenarios_identical_export', 'compare_scenarios', {
    planA: exportedBeforeUpdate.plan,
    planB: exportedBeforeUpdate.plan,
    startYear: 2026,
  }), 'compare_scenarios identical export')
  requireOkResult(await call('explain_modeled_result', 'explain_modeled_result', {}), 'explain_modeled_result')
  requireSuccessfulResult(await call('get_session_before_update', 'get_session', {}), 'get_session')
  requireOkResult(await call('update_plan_base_annual', 'update_plan', {
    operations: [{ op: 'set_expense', field: 'baseAnnual', value: 60_001 }],
  }), 'update_plan baseAnnual')

  const secondExport = await call('export_plan_after_update', 'export_plan', {})
  const exportedAfterUpdate = requireExport(secondExport)
  requireOkResult(
    await call('build_plan_round_trip', 'build_plan', {
      plan: exportedAfterUpdate.plan,
      startYear: exportedAfterUpdate.startYear,
      conventions: exportedAfterUpdate.conventions,
      schemaVersion: exportedAfterUpdate.schemaVersion,
      engineVersion: exportedAfterUpdate.engineVersion,
      mcpVersion: exportedAfterUpdate.mcpVersion,
    }),
    'build_plan round-trip',
  )
  requireOkResult(
    await call('run_projection_round_trip_summary', 'run_projection', { detail: 'summary' }),
    'run_projection round-trip summary',
  )
  requireOkResult(await call('describe_plan_schema_full', 'describe_plan_schema', {}), 'describe_plan_schema')
  requireOkResult(await call('describe_plan_schema_accounts', 'describe_plan_schema', {
    path: 'properties.accounts',
  }), 'describe_plan_schema accounts')
  requireOkResult(await call('clear_session', 'clear_session', {}), 'clear_session')
  const finalSession = await call('get_session_after_clear', 'get_session', {})
  if (requireSuccessfulResult(finalSession, 'get_session after clear').hasPlan !== false) {
    throw new Error('clear_session did not leave the stdio session empty')
  }

  return matrix
}

function waitFor(promise, milliseconds, description) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), milliseconds)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** Capture the real command-line server over one stdio connection. */
export async function captureStdioLane({ root = PACKAGE_ROOT, fixtures }) {
  const cliPath = resolve(root, 'dist/cli.js')
  try {
    await access(cliPath)
  } catch {
    throw new Error('dist/cli.js is required for protocol capture; run pnpm run build first')
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath],
    cwd: root,
  })
  // The v1 Client exposes no getter for the negotiated protocol version; it
  // reports it only through the transport's optional setProtocolVersion hook.
  let negotiatedProtocolVersion
  transport.setProtocolVersion = (version) => {
    negotiatedProtocolVersion = version
  }
  const client = new Client({ name: 'protocol-baseline-client', version: '0.0.0' })

  let shuttingDown = false
  let resolveChildClose
  let rejectChildClose
  const childClosed = new Promise((resolveClose, rejectClose) => {
    resolveChildClose = resolveClose
    rejectChildClose = rejectClose
  })
  const priorClose = transport.onclose
  const priorError = transport.onerror
  transport.onclose = () => {
    priorClose?.()
    resolveChildClose()
  }
  transport.onerror = (error) => {
    priorError?.(error)
    if (shuttingDown) {
      resolveChildClose()
    } else {
      rejectChildClose(error)
    }
  }

  try {
    try {
      await client.connect(transport)
    } catch (connectError) {
      try {
        await transport.close()
      } catch {
        // swallow secondary cleanup errors; connect failure is the signal
      }
      throw connectError
    }

    const protocolVersion = negotiatedProtocolVersion
    const serverInfo = client.getServerVersion()
    if (!protocolVersion || !serverInfo?.name) {
      throw new Error('initialize did not expose negotiated protocolVersion and serverInfo.name')
    }
    const capabilities = canonicalize(client.getServerCapabilities() ?? null)
    const instructions = client.getInstructions?.() ?? null
    const { inventory, resource } = await captureInventoryAndResource(client)
    const matrix = await replayStdioMatrix(client, fixtures)
    return {
      handshake: {
        protocolVersion,
        // The complete initialize Implementation object (title, icons, website
        // URL and future fields included), with only the valid version value
        // sentineled — server metadata drift is client-visible wire drift.
        serverInfo: {
          ...canonicalize(serverInfo),
          version:
            typeof serverInfo.version === 'string' ? MCP_VERSION_SENTINEL : serverInfo.version,
        },
        actualServerVersion: serverInfo.version,
        capabilities,
        instructions,
      },
      inventory,
      resource,
      matrix,
    }
  } finally {
    shuttingDown = true
    let closeError
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
  }
}

/** Capture the authorization refusal surface using the existing in-memory harness shape. */
export async function captureInMemoryLane({ root = PACKAGE_ROOT, fixtures }) {
  const [sessionModule, toolsModule] = await Promise.all([
    import(pathToFileURL(resolve(root, 'dist/session.js')).href),
    import(pathToFileURL(resolve(root, 'dist/tools.js')).href),
  ])
  const server = new McpServer({ name: 'protocol-baseline-in-memory', version: '0.0.0' })
  const session = sessionModule.createSession()
  toolsModule.registerTools(server, session, {
    authorize: ({ name }) =>
      name === 'export_plan' ? { allow: false, result: FIXED_REFUSAL } : { allow: true },
  })
  const client = new Client({ name: 'protocol-baseline-client', version: '0.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

  try {
    const matrix = []
    const call = async (step, tool, args) => {
      const record = await captureToolCall({ client, lane: 'inmemory', step, tool, args })
      matrix.push(record.entry)
      return record
    }
    requireOkResult(
      await call('build_plan_allowed', 'build_plan', {
        household: fixtures.singleHousehold,
        policy: fixtures.singlePolicy,
        startYear: 2026,
      }),
      'authorized build_plan',
    )
    const refusal = await call('export_plan_refused', 'export_plan', {})
    const refusalPayload = requireSuccessfulResult(refusal, 'authorization refusal')
    if (canonicalJson(refusalPayload) !== canonicalJson(FIXED_REFUSAL)) {
      throw new Error('export_plan authorization refusal payload drifted')
    }
    requireOkResult(
      await call('run_projection_allowed_after_refusal', 'run_projection', { detail: 'summary' }),
      'run_projection after authorization refusal',
    )
    return matrix
  } finally {
    // Match the existing registerTools harness: closing the client releases the
    // linked transport before the server tears down its own protocol state.
    await client.close()
    await server.close()
  }
}

async function defaultFixtures() {
  // Node 24+ strips the type-only import and annotations in this shared fixture;
  // keeping the source import prevents a copied planning literal from becoming stale.
  return import(new URL('../tests/fixtures.ts', import.meta.url))
}

function resolvedPackageVersion(packageName, entrySubpath) {
  // Not every package exports ./package.json (the v1 SDK does not); fall back
  // to resolving a real entry point and walking up to the owning manifest —
  // the same recovery src/versions.ts uses for the engine.
  try {
    const manifest = require(`${packageName}/package.json`)
    if (typeof manifest?.version === 'string') return manifest.version
  } catch {
    // fall through to the walk-up below
  }
  let dir = dirname(require.resolve(entrySubpath ?? packageName))
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(dir, 'package.json')
    try {
      const manifest = JSON.parse(readFileSync(candidate, 'utf8'))
      if (manifest.name === packageName && typeof manifest.version === 'string') {
        return manifest.version
      }
    } catch {
      // keep walking up
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(`Could not resolve ${packageName} package version from its installed package.json`)
}

/** Optimizer wall-clock budget exhaustion is CI contention, not wire drift. */
export function optimizerTimedOut(baselineLike) {
  const entry = baselineLike?.matrix?.find((item) => item?.step === 'run_optimizer_default')
  const payload = entry?.payload
  if (!payload || typeof payload !== 'object') return false
  if (payload.status === 'timeout') return true
  if (payload.schedule?.status === 'timeout') return true
  return false
}

/**
 * Capture both baseline lanes. This is exported for the Vitest replay; direct
 * execution below is the sole writer of tests/protocol-baseline/baseline.json.
 */
export async function captureProtocolBaseline({ root = PACKAGE_ROOT, fixtures } = {}) {
  const activeFixtures = fixtures ?? (await defaultFixtures())
  const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  const sdkPackage = resolvedPackageVersion(
    '@modelcontextprotocol/sdk',
    '@modelcontextprotocol/sdk/client/index.js',
  )
  if (!sdkPackage.startsWith('1.')) {
    throw new Error(
      `The protocol-baseline observer must remain the frozen v1 @modelcontextprotocol/sdk client; resolved ${sdkPackage}. Install the v1 SDK as an exact dev dependency — do not observe the migration through the SDK generation being migrated to.`,
    )
  }
  const stdio = await captureStdioLane({ root, fixtures: activeFixtures })
  if (stdio.handshake.actualServerVersion !== packageJson.version) {
    throw new Error('stdio serverInfo.version did not match this package.json version')
  }
  const inMemory = await captureInMemoryLane({ root, fixtures: activeFixtures })
  return canonicalize({
    meta: {
      mcpPackage: MCP_VERSION_SENTINEL,
      enginePackage: resolvedPackageVersion('@retiregolden/engine'),
      zodPackage: resolvedPackageVersion('zod'),
      sdkPackage,
      protocolVersion: stdio.handshake.protocolVersion,
      serverInfo: stdio.handshake.serverInfo,
      serverCapabilities: stdio.handshake.capabilities,
      serverInstructions: stdio.handshake.instructions,
      nodeMajor: Number(process.versions.node.split('.')[0]),
      toolSchemaFile: 'schemas/tools.v1.json',
    },
    inventory: stdio.inventory,
    resource: stdio.resource,
    matrix: [...stdio.matrix, ...inMemory],
  })
}

// Case-insensitive on the file path: Windows drive-letter casing varies by
// invoker, and a mismatch here would silently skip the write instead of failing.
const invokedDirectly =
  process.argv[1] &&
  resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()
if (invokedDirectly) {
  let baseline = await captureProtocolBaseline()
  if (optimizerTimedOut(baseline)) {
    baseline = await captureProtocolBaseline()
    if (optimizerTimedOut(baseline)) {
      console.error(
        'run_optimizer_default timed out on two consecutive captures; this machine is too contended to freeze a protocol baseline.',
      )
      process.exit(1)
    }
  }
  await mkdir(dirname(BASELINE_PATH), { recursive: true })
  await writeFile(BASELINE_PATH, `${canonicalJson(baseline)}\n`, 'utf8')
  console.log(`Wrote protocol baseline to ${BASELINE_PATH}`)
}
