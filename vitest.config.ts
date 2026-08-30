import { defineConfig } from 'vitest/config'

// The release job selects this file explicitly; ordinary discovery must skip
// its pack/install work while preserving that explicit invocation.
const packedArtifactRequested = process.argv.some((argument) =>
  argument.replace(/\\/g, '/').endsWith('tests/packedArtifact.test.ts'),
)

/**
 * Discovery is pinned to this repo's own `tests/` directory.
 *
 * Git worktrees created under `.claude/worktrees/` carry their own checkout of
 * `tests/`, and Vitest's default `**` include runs those stale copies too — they
 * fail against current pins and bury real failures in noise. CI never sees them
 * (it clones fresh), so the only effect is to make a local `pnpm test` untrustworthy,
 * which is worse than useless: it invites working around `pnpm test` with a bare
 * `vitest run`, and `pnpm test` here is
 * `tsc -p tsconfig.json && tsc -p tsconfig.parity.json && vitest run` — the
 * workaround silently skips the typechecks that CI enforces. Note the SECOND
 * program especially: it is the only one that checks
 * tests/planForAiRoundtrip.test.ts, which the root config excludes (see
 * tsconfig.parity.json for why), so dropping it loses that file entirely.
 *
 * The explicit `.claude/**` exclude holds even if `include` is ever widened.
 */
export default defineConfig({
  test: {
    // `@retiregolden/planner-ui` ships TypeScript SOURCE, not built JS (it
    // expects a Vite-class bundler). Vitest externalizes node_modules by
    // default and would hand raw `.ts` to Node's ESM loader, so the parity
    // round-trip needs it pulled through the transform pipeline.
    server: { deps: { inline: ['@retiregolden/planner-ui'] } },
    include: ['tests/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '.claude/**',
      ...(packedArtifactRequested ? [] : ['tests/packedArtifact.test.ts']),
    ],
  },
})
