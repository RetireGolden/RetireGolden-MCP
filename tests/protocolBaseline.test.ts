/**
 * Protocol baseline replay: the migration guard for the public MCP wire surface.
 *
 * Engine number tests pin modeling behavior. This one pins the SDK-visible
 * inventory, resource document, and deterministic tool envelopes. If the engine
 * pin is unchanged, a drift here is an SDK/wire regression, not a baseline to
 * casually update away.
 */

import { execFile as execFileCallback } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { describe, expect, beforeAll, it } from 'vitest'
import { singleHousehold, singlePolicy } from './fixtures.js'

const execFile = promisify(execFileCallback)
const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const baselinePath = fileURLToPath(new URL('./protocol-baseline/baseline.json', import.meta.url))
const captureModuleUrl = new URL('../scripts/capture-protocol-baseline.mjs', import.meta.url).href

interface MatrixStep {
  step: string
  tool: string
  lane: 'stdio' | 'inmemory'
  argsDigest: string
  payloadHash: string
  envelopeHash?: string
  kind: string
  isError?: boolean
}

interface ProtocolBaseline {
  meta: {
    mcpPackage: string
    enginePackage: string
    zodPackage: string
    sdkPackage: string
    protocolVersion: string
    serverInfo: { name: string; version: string }
    serverCapabilities: unknown
    serverInstructions: string | null
    nodeMajor: number
    toolSchemaFile: string
  }
  inventory: { sha256: string }
  resource: { uri: string; mimeType: string; sha256: string }
  matrix: MatrixStep[]
}

interface CaptureLibrary {
  captureProtocolBaseline(options: {
    root: string
    fixtures: { singleHousehold: typeof singleHousehold; singlePolicy: typeof singlePolicy }
  }): Promise<ProtocolBaseline>
  optimizerTimedOut(baseline: ProtocolBaseline): boolean
}

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
  const cli = `${packageRoot}/dist/cli.js`
  let cliStat
  try {
    cliStat = await stat(cli)
  } catch {
    return false
  }
  const sources = await sourceFiles(`${packageRoot}/src`)
  const sourceStats = await Promise.all(sources.map((source) => stat(source)))
  return !sourceStats.some((sourceStat) => sourceStat.mtimeMs >= cliStat.mtimeMs)
}

async function ensureBuild(): Promise<void> {
  if (await buildIsCurrent()) return
  // Windows Node refuses to spawn .cmd shims without a shell (EINVAL since the
  // CVE-2024-27980 hardening), so the win32 leg must go through one.
  await execFile('pnpm', ['run', 'build'], {
    cwd: packageRoot,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
    shell: process.platform === 'win32',
  })
}

async function readBaseline(): Promise<ProtocolBaseline> {
  try {
    return JSON.parse(await readFile(baselinePath, 'utf8')) as ProtocolBaseline
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        'Protocol baseline is absent. Run pnpm run baseline:capture to generate tests/protocol-baseline/baseline.json.',
      )
    }
    throw error
  }
}

const ENGINE_NUMERIC_STEPS = new Set([
  'build_plan_fixture',
  'validate_plan_session',
  'run_projection_years',
  'run_monte_carlo_seeded',
  'batch_evaluate_fixture',
  'run_optimizer_default',
  'solve_max_spending_default',
  'export_plan_before_update',
  'compare_scenarios_identical_export',
  'update_plan_base_annual',
  'export_plan_after_update',
  'build_plan_round_trip',
  'run_projection_round_trip_summary',
])

function driftMessage(step: string): string {
  if (ENGINE_NUMERIC_STEPS.has(step)) {
    return `${step} drifted (engine-numeric payload); with the engine pin unchanged this is a serving-stack regression — if the engine pin moved, regenerate the baseline deliberately.`
  }
  return `${step} drifted; with the engine pin unchanged, this indicates an SDK/wire regression.`
}

