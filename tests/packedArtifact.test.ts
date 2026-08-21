/**
 * Release gate: the packed npm artifact, not this checkout's dist, must serve
 * both MCP protocol eras and preserve the committed legacy wire contract.
 */

import { execFile as execFileCallback } from 'node:child_process'
import type { Dirent } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
const baselinePath = fileURLToPath(new URL('./protocol-baseline/baseline.json', import.meta.url))
const captureModuleUrl = new URL('../scripts/capture-protocol-baseline.mjs', import.meta.url).href

const TOOL_NAMES = TOOL_TABLE.map((tool) => tool.name)
const seed = { household: singleHousehold, policy: singlePolicy, startYear: 2026 }
const PINNED_MODERN = '2026-07-28' as const
const MODERN_SERVER_INFO_META = 'io.modelcontextprotocol/serverInfo'

interface PackageManifest {
  name: string
  version: string
  files: string[]
  dependencies: Record<string, string>
}

interface InstalledPackage {
  name: string
  version: string
  dependencies: Record<string, string>
  manifestPath: string
}

interface MatrixStep {
  step: string
  tool: string
  lane: string
  argsDigest: string
  kind: string
  isError?: boolean
  payloadHash: string
  envelopeHash?: string
}

interface ProtocolBaseline {
  inventory: { sha256: string }
  resource: {
    uri: string
    sha256: string
    listSha256: string
    readSha256: string
  }
  matrix: MatrixStep[]
}

interface StdioBaselineCapture extends ProtocolBaseline {
  handshake: {
    actualServerVersion: string | undefined
  }
}

interface CaptureLibrary {
  canonicalize(value: unknown): unknown
  envelopeView(result: unknown): unknown
  optimizerTimedOut(baseline: unknown): boolean
  captureStdioLane(options: {
    root: string
    fixtures: { singleHousehold: typeof singleHousehold; singlePolicy: typeof singlePolicy }
  }): Promise<StdioBaselineCapture>
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

interface StdioTransport {
  pid?: number | null
  onclose?: () => void
  onerror?: (error: Error) => void
}

interface SessionHandle {
  client: ToolClient
  close(): Promise<void>
}

interface LaunchTarget {
  cliPath: string
  cwd: string
}

function requireDependencies(value: unknown, path: string): Record<string, string> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} did not contain a dependencies object`)
  }
  const dependencies = Object.entries(value).map(([name, version]) => {
    if (typeof version !== 'string') {
      throw new Error(`${path} dependency ${name} did not declare a string version`)
    }
    return [name, version] as const
  })
  return Object.fromEntries(dependencies)
}

function requirePackageManifest(value: unknown, path: string): PackageManifest {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} did not contain a package manifest object`)
  }
  const manifest = value as Record<string, unknown>
  if (
    typeof manifest.name !== 'string' ||
    typeof manifest.version !== 'string' ||
    !Array.isArray(manifest.files) ||
    !manifest.files.every((entry) => typeof entry === 'string')
  ) {
    throw new Error(`${path} did not contain the package fields required by the packed-artifact gate`)
  }
  return {
    name: manifest.name,
    version: manifest.version,
    files: manifest.files,
    dependencies: requireDependencies(manifest.dependencies, path),
  }
}

async function readPackageManifest(path: string): Promise<PackageManifest> {
  return requirePackageManifest(JSON.parse(await readFile(path, 'utf8')), path)
}

