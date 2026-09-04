/**
 * The build-freshness stamp, and the version resolver it shares a motive with.
 *
 * `tests/helpers/build.ts` decides whether the dist-backed suites
 * (`dualEra`, `protocolBaseline`, `packedArtifact`) may trust `dist/`. A wrong
 * "yes" there does not fail loudly — it runs those suites against somebody
 * else's build and reports a pass, which is the failure mode the stamp exists
 * to prevent. So the stamp's invalidation paths are pinned here rather than
 * left to be exercised only by the real repository root.
 *
 * Every case runs against a synthetic package root in a temp directory:
 * `buildIsCurrent()` takes the root as a parameter and never builds, so these
 * tests never spawn `tsc`.
 */

import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildIsCurrent, computeBuildStamp } from './helpers/build.js'
import { resolveInstalledPackageVersion } from '../src/versions.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** A package root with one source, its emitted output, and both tsconfigs. */
async function fakeRoot(): Promise<string> {
  const root = (await mkdtemp(join(tmpdir(), 'rg-build-stamp-'))).replace(/\\/g, '/')
  roots.push(root)
  await Promise.all([
    mkdir(`${root}/src`, { recursive: true }),
    mkdir(`${root}/dist`, { recursive: true }),
    mkdir(`${root}/node_modules/.cache`, { recursive: true }),
    mkdir(`${root}/node_modules/typescript`, { recursive: true }),
  ])
  await Promise.all([
    writeFile(`${root}/package.json`, JSON.stringify({ name: 'fake', version: '1.0.0' })),
    writeFile(`${root}/tsconfig.json`, '{ "compilerOptions": { "strict": true } }'),
    writeFile(`${root}/tsconfig.build.json`, '{ "extends": "./tsconfig.json" }'),
    writeFile(`${root}/node_modules/typescript/package.json`, JSON.stringify({ version: '7.0.2' })),
    writeFile(`${root}/src/thing.ts`, 'export const thing = 1\n'),
    writeFile(`${root}/dist/thing.js`, 'export const thing = 1;\n'),
  ])
  return root
}

/** Write the stamp exactly as a successful `buildIfStale()` would. */
async function stampCurrentState(root: string): Promise<void> {
  const stamp = await computeBuildStamp(root, [`${root}/src/thing.ts`], [`${root}/dist/thing.js`])
  await writeFile(`${root}/node_modules/.cache/retiregolden-mcp-build-stamp`, `${stamp}\n`, 'utf8')
}

describe('build freshness stamp', () => {
  it('trusts dist/ when the stamp matches the current state', async () => {
    const root = await fakeRoot()
    await stampCurrentState(root)
    expect(await buildIsCurrent(root)).toBe(true)
  })

  it('rejects a missing emitted output even with a stamp present', async () => {
    const root = await fakeRoot()
    await stampCurrentState(root)
    await rm(`${root}/dist/thing.js`)
    expect(await buildIsCurrent(root)).toBe(false)
  })

  it('rejects a changed source', async () => {
    const root = await fakeRoot()
    await stampCurrentState(root)
    await writeFile(`${root}/src/thing.ts`, 'export const thing = 2\n')
    expect(await buildIsCurrent(root)).toBe(false)
  })

  it('rejects a dist/ replaced behind an unchanged stamp', async () => {
    // The bare-`pnpm run build`-on-another-HEAD trap: sources and config are
    // untouched, so an input-only digest would still say "current" while dist/
    // holds another commit's emit.
    const root = await fakeRoot()
    await stampCurrentState(root)
    await writeFile(`${root}/dist/thing.js`, 'export const thing = 99;\n')
    expect(await buildIsCurrent(root)).toBe(false)
  })

  it('rejects a build-config change that leaves every source byte alone', async () => {
    const root = await fakeRoot()
    await stampCurrentState(root)
    await writeFile(`${root}/tsconfig.build.json`, '{ "extends": "./tsconfig.json", "x": 1 }')
    expect(await buildIsCurrent(root)).toBe(false)
  })

  it('rejects a base tsconfig change', async () => {
    const root = await fakeRoot()
    await stampCurrentState(root)
    await writeFile(`${root}/tsconfig.json`, '{ "compilerOptions": { "strict": false } }')
    expect(await buildIsCurrent(root)).toBe(false)
  })

  it('rejects a compiler upgrade', async () => {
    const root = await fakeRoot()
    await stampCurrentState(root)
    await writeFile(
      `${root}/node_modules/typescript/package.json`,
      JSON.stringify({ version: '7.1.0' }),
    )
    expect(await buildIsCurrent(root)).toBe(false)
  })

  it('rejects a package version bump', async () => {
    const root = await fakeRoot()
    await stampCurrentState(root)
    await writeFile(`${root}/package.json`, JSON.stringify({ name: 'fake', version: '1.0.1' }))
    expect(await buildIsCurrent(root)).toBe(false)
  })

  it('falls back to mtimes when no stamp was written', async () => {
    // A dist/ from a bare `pnpm run build` (no stamp) is still usable: the old
    // newest-source-older-than-oldest-output comparison applies. mtimes are set
    // explicitly — two writes a few microseconds apart are not reliably
    // ordered by the filesystem's timestamp resolution.
    const root = await fakeRoot()
    const output = new Date(Date.now())
    const source = new Date(output.getTime() - 60_000)
    await utimes(`${root}/src/thing.ts`, source, source)
    await utimes(`${root}/dist/thing.js`, output, output)
    expect(await buildIsCurrent(root)).toBe(true)
  })

  it('falls back to mtimes and rejects a source newer than the emit', async () => {
    const root = await fakeRoot()
    const source = new Date(Date.now())
    const output = new Date(source.getTime() - 60_000)
    await utimes(`${root}/dist/thing.js`, output, output)
    await utimes(`${root}/src/thing.ts`, source, source)
    expect(await buildIsCurrent(root)).toBe(false)
  })
})

describe('resolveInstalledPackageVersion', () => {
  it('reads the version of a package that exports ./package.json', () => {
    // The engine is the case getVersions() resolves on the fast path.
    expect(resolveInstalledPackageVersion('@retiregolden/engine')).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('walks up from an entry point when ./package.json is not exported', () => {
    // The v1 MCP SDK is the case the walk-up exists for.
    expect(
      resolveInstalledPackageVersion(
        '@modelcontextprotocol/sdk',
        '@modelcontextprotocol/sdk/client/index.js',
      ),
    ).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('returns null rather than throwing for a package that is not installed', () => {
    // getVersions() degrades to a null version field on this path; the protocol
    // baseline capture turns the same null into a hard error of its own.
    expect(resolveInstalledPackageVersion('@retiregolden/definitely-not-installed')).toBeNull()
  })
})