describe('protocol baseline', () => {
  let expected: ProtocolBaseline
  let actual: ProtocolBaseline

  beforeAll(async () => {
    await ensureBuild()
    expected = await readBaseline()
    const capture = (await import(captureModuleUrl)) as CaptureLibrary
    actual = await capture.captureProtocolBaseline({
      root: packageRoot,
      fixtures: { singleHousehold, singlePolicy },
    })
    if (capture.optimizerTimedOut(actual)) {
      actual = await capture.captureProtocolBaseline({
        root: packageRoot,
        fixtures: { singleHousehold, singlePolicy },
      })
      if (capture.optimizerTimedOut(actual)) {
        throw new Error(
          'run_optimizer_default timed out on two consecutive captures; CI contention prevented a stable baseline replay — this is not baseline drift.',
        )
      }
    }
  }, 120_000)

  it('matches the committed v1 protocol contract', () => {
    // During the planned SDK v2 swap, meta fields (e.g. sdkPackage) change
    // deliberately; soft assertions let the full matrix report drift in one run
    // instead of exiting at the first meta mismatch, which is what makes this
    // usable as the migration referee.
    expect.soft(actual.meta.mcpPackage, driftMessage('mcp package sentinel')).toBe(
      expected.meta.mcpPackage,
    )
    expect.soft(actual.meta.enginePackage, driftMessage('engine package')).toBe(
      expected.meta.enginePackage,
    )
    expect.soft(
      actual.meta.zodPackage,
      'zod version changed; build_plan_invalid wording is zod-authored — regenerate deliberately with the bump',
    ).toBe(expected.meta.zodPackage)
    expect.soft(actual.meta.sdkPackage, driftMessage('SDK package')).toBe(expected.meta.sdkPackage)
    expect.soft(actual.meta.protocolVersion, driftMessage('initialize protocolVersion')).toBe(
      expected.meta.protocolVersion,
    )
    expect.soft(actual.meta.serverInfo, driftMessage('initialize serverInfo')).toEqual(
      expected.meta.serverInfo,
    )
    expect.soft(actual.meta.serverCapabilities, driftMessage('initialize serverCapabilities')).toEqual(
      expected.meta.serverCapabilities,
    )
    expect.soft(actual.meta.serverInstructions, driftMessage('initialize serverInstructions')).toEqual(
      expected.meta.serverInstructions,
    )
    expect.soft(actual.meta.toolSchemaFile, driftMessage('tool schema file')).toBe(
      expected.meta.toolSchemaFile,
    )

    expect.soft(actual.inventory.sha256, driftMessage('tools/list inventory')).toBe(
      expected.inventory.sha256,
    )
    expect.soft(actual.resource.uri, driftMessage('plan-schema resource URI')).toBe(
      expected.resource.uri,
    )
    expect.soft(actual.resource.mimeType, driftMessage('plan-schema resource MIME type')).toBe(
      expected.resource.mimeType,
    )
    expect.soft(actual.resource.sha256, driftMessage('plan-schema resource')).toBe(
      expected.resource.sha256,
    )

    expect(actual.matrix, driftMessage('fixture matrix shape')).toHaveLength(expected.matrix.length)
    for (const [index, expectedStep] of expected.matrix.entries()) {
      const observed = actual.matrix[index]
      expect(observed, driftMessage(`matrix entry ${index}`)).toBeDefined()
      if (!observed) continue
      const stepLabel = expectedStep.step
      expect.soft(observed.lane, driftMessage(stepLabel)).toBe(expectedStep.lane)
      expect.soft(observed.step, driftMessage(stepLabel)).toBe(expectedStep.step)
      expect.soft(observed.tool, driftMessage(stepLabel)).toBe(expectedStep.tool)
      expect.soft(observed.argsDigest, driftMessage(stepLabel)).toBe(expectedStep.argsDigest)
      expect.soft(observed.kind, driftMessage(stepLabel)).toBe(expectedStep.kind)
      expect.soft(observed.isError, driftMessage(stepLabel)).toBe(expectedStep.isError)
      expect.soft(observed.payloadHash, driftMessage(stepLabel)).toBe(expectedStep.payloadHash)
      expect.soft(observed.envelopeHash, driftMessage(stepLabel)).toBe(expectedStep.envelopeHash)
    }
  })
})
