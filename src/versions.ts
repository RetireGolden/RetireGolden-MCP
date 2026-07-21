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

/**
 * Resolve the running @retiregolden/mcp and @retiregolden/engine versions.
 * Never throws — any resolution failure degrades to null for that field.
 */
export function getVersions(): { mcpVersion: string | null; engineVersion: string | null } {
  if (cachedVersions) return cachedVersions
  const require = createRequire(import.meta.url)
  let mcpVersion: string | null = null
  let engineVersion: string | null = null
  try {
    mcpVersion = (require('../package.json') as { version?: string }).version ?? null
  } catch {
    mcpVersion = null
  }
  try {
    // Engine's exports map exposes ./package.json, so the subpath require normally works.
    engineVersion =
      (require('@retiregolden/engine/package.json') as { version?: string }).version ?? null
  } catch {
    try {
      // Fallback: resolve the package root from a known entry and walk up to package.json.
      let dir = path.dirname(require.resolve('@retiregolden/engine'))
      for (let i = 0; i < 8; i++) {
        const pj = path.join(dir, 'package.json')
        if (fs.existsSync(pj)) {
          const parsed = JSON.parse(fs.readFileSync(pj, 'utf8')) as {
            name?: string
            version?: string
          }
          if (parsed.name === '@retiregolden/engine') {
            engineVersion = parsed.version ?? null
            break
          }
        }
        const parent = path.dirname(dir)
        if (parent === dir) break
        dir = parent
      }
    } catch {
      engineVersion = null
    }
  }
  cachedVersions = { mcpVersion, engineVersion }
  return cachedVersions
}
