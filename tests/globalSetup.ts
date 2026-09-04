/**
 * Vitest global setup: build `dist/` once, before any test file loads.
 *
 * Three suites run against the built output (`tests/dualEra.test.ts`,
 * `tests/protocolBaseline.test.ts`, `tests/packedArtifact.test.ts`). CI runs
 * `pnpm test` BEFORE `pnpm run build`, so `dist/` does not exist when vitest
 * starts; when each of those files spawned its own `pnpm run build` from
 * `beforeAll`, vitest's parallel file execution put two `tsc` emits on the same
 * directory at the same time. That race produced a real, rerun-green CI failure
 * on `test (windows-latest, 24)` (PR #64).
 *
 * Global setup runs once, in the main vitest process, and every test file waits
 * for it — so the build happens exactly once per vitest run and the suites only
 * assert freshness (`ensureBuild()`). An already-current `dist/` is not
 * rebuilt. Concurrency across separate vitest invocations is out of scope; see
 * the note in tests/helpers/build.ts.
 */

import { buildIfStale } from './helpers/build.js'

export default async function setup(): Promise<void> {
  await buildIfStale()
}
