/**
 * Running package identity (@retiregolden/mcp + @retiregolden/engine).
 *
 * Extracted from adapter.ts so buildPlan.ts can compare an imported document's
 * declared engineVersion against the installed one WITHOUT importing the adapter
 * (which imports buildPlan — a module cycle). `adapter.getVersions` re-exports
 * this, so every existing caller (get_session, export_plan,
 * explain_modeled_result, Pro) keeps the same import path.
 */

import { createRequire } from 'node:module'
import path from 'node:path'
import fs from 'node:fs'

let cachedVersions: { mcpVersion: string | null; engineVersion: string | null } | null = null

const require = createRequire(import.meta.url)

/**
 * Version of an installed package, resolved from its own package.json.
 *
 * Not every package exports `./package.json` (the v1 MCP SDK does not), so a
 * failed subpath require falls back to resolving a real entry point and walking
 * up to the owning manifest — verifying `name` on the way so a parent workspace
 * manifest can never be mistaken for the package's own.
 *
 * Returns null rather than throwing when nothing resolves: callers here degrade
 * to a null version field, and callers that must fail loudly (the protocol
 * baseline capture) turn the null into their own error.
 *
 * @param packageName bare specifier, e.g. `@retiregolden/engine`
 * @param entrySubpath entry to resolve for the walk-up, when the package root
 *   is not itself resolvable (e.g. `@modelcontextprotocol/sdk/client/index.js`)
 */
export function resolveInstalledPackageVersion(
  packageName: string,
  entrySubpath?: string,
): string | null {
  try {
    const manifest = require(`${packageName}/package.json`) as { version?: string }
    if (typeof manifest?.version === 'string') return manifest.version
  } catch {
    // fall through to the walk-up below
  }
  try {
    let dir = path.dirname(require.resolve(entrySubpath ?? packageName))
    for (let i = 0; i < 8; i++) {
      const candidate = path.join(dir, 'package.json')
      try {
        const manifest = JSON.parse(fs.readFileSync(candidate, 'utf8')) as {
          name?: string
          version?: string
        }
        if (manifest.name === packageName && typeof manifest.version === 'string') {
          return manifest.version
        }
      } catch {
        // keep walking up
      }
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch {
    return null
  }
  return null
}

/**
 * Resolve the running @retiregolden/mcp and @retiregolden/engine versions.
 * Never throws — any resolution failure degrades to null for that field.
 */
export function getVersions(): { mcpVersion: string | null; engineVersion: string | null } {
  if (cachedVersions) return cachedVersions
  let mcpVersion: string | null = null
  try {
    mcpVersion = (require('../package.json') as { version?: string }).version ?? null
  } catch {
    mcpVersion = null
  }
  const engineVersion = resolveInstalledPackageVersion('@retiregolden/engine')
  cachedVersions = { mcpVersion, engineVersion }
  return cachedVersions
}
