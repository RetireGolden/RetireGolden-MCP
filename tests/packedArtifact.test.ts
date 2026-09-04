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
import { Client as V1Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport as V1Stdio } from '@modelcontextprotocol/sdk/client/stdio.js'
import { singleHousehold, singlePolicy } from './fixtures.js'
import { ensureBuild } from './helpers/build.js'
import {
  PINNED_MODERN,
  TOOL_NAMES,
  assertCanonicalEqual,
  assertLane,
  createEraHarness,
  openStdio,
  stripEraEnvelope,
  type CallCapture,
  type Canonicalize,
  type EnvelopeView,
  type LaneCapture,
  type ToolClient,
} from './helpers/eraHarness.js'

const execFile = promisify(execFileCallback)
const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const baselinePath = fileURLToPath(new URL('./protocol-baseline/baseline.json', import.meta.url))
const captureModuleUrl = new URL('../scripts/capture-protocol-baseline.mjs', import.meta.url).href

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

interface CommittedMeta {
  protocolVersion: string
  serverInfo: unknown
  serverCapabilities: unknown
  serverInstructions: string | null
  initializeResult: unknown
}

interface StdioBaselineCapture extends ProtocolBaseline {
  handshake: {
    protocolVersion: string
    serverInfo: unknown
    capabilities: unknown
    instructions: string | null
    initializeResult: unknown
    actualServerVersion: string | undefined
  }
}

