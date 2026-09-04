/**
 * Regenerate the `inputSchemas` block of schemas/tools.v1.json from the
 * declarative tool table (src/toolTable.ts).
 *
 * The contract file used to publish tool NAMES and arm groupings only, while
 * calling itself a JSON Schema — so a change to an argument shape moved the
 * wire surface without moving a single reviewable byte. `inputSchemas` closes
 * that gap: one JSON Schema per tool, derived from the same
 * `z.object(inputShape)` both transports parse against, so an argument change
 * shows up in the PR diff. tests/registry-parity.test.ts fails until the
 * committed block matches the live table again.
 *
 * Every other key in the document is preserved byte-for-byte as it was read:
 * this script owns `inputSchemas` and nothing else.
 *
 * Usage: pnpm run contract:generate
 */

import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { z } from 'zod'

export const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
export const CONTRACT_PATH = resolve(PACKAGE_ROOT, 'schemas/tools.v1.json')

/**
 * JSON Schema for one tool's arguments.
 *
 * `unrepresentable: 'any'` is deliberate: a few shapes in the table
 * (`z.unknown()` plan documents, the `PlanFragment` record) intentionally accept
 * anything the engine's own validator is the authority on, and an empty schema
 * is the truthful rendering of that. Zod refinements that JSON Schema cannot
 * express (e.g. the `dobMonthDay` calendar check) are dropped the same way the
 * schema the MCP client sees drops them; the runtime parse still enforces them.
 */
export function toolInputSchema(entry) {
  return z.toJSONSchema(z.object(entry.inputShape), {
    target: 'draft-2020-12',
    unrepresentable: 'any',
  })
}

/** The whole `inputSchemas` block, keyed by tool name in table declaration order. */
export function buildInputSchemas(toolTable) {
  const schemas = {}
  for (const entry of toolTable) schemas[entry.name] = toolInputSchema(entry)
  return schemas
}

/** Serialize the contract document the way the committed file is formatted. */
export function serializeContract(document) {
  return `${JSON.stringify(document, null, 2)}\n`
}

async function main() {
  // Always rebuild before reading dist: generating from a stale build would
  // freeze the pre-change shapes under a post-change source tree. Same rule the
  // protocol-baseline capture follows.
  const { execFile: execFileCallback } = await import('node:child_process')
  const { promisify } = await import('node:util')
  await promisify(execFileCallback)('pnpm', ['run', 'build'], {
    cwd: PACKAGE_ROOT,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
    shell: process.platform === 'win32',
  })

  const { TOOL_TABLE } = await import(
    pathToFileURL(resolve(PACKAGE_ROOT, 'dist/toolTable.js')).href
  )
  const document = JSON.parse(await readFile(CONTRACT_PATH, 'utf8'))
  document.inputSchemas = buildInputSchemas(TOOL_TABLE)
  await writeFile(CONTRACT_PATH, serializeContract(document), 'utf8')
  console.log(`Wrote ${Object.keys(document.inputSchemas).length} input schemas to ${CONTRACT_PATH}`)
}

// Case-insensitive on the file path: Windows drive-letter casing varies by
// invoker, and a mismatch here would silently skip the write instead of failing.
const invokedDirectly =
  process.argv[1] &&
  resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()
if (invokedDirectly) await main()
