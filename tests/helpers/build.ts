/**
 * Build freshness for the suites that exercise `dist/` rather than `src/`.
 *
 * Not a test file (no `*.test.ts` suffix), so vitest's
 * `include: ['tests/**\/*.test.ts']` never collects it as a suite.
 *
 * `tests/dualEra.test.ts` and `tests/protocolBaseline.test.ts` both spawn the
 * built CLI and both need the same guarantee: the emitted JavaScript is not
 * older than the TypeScript it was emitted from. They carried byte-identical
 * copies of this logic; one copy now serves both.
 */

import { execFile as execFileCallback } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFile = promisify(execFileCallback)

/** Repository root, resolved from this file rather than the caller's location. */
export const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url))

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
 * True when every `src/*.ts` has its emitted `dist/*.js` present and newer than
 * every source file.
 *
 * The capture imports several dist modules and the spawned CLI loads the rest
 * of the output graph, so the check is against the EXPECTED output set.
 * Scanning only surviving dist files would bless a partial build whose
 * remaining files happen to be fresh.
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
  const newestSource = Math.max(...sourceStats.map((s) => s.mtimeMs))
  const oldestOutput = Math.min(...outputStats.map((s) => s.mtimeMs))
  return newestSource < oldestOutput
}

/** Rebuild `dist/` unless it is already newer than every source file. */
export async function ensureBuild(packageRoot: string = PACKAGE_ROOT): Promise<void> {
  if (await buildIsCurrent(packageRoot)) return
  // Windows Node refuses to spawn .cmd shims without a shell (EINVAL since the
  // CVE-2024-27980 hardening), so the win32 leg must go through one.
  await execFile('pnpm', ['run', 'build'], {
    cwd: packageRoot,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
    shell: process.platform === 'win32',
  })
}