interface CaptureLibrary {
  canonicalize(value: unknown): unknown
  envelopeView(result: unknown): unknown
  optimizerTimedOut(baseline: unknown): boolean
  drainObservedMcpVersions(): unknown[]
  captureStdioLane(options: {
    root: string
    fixtures: { singleHousehold: typeof singleHousehold; singlePolicy: typeof singlePolicy }
  }): Promise<StdioBaselineCapture>
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

/**
 * On win32 the .cmd shims require shell: true (CVE-2024-27980), and cmd.exe
 * receives the argv joined with spaces UNQUOTED — a temp path containing a
 * space would be split. Quote path-bearing args when a shell is in play.
 */
function shellSafe(args: string[]): string[] {
  if (process.platform !== 'win32') return args
  return args.map((arg) => (/[\s^&()%!"]/.test(arg) ? `"${arg}"` : arg))
}

/**
 * The harness captures the malformed call only when asked to, and this gate
 * always asks; a missing capture is a harness wiring bug, not a lane result.
 */
function requireMalformed(lane: LaneCapture): CallCapture {
  const malformed = lane.calls.malformed
  if (!malformed) throw new Error('the packed harness did not capture a malformed call')
  return malformed
}

describe('packed npm artifact', () => {
  let packageManifest!: PackageManifest
  let expectedFiles!: string[]
  let tarballFiles!: string[]
  let installedPackages!: InstalledPackage[]
  let installedPackageRoot!: string
  let packedBaseline!: StdioBaselineCapture
  let expectedBaseline!: ProtocolBaseline
  let canonicalize!: Canonicalize
  let envelopeView!: EnvelopeView
  let v1Legacy!: LaneCapture
  let v2Default!: LaneCapture
  let v2Auto!: LaneCapture
  let v2Pinned!: LaneCapture
  let packDirectory: string | undefined
  let consumerDirectory: string | undefined

  beforeAll(async () => {
    packageManifest = await readPackageManifest(join(packageRoot, 'package.json'))
    packDirectory = await mkdtemp(join(tmpdir(), 'retiregolden-mcp-pack-'))

    // `pnpm pack` publishes dist/, so it must be current — but the build itself
    // belongs to tests/globalSetup.ts, which has already run. Assert only.
    await ensureBuild(packageRoot)
    expectedFiles = await expectedTarballFiles(packageManifest)
    await execFile('pnpm', shellSafe(['pack', '--pack-destination', packDirectory]), {
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
      await execFile('npm', shellSafe(['install', tarballPath, '--no-audit', '--no-fund']), {
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
    const harness = createEraHarness({
      target: { cliPath: join(installedPackageRoot, 'dist', 'cli.js'), cwd: consumerDirectory },
      labelPrefix: 'packed-artifact',
      captureMalformed: true,
      childDescription: 'the packed stdio child process to exit',
      canonicalize,
      envelopeView,
    })
    v1Legacy = await harness.runV1Lane()
    v2Default = await harness.runV2Lane({ expectedEra: 'legacy' })
    v2Auto = await harness.runV2Lane({ negotiation: { mode: 'auto' }, expectedEra: 'modern' })
    v2Pinned = await harness.runV2Lane({
      negotiation: { mode: { pin: PINNED_MODERN } },
      expectedEra: 'modern',
    })
    capture.drainObservedMcpVersions()
    packedBaseline = await capture.captureStdioLane({
      root: installedPackageRoot,
      fixtures: { singleHousehold, singlePolicy },
    })
    // The sentinel hid these from the hashes; the raw values must still be the
    // version this artifact claims to be — same provenance rule as
    // captureProtocolBaseline, enforced here against the INSTALLED package.
    for (const version of capture.drainObservedMcpVersions()) {
      if (version !== null && version !== packageManifest.version) {
        throw new Error(
          `installed artifact advertised mcpVersion ${JSON.stringify(version)}; expected ${packageManifest.version}`,
        )
      }
    }
    // Same contention absorber as the checkout baseline replay: one retry when
    // the optimizer's wall-clock budget expires on a loaded worker.
    if (capture.optimizerTimedOut(packedBaseline)) {
      capture.drainObservedMcpVersions()
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

  it('exposes the documented programmatic exports from the installed package', async () => {
    // Embedders import the package root; a broken exports map would leave the
    // CLI green while every programmatic host fails. Resolve through the
    // scratch consumer's own node_modules, not this checkout's.
    if (!consumerDirectory) throw new Error('beforeAll did not create the npm consumer directory')
    const probe =
      "const m = await import('@retiregolden/mcp'); " +
      "const bad = ['registerTools', 'registerResources', 'jsonResult'].filter((n) => typeof m[n] !== 'function'); " +
      "if (bad.length > 0 || typeof m.EDUCATIONAL !== 'string') { console.error('missing exports: ' + bad.join(',')); process.exit(1) } " +
      "console.log('exports-ok')"
    const { stdout } = await execFile(
      process.execPath,
      ['--input-type=module', '-e', probe],
      { cwd: consumerDirectory, windowsHide: true },
    )
    expect(stdout.trim()).toBe('exports-ok')
  }, 120_000)

  it('serves MCP through the npm-installed executable shim', async () => {
    // The other lanes launch dist/cli.js directly; this one exercises the
    // documented entry point — the bin shim npm generated from package.json's
    // bin field. A removed or mispointed bin would break `npx -y
    // @retiregolden/mcp` while every direct-path lane stayed green. The v1
    // transport spawns via cross-spawn, which handles the .cmd shim on
    // Windows.
    if (!consumerDirectory) throw new Error('beforeAll did not create the npm consumer directory')
    const shim = join(
      consumerDirectory,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'retiregolden-mcp.cmd' : 'retiregolden-mcp',
    )
    await stat(shim)
    const transport = new V1Stdio({ command: shim, cwd: consumerDirectory })
    const session = await openStdio(
      new V1Client({ name: 'packed-bin-shim', version: '0.0.0' }) as ToolClient,
      transport,
      'the packed stdio child process to exit',
    )
    try {
      const listed = await session.client.listTools()
      expect(listed.tools.map((tool) => tool.name)).toEqual(TOOL_NAMES)
    } finally {
      await session.close()
    }
  }, 120_000)

  it('a. lets the frozen v1 client use legacy initialize', () => {
    assertLane('packed v1 SDK', v1Legacy, 'legacy', { expectMalformed: true })
  }, 120_000)

  it('b. keeps the v2 default client on legacy initialize without probing', () => {
    assertLane('packed v2 default', v2Default, 'legacy', { expectMalformed: true })
  }, 120_000)

  it('c. lets v2 auto negotiation select modern server/discover', () => {
    assertLane('packed v2 auto', v2Auto, 'modern', { expectMalformed: true })
  }, 120_000)

  it('d. lets v2 pinned negotiation select modern without fallback', () => {
    assertLane('packed v2 pinned', v2Pinned, 'modern', { expectMalformed: true })
  }, 120_000)

  it('matches the committed stdio baseline hashes through the installed CLI', () => {
    expect(packedBaseline.handshake.actualServerVersion).toBe(packageManifest.version)
    // Full handshake parity, not just the version: the tarball's caret server
    // dependency can resolve a different 2.x than the checkout lockfile, and
    // legacy initialize metadata is part of the committed wire baseline.
    const committedMeta = (expectedBaseline as unknown as { meta: CommittedMeta }).meta
    expect(packedBaseline.handshake.protocolVersion, 'packed protocolVersion').toBe(
      committedMeta.protocolVersion,
    )
    expect(packedBaseline.handshake.serverInfo, 'packed serverInfo').toEqual(committedMeta.serverInfo)
    expect(canonicalize(packedBaseline.handshake.capabilities), 'packed serverCapabilities').toEqual(
      committedMeta.serverCapabilities,
    )
    expect(packedBaseline.handshake.instructions, 'packed serverInstructions').toEqual(
      committedMeta.serverInstructions,
    )
    expect(canonicalize(packedBaseline.handshake.initializeResult), 'packed initializeResult').toEqual(
      committedMeta.initializeResult,
    )
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

  it('keeps modern packed responses on the conservative cache posture', () => {
    // Asserted BEFORE stripEraEnvelope can erase them: the installed server
    // resolves from the published ^2.0.0 range, so a hint regression in a
    // newer 2.x must fail this release gate, not vanish in normalization.
    for (const [label, lane] of [
      ['pinned', v2Pinned],
      ['auto', v2Auto],
    ] as const) {
      const inventory = lane.inventory as { cacheScope?: string; ttlMs?: number }
      expect(inventory.cacheScope, `packed ${label} tools/list cacheScope`).toBe('private')
      expect(inventory.ttlMs ?? 0, `packed ${label} tools/list ttlMs`).toBe(0)
      // Plan-bearing tool results must never be publicly cacheable — the
      // hints are asserted raw, before envelope normalization drops them.
      const calls = [
        ...lane.calls.primary,
        requireMalformed(lane),
        lane.calls.isolatedNoPlan,
      ]
      for (const [index, call] of calls.entries()) {
        expect(call.rawCacheScope ?? 'private', `packed ${label} call ${index} cacheScope`).toBe(
          'private',
        )
        expect(call.rawTtlMs ?? 0, `packed ${label} call ${index} ttlMs`).toBe(0)
      }
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
    // Validation wording is authored by the one shared server implementation,
    // so the malformed result must be era-invariant too.
    assertCanonicalEqual(
      canonicalize,
      requireMalformed(v1Legacy).payload,
      requireMalformed(v2Pinned).payload,
      'malformed build_plan payload',
    )
    assertCanonicalEqual(
      canonicalize,
      stripEraEnvelope(requireMalformed(v1Legacy).envelope),
      stripEraEnvelope(requireMalformed(v2Pinned).envelope),
      'malformed build_plan envelope',
    )
  }, 120_000)
})
