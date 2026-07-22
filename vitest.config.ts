import { defineConfig } from 'vitest/config'

/**
 * Discovery is pinned to this repo's own `tests/` directory.
 *
 * Git worktrees created under `.claude/worktrees/` carry their own checkout of
 * `tests/`, and Vitest's default `**` include runs those stale copies too — they
 * fail against current pins and bury real failures in noise. CI never sees them
 * (it clones fresh), so the only effect is to make a local `npm test` untrustworthy,
 * which is worse than useless: it invites working around `npm test` with a bare
 * `vitest run`, and `npm test` here is `tsc -p tsconfig.json && vitest run` — the
 * workaround silently skips the typecheck that CI enforces.
 *
 * The explicit `.claude/**` exclude holds even if `include` is ever widened.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '.claude/**'],
  },
})
