/**
 * Build freshness for the suites that exercise `dist/` rather than `src/`.
 *
 * Not a test file (no `*.test.ts` suffix), so vitest's
 * `include: ['tests/**\/*.test.ts']` never collects it as a suite.
 *
 * `tests/dualEra.test.ts`, `tests/protocolBaseline.test.ts` and
 * `tests/packedArtifact.test.ts` all need the same guarantee: the emitted
 * JavaScript is not older than the TypeScript it was emitted from. They used to
 * each spawn `pnpm run build` from their own `beforeAll`, and vitest runs test
 * files in parallel — on CI, where `pnpm test` runs before `pnpm run build` and
 * `dist/` does not exist yet, two `tsc` emits raced on the same directory and a
 * lane occasionally read a half-written `dist/` (it bit
 * `test (windows-latest, 24)` on PR #64 and passed on rerun).
 *
 * So the spawn happens exactly once, in `tests/globalSetup.ts`, before any test
 * file is loaded: `buildIfStale()` is the only function here that runs a build.
 * `ensureBuild()` — what the suites call — only ASSERTS freshness, so no test
 * file can race another.
 */

import { execFile as execFileCallback } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFile = promisify(execFileCallback)

/** Repository root, resolved from this file rather than the caller's location. */
export const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url))

/**
 * Where `buildIfStale()` records what `dist/` was built from.
 *
 * Deliberately NOT under `dist/`: `package.json`'s `files` array publishes that
 * directory wholesale, and `tests/packedArtifact.test.ts` compares the tarball's
 * entries against a walk of it. A stamp file there would either enter the
 * published artifact or desynchronize that gate. `node_modules/` is neither
 * published nor walked.
 */
function stampPath(packageRoot: string): string {
  return `${packageRoot}/node_modules/.cache/retiregolden-mcp-build-stamp`
}

/** Every regular file under `directory`, recursively, as `/`-joined paths. */
export async function sourceFiles(directory: string): Promise<string[]> {
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

/**
 * A content digest of everything `tsc -p tsconfig.build.json` reads from this
 * repo: every `src/**\/*.ts` (path and bytes) plus the package version, which
 * `src/version.ts`-style lookups and the packed gate both depend on.
 */
async function computeBuildStamp(packageRoot: string, sources: string[]): Promise<string> {
  const hash = createHash('sha256')
  const manifest = JSON.parse(await readFile(`${packageRoot}/package.json`, 'utf8')) as {
    version?: unknown
  }
  hash.update(`version:${String(manifest.version)}\n`)
  for (const source of [...sources].sort()) {
    hash.update(`${source.slice(packageRoot.length)}\n`)
    hash.update(await readFile(source))
  }
  return hash.digest('hex')
}

async function readBuildStamp(packageRoot: string): Promise<string | null> {
  try {
    return (await readFile(stampPath(packageRoot), 'utf8')).trim()
  } catch {
    return null
  }
}

/**
 * True when every `src/*.ts` has its emitted `dist/*.js` present, and `dist/`
 * was emitted from the sources on disk right now.
 *
 * The capture imports several dist modules and the spawned CLI loads the rest
 * of the output graph, so the presence check is against the EXPECTED output
 * set. Scanning only surviving dist files would bless a partial build whose
 * remaining files happen to be fresh.
 *
 * Freshness itself is content-based when the stamp written by `buildIfStale()`
 * is available, because mtimes lie in one specific way this repo hits often: a
 * `dist/` left over from a different HEAD (a branch switch, a rebase) can be
 * newer than every `src/` file while having been emitted from other source.
 * Without the stamp — a `dist/` built by a bare `pnpm run build`, or a cleared
 * `node_modules/.cache` — the old mtime comparison still applies.
 */
export async function buildIsCurrent(packageRoot: string = PACKAGE_ROOT): Promise<boolean> {
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
  const stamp = await readBuildStamp(packageRoot)
  if (stamp !== null) return stamp === (await computeBuildStamp(packageRoot, sources))
  const newestSource = Math.max(...sourceStats.map((s) => s.mtimeMs))
  const oldestOutput = Math.min(...outputStats.map((s) => s.mtimeMs))
  return newestSource < oldestOutput
}

/**
 * Build `dist/` unless it is already current, then record what it was built
 * from. The ONLY build spawn in the test tree: called from
 * `tests/globalSetup.ts`, once per vitest run, before any test file loads.
 */
export async function buildIfStale(packageRoot: string = PACKAGE_ROOT): Promise<boolean> {
  if (await buildIsCurrent(packageRoot)) return false
  // Windows Node refuses to spawn .cmd shims without a shell (EINVAL since the
  // CVE-2024-27980 hardening), so the win32 leg must go through one.
  await execFile('pnpm', ['run', 'build'], {
    cwd: packageRoot,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
    shell: process.platform === 'win32',
  })
  const sources = (await sourceFiles(`${packageRoot}/src`)).filter((file) => file.endsWith('.ts'))
  const stampFile = stampPath(packageRoot)
  await mkdir(dirname(stampFile), { recursive: true })
  await writeFile(stampFile, `${await computeBuildStamp(packageRoot, sources)}\n`, 'utf8')
  return true
}

/**
 * Assert that `dist/` is present and current. Never builds — see the file
 * header: a per-file build spawn is exactly the race this replaced.
 */
export async function ensureBuild(packageRoot: string = PACKAGE_ROOT): Promise<void> {
  if (await buildIsCurrent(packageRoot)) return
  throw new Error(
    `dist/ is missing or stale relative to src/ (checked under ${packageRoot}). ` +
      'Test files no longer build it themselves; tests/globalSetup.ts does, once per vitest ' +
      'run. Reaching this means the global setup did not run (a bare `vitest` invocation with ' +
      'a different config?) or a source file changed mid-run. Run `pnpm run build`.',
  )
}