function requireInstalledPackage(value: unknown, path: string): Omit<InstalledPackage, 'manifestPath'> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} did not contain an installed package manifest object`)
  }
  const manifest = value as Record<string, unknown>
  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
    throw new Error(`${path} did not contain an installed package name and version`)
  }
  return {
    name: manifest.name,
    version: manifest.version,
    dependencies:
      manifest.dependencies === undefined ? {} : requireDependencies(manifest.dependencies, path),
  }
}

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) return filesUnder(path)
      return entry.isFile() ? [path] : []
    }),
  )
  return nested.flat()
}

async function expectedTarballFiles(manifest: PackageManifest): Promise<string[]> {
  const entries = ['package/package.json']
  for (const publishedPath of manifest.files) {
    const absolutePath = resolve(packageRoot, publishedPath)
    const info = await stat(absolutePath)
    const files = info.isDirectory() ? await filesUnder(absolutePath) : [absolutePath]
    entries.push(
      ...files.map((file) => `package/${relative(packageRoot, file).split(sep).join('/')}`),
    )
  }
  return entries.sort()
}

async function listTarballFiles(tarballPath: string): Promise<string[]> {
  // Pass only the basename with cwd set to the tarball's directory: GNU tar
  // (Git for Windows) reads a `C:\...` argument as a remote host, while
  // bsdtar (GitHub's windows-latest) accepts either — the cwd form works on
  // both.
  const { stdout } = await execFile('tar', ['-tzf', tarballPath.split(sep).pop() as string], {
    cwd: tarballPath.slice(0, tarballPath.lastIndexOf(sep)),
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  })
  // Directory records are implementation detail; package file entries are the
  // publish contract governed by package.json's files array.
  return stdout
    .split(/\r?\n/)
    .filter((entry) => entry.length > 0 && !entry.endsWith('/'))
    .sort()
}

async function readInstalledPackage(packageDirectory: string): Promise<InstalledPackage> {
  const manifestPath = join(packageDirectory, 'package.json')
  const manifest = requireInstalledPackage(JSON.parse(await readFile(manifestPath, 'utf8')), manifestPath)
  return { ...manifest, manifestPath }
}

async function scanPackageDirectory(packageDirectory: string): Promise<InstalledPackage[]> {
  const own = await readInstalledPackage(packageDirectory)
  const nested = await scanNodeModules(join(packageDirectory, 'node_modules'))
  return [own, ...nested]
}

async function scanScopeDirectory(scopeDirectory: string): Promise<InstalledPackage[]> {
  const entries = await readdir(scopeDirectory, { withFileTypes: true })
  const packages = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => scanPackageDirectory(join(scopeDirectory, entry.name))),
  )
  return packages.flat()
}

async function scanNodeModules(nodeModulesDirectory: string): Promise<InstalledPackage[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(nodeModulesDirectory, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const packages = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name !== '.bin')
      .map((entry) =>
        entry.name.startsWith('@')
          ? scanScopeDirectory(join(nodeModulesDirectory, entry.name))
          : scanPackageDirectory(join(nodeModulesDirectory, entry.name)),
      ),
  )
  return packages.flat()
}

function mcpDependencyClosure(packages: InstalledPackage[]): Set<string> {
  const byName = new Map(packages.map((installed) => [installed.name, installed]))
  const names = new Set<string>()
  const pending = ['@modelcontextprotocol/server']
  while (pending.length > 0) {
    const name = pending.pop()!
    if (names.has(name)) continue
    const installed = byName.get(name)
    if (!installed) {
      throw new Error(`installed MCP runtime omitted transitive dependency ${name}`)
    }
    names.add(name)
    for (const dependency of Object.keys(installed.dependencies)) {
      if (dependency.startsWith('@modelcontextprotocol/')) pending.push(dependency)
    }
  }
  return names
}

function waitFor(promise: Promise<unknown>, milliseconds: number, description: string): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), milliseconds)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function openStdio(client: ToolClient, transport: StdioTransport): Promise<SessionHandle> {
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
  await (client as unknown as { connect(transport: unknown): Promise<void> }).connect(transport)
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
        await waitFor(childClosed, 5_000, 'the packed stdio child process to exit')
      } catch (error) {
        const pid = transport.pid
        if (typeof pid === 'number') {
          try {
            process.kill(pid)
          } catch {
            // The child already exited or could not be signalled; the close timeout remains diagnostic.
          }
        }
        if (!closeError) closeError = error
      }
      if (closeError) throw closeError
    },
  }
}

function parsePayload(result: unknown): unknown {
  const content = (result as { content?: Array<{ type: string; text: string }> }).content
  const text = content?.find((entry) => entry.type === 'text')?.text
  expect(text, 'tool returned no text content').toBeTruthy()
  return JSON.parse(text as string)
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

async function exercisePrimaryCalls(
  client: ToolClient,
  canonicalize: (value: unknown) => unknown,
  envelopeView: (result: unknown) => unknown,
): Promise<CallCapture[]> {
  // State must cross these awaited calls on one connection; request concurrency
  // would not prove the packaged server preserves a session deterministically.
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
  target: LaunchTarget,
  canonicalize: (value: unknown) => unknown,
  envelopeView: (result: unknown) => unknown,
): Promise<LaneCapture> {
  const connect = async (label: string) => {
    const transport = new V1Stdio({
      command: process.execPath,
      args: [target.cliPath],
      cwd: target.cwd,
    })
    return openStdio(new V1Client({ name: label, version: '0.0.0' }) as ToolClient, transport)
  }

  const primary = await connect('packed-artifact-v1')
  let captured: Omit<LaneCapture, 'era' | 'calls'>
  let primaryCalls: CallCapture[]
  try {
    captured = await exercisePrimary(primary.client, canonicalize)
    primaryCalls = await exercisePrimaryCalls(primary.client, canonicalize, envelopeView)
  } finally {
    await primary.close()
  }

  const isolation = await connect('packed-artifact-v1-isolation')
  let isolatedNoPlan: CallCapture
  try {
    isolatedNoPlan = await exerciseIsolation(isolation.client, canonicalize, envelopeView)
  } finally {
    await isolation.close()
  }
  return { era: 'legacy', ...captured, calls: { primary: primaryCalls, isolatedNoPlan } }
}

async function runV2Lane(
  target: LaunchTarget,
  options: { negotiation?: VersionNegotiationOptions; expectedEra: ProtocolEra },
  canonicalize: (value: unknown) => unknown,
  envelopeView: (result: unknown) => unknown,
): Promise<LaneCapture> {
  const connect = async (label: string) => {
    const transport = new V2Stdio({
      command: process.execPath,
      args: [target.cliPath],
      cwd: target.cwd,
    })
    const client = new V2Client(
      { name: label, version: '0.0.0' },
      options.negotiation ? { versionNegotiation: options.negotiation } : undefined,
    )
    const session = await openStdio(client as ToolClient, transport)
    try {
      expect(client.getProtocolEra(), `${label} protocol era`).toBe(options.expectedEra)
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

  const primary = await connect('packed-artifact-v2')
  let captured: Omit<LaneCapture, 'era' | 'calls'>
  let primaryCalls: CallCapture[]
  try {
    captured = await exercisePrimary(primary.client, canonicalize)
    primaryCalls = await exercisePrimaryCalls(primary.client, canonicalize, envelopeView)
  } finally {
    await primary.close()
  }

  const isolation = await connect('packed-artifact-v2-isolation')
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
  expect(lane.toolNames, `${label} 14-tool inventory`).toEqual(TOOL_NAMES)
  expect(TOOL_NAMES, 'TOOL_TABLE drifted from the 14-tool public contract').toHaveLength(14)
  expect(lane.resourceMimeType, `${label} plan-schema mimeType`).toBe('application/json')
  expect((lane.calls.primary[0]?.payload as { ok?: boolean }).ok, `${label} build_plan`).toBe(true)
  expect((lane.calls.primary[1]?.payload as { ok?: boolean }).ok, `${label} run_projection`).toBe(true)
  expect((lane.calls.primary[2]?.payload as { ok?: boolean }).ok, `${label} export_plan`).toBe(true)
  expect(lane.calls.isolatedNoPlan.payload, `${label} second-connection isolation`).toMatchObject({
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

describe('packed npm artifact', () => {
  let packageManifest!: PackageManifest
  let expectedFiles!: string[]
  let tarballFiles!: string[]
  let installedPackages!: InstalledPackage[]
  let installedPackageRoot!: string
  let packedBaseline!: StdioBaselineCapture
  let expectedBaseline!: ProtocolBaseline
  let canonicalize!: (value: unknown) => unknown
  let envelopeView!: (result: unknown) => unknown
  let v1Legacy!: LaneCapture
  let v2Default!: LaneCapture
  let v2Auto!: LaneCapture
  let v2Pinned!: LaneCapture
  let packDirectory: string | undefined
  let consumerDirectory: string | undefined

  beforeAll(async () => {
    packageManifest = await readPackageManifest(join(packageRoot, 'package.json'))
    packDirectory = await mkdtemp(join(tmpdir(), 'retiregolden-mcp-pack-'))

    // Windows Node needs a shell for pnpm's .cmd shim after the CVE-2024-27980 hardening.
    await execFile('pnpm', ['run', 'build'], {
      cwd: packageRoot,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
      shell: process.platform === 'win32',
    })
    expectedFiles = await expectedTarballFiles(packageManifest)
    await execFile('pnpm', ['pack', '--pack-destination', packDirectory], {
      cwd: packageRoot,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
      shell: process.platform === 'win32',
    })

    const tarballName = `${packageManifest.name.replace(/^@/, '').replace('/', '-')}-${packageManifest.version}.tgz`
    const tarballPath = join(packDirectory, tarballName)
    await stat(tarballPath)
    tarballFiles = await listTarballFiles(tarballPath)

    consumerDirectory = await mkdtemp(join(tmpdir(), 'retiregolden-mcp-consumer-'))
    await writeFile(join(consumerDirectory, 'package.json'), '{"private":true}\n', 'utf8')
    // npm models the package-manager path npx users receive; pnpm would hide a
    // nested runtime dependency arrangement that npm may expose.
    try {
      await execFile('npm', ['install', tarballPath, '--no-audit', '--no-fund'], {
        cwd: consumerDirectory,
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
        shell: process.platform === 'win32',
      })
    } catch (error) {
      throw new Error(
        'installing the packed tarball failed — this gate needs npm registry access for the ' +
          'runtime dependencies (engine, @modelcontextprotocol/server); offline or mis-proxied ' +
          `environments cannot run test:packed. Underlying error: ${String(error)}`,
      )
    }

    installedPackageRoot = join(consumerDirectory, 'node_modules', '@retiregolden', 'mcp')
    await stat(join(installedPackageRoot, 'dist', 'cli.js'))
    installedPackages = await scanNodeModules(join(consumerDirectory, 'node_modules'))
    expectedBaseline = JSON.parse(await readFile(baselinePath, 'utf8')) as ProtocolBaseline

    const capture = (await import(captureModuleUrl)) as CaptureLibrary
    canonicalize = capture.canonicalize
    envelopeView = capture.envelopeView
    const target = { cliPath: join(installedPackageRoot, 'dist', 'cli.js'), cwd: consumerDirectory }
    v1Legacy = await runV1Lane(target, canonicalize, envelopeView)
    v2Default = await runV2Lane(target, { expectedEra: 'legacy' }, canonicalize, envelopeView)
    v2Auto = await runV2Lane(
      target,
      { negotiation: { mode: 'auto' }, expectedEra: 'modern' },
      canonicalize,
      envelopeView,
    )
    v2Pinned = await runV2Lane(
      target,
      { negotiation: { mode: { pin: PINNED_MODERN } }, expectedEra: 'modern' },
      canonicalize,
      envelopeView,
    )
    packedBaseline = await capture.captureStdioLane({
      root: installedPackageRoot,
      fixtures: { singleHousehold, singlePolicy },
    })
    // Same contention absorber as the checkout baseline replay: one retry when
    // the optimizer's wall-clock budget expires on a loaded worker.
    if (capture.optimizerTimedOut(packedBaseline)) {
      packedBaseline = await capture.captureStdioLane({
        root: installedPackageRoot,
        fixtures: { singleHousehold, singlePolicy },
      })
      if (capture.optimizerTimedOut(packedBaseline)) {
        throw new Error(
          'run_optimizer_default timed out on two consecutive packed captures; CI contention, not artifact drift.',
        )
      }
    }
  }, 300_000)

  afterAll(async () => {
    // The tarball and its npm consumer are test-only artifacts; cleanup must
    // never conceal the test failure that created them. Windows can hold
    // EBUSY/EPERM briefly after a child exits, so retry, and report (without
    // failing) when a tree survives so it does not accumulate silently.
    const removeTree = async (dir: string | undefined) => {
      if (!dir) return
      try {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      } catch (error) {
        console.error(`packedArtifact cleanup left ${dir} behind: ${String(error)}`)
      }
    }
    await Promise.all([removeTree(consumerDirectory), removeTree(packDirectory)])
  }, 120_000)

  it('contains exactly the files declared for publication', () => {
    expect(tarballFiles).toEqual(expectedFiles)
    expect(tarballFiles).toContain('package/dist/cli.js')
    expect(tarballFiles).toContain('package/schemas/tools.v1.json')
    expect(tarballFiles.some((entry) => entry.startsWith('package/skills/'))).toBe(true)
    expect(tarballFiles).toContain('package/LICENSE')
    expect(tarballFiles).toContain('package/DISCLAIMER.md')
    expect(tarballFiles).toContain('package/README.md')
    // docs is deliberately in package.json's files array, so client setup is public.
    expect(tarballFiles).toContain('package/docs/clients.md')
    for (const forbiddenPrefix of [
      'package/src/',
      'package/tests/',
      'package/scripts/',
      'package/node_modules/',
      'package/tests/protocol-baseline/',
    ]) {
      expect(tarballFiles.some((entry) => entry.startsWith(forbiddenPrefix)), forbiddenPrefix).toBe(false)
    }
  }, 120_000)

  it('installs one v2 MCP runtime and one exact engine through npm', () => {
    const mcpPackages = installedPackages.filter((installed) =>
      installed.name.startsWith('@modelcontextprotocol/'),
    )
    const mcpNames = mcpPackages.map((installed) => installed.name)
    const serverPackages = mcpPackages.filter(
      (installed) => installed.name === '@modelcontextprotocol/server',
    )
    expect(serverPackages).toHaveLength(1)
    expect(serverPackages[0]?.version).toMatch(/^2\./)
    expect(new Set(mcpNames).size, 'MCP runtime packages must not be duplicated').toBe(mcpNames.length)
    expect(mcpNames).not.toContain('@modelcontextprotocol/sdk')
    expect([...new Set(mcpNames)].sort()).toEqual([...mcpDependencyClosure(mcpPackages)].sort())

    const enginePin = packageManifest.dependencies['@retiregolden/engine']
    if (!enginePin) throw new Error('package.json did not pin @retiregolden/engine')
    const enginePackages = installedPackages.filter(
      (installed) => installed.name === '@retiregolden/engine',
    )
    expect(enginePackages).toHaveLength(1)
    expect(enginePackages[0]?.version).toBe(enginePin)
  }, 120_000)

  it('a. lets the frozen v1 client use legacy initialize', () => {
    assertLane('packed v1 SDK', v1Legacy, 'legacy')
  }, 120_000)

  it('b. keeps the v2 default client on legacy initialize without probing', () => {
    assertLane('packed v2 default', v2Default, 'legacy')
  }, 120_000)

  it('c. lets v2 auto negotiation select modern server/discover', () => {
    assertLane('packed v2 auto', v2Auto, 'modern')
  }, 120_000)

  it('d. lets v2 pinned negotiation select modern without fallback', () => {
    assertLane('packed v2 pinned', v2Pinned, 'modern')
  }, 120_000)

  it('matches the committed stdio baseline hashes through the installed CLI', () => {
    expect(packedBaseline.handshake.actualServerVersion).toBe(packageManifest.version)
    expect(packedBaseline.inventory.sha256).toBe(expectedBaseline.inventory.sha256)
    expect(packedBaseline.resource.sha256).toBe(expectedBaseline.resource.sha256)
    expect(packedBaseline.resource.uri).toBe(expectedBaseline.resource.uri)
    expect(packedBaseline.resource.listSha256).toBe(expectedBaseline.resource.listSha256)
    expect(packedBaseline.resource.readSha256).toBe(expectedBaseline.resource.readSha256)
    const expectedStdioMatrix = expectedBaseline.matrix.filter((entry) => entry.lane === 'stdio')
    expect(packedBaseline.matrix).toHaveLength(expectedStdioMatrix.length)
    for (const [index, expected] of expectedStdioMatrix.entries()) {
      const actual = packedBaseline.matrix[index]
      expect(actual?.step, `packed matrix step ${index}`).toBe(expected.step)
      expect(actual?.tool, expected.step).toBe(expected.tool)
      expect(actual?.lane, expected.step).toBe('stdio')
      expect(actual?.argsDigest, `${expected.step} args`).toBe(expected.argsDigest)
      expect(actual?.kind, `${expected.step} kind`).toBe(expected.kind)
      expect(actual?.isError, `${expected.step} isError`).toBe(expected.isError)
      expect(actual?.payloadHash, `${expected.step} payload`).toBe(expected.payloadHash)
      expect(actual?.envelopeHash, `${expected.step} envelope`).toBe(expected.envelopeHash)
    }
  }, 120_000)

  it('keeps legacy and pinned-modern packed responses semantically identical', () => {
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
    for (const [index, label] of ['build_plan', 'run_projection summary', 'export_plan'].entries()) {
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
  }, 120_000)
})
