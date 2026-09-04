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
 * This script owns the VALUE of `inputSchemas` and nothing else: every other
 * key keeps the value it was read with. Formatting is not preserved, though —
 * the document is reparsed and rewritten with `JSON.stringify(.., null, 2)`, so
 * hand-collapsed arrays (the arm lists were one-liners) come back expanded. If a
 * regeneration diff touches a key other than `inputSchemas`, it is a
 * re-indentation, not a value change.
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
 * The conversion options, exported so the parity test cannot pass under options
 * that differ from the ones this script writes with.
 *
 * `io: 'input'` is what makes the published block an INPUT contract. Zod's
 * default is output-mode, which closes the top-level object with
 * `additionalProperties: false` — a shape `tools/list` does not send, because
 * `z.object` STRIPS unknown keys rather than rejecting them. Under output mode
 * the published schema was stricter than both the wire and the runtime, so a
 * client validating against it would have rejected calls the server accepts.
 * With `io: 'input'` every one of the 14 blocks is deep-equal to the
 * `inputSchema` the SDK actually advertises, as captured in
 * tests/protocol-baseline/baseline.json and asserted by
 * tests/registry-parity.test.ts. It also keeps the block honest if a future
 * shape gains a `.default()` or a transform, where the two modes really diverge.
 *
 * `unrepresentable: 'any'` is deliberate: a few shapes in the table
 * (`z.unknown()` plan documents, the `PlanFragment` record) intentionally accept
 * anything the engine's own validator is the authority on, and an empty schema
 * is the truthful rendering of that.
 */
export const JSON_SCHEMA_OPTIONS = Object.freeze({
  target: 'draft-2020-12',
  unrepresentable: 'any',
  io: 'input',
})

/**
 * JSON Schema for one tool's arguments.
 *
 * NECESSARY BUT NOT SUFFICIENT — this is the same guarantee `tools/list` gives,
 * and it is worth stating because a client could otherwise read the block as a
 * complete admission test. A call these schemas accept can still be refused at
 * runtime, in three known ways:
 *
 *  1. Cross-field rules live in `ToolEntry.crossFieldValidate`, which JSON Schema
 *     never sees: `build_plan` demands `plan`, or BOTH `household` and `policy`,
 *     and on the typed path a 2-letter `household.state`.
 *  2. Zod refinements JSON Schema cannot express are dropped — the `dobMonthDay`
 *     calendar check, `update_plan`'s `fragmentKey` rule — exactly as they are
 *     dropped from the schema the MCP client sees. The runtime parse still
 *     enforces them.
 *  3. `z.unknown()` fields render as an empty schema that accepts anything; the
 *     engine's own validator is the authority on those documents.
 *
 * Encoding (1) or (2) here would make the published block disagree with the wire
 * schema, which is the one thing this file exists to mirror. The fix for a
 * caller who needs them is the error message, not a tighter contract file.
 */
export function toolInputSchema(entry) {
  return z.toJSONSchema(z.object(entry.inputShape), JSON_SCHEMA_OPTIONS)
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
