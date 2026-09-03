# RetireGolden-MCP — standing agent rules

Public AGPL-3.0 Model Context Protocol server (`@retiregolden/mcp`).
Skills under `skills/` are MIT.

## Ground truth

This package is a thin, in-memory adapter over
[`@retiregolden/engine`](https://www.npmjs.com/package/@retiregolden/engine).
Read [README.md](README.md), [CONTRIBUTING.md](CONTRIBUTING.md), and
[DISCLAIMER.md](DISCLAIMER.md) before changing code.

Do not invent tax, statute, or product behavior. Money math stays in the
engine; this repo must not reimplement tax or projection rules.

Do not add private planning, strategy, or competitor material here.

## Invariants

- Educational / decision-support only. Keep that framing in tool text.
- Session state is in memory. No disk persistence, no telemetry, no
  exfiltration of plan data.
- Tool surface lives in `src/toolTable.ts`. Keep `schemas/tools.v1.json`
  in parity. Keep schemas and auth/secrets tight: do not put plan
  arguments on authorization callbacks; do not add credentials to tool
  input.
- The HTTP gateway is an unauthenticated research stub. It stays opt-in
  (`RETIREGOLDEN_HTTP_GATEWAY=1`) and loopback-only.
- No comparisons to, or integrations with, third-party retirement engines.

## Tooling

pnpm + Corepack (`packageManager` in `package.json`). Node 24+; Node 25+
needs `npm install -g corepack` before `corepack enable`.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm test
pnpm run build
```

<!-- rg-shared-agent-rules:start -->
<!-- This block is identical in every RetireGolden org repo (RetireGolden,
     RetireGolden-MCP, RetireGolden-Pro, retiregolden.org). The canonical copy
     is RetireGolden/AGENTS.md. Change it there and re-sync the others; do not
     edit a copy in place. Repo-specific facts, including the repo admin's
     identity and which checks the repo gates, live in the "Repo-specific"
     section after the end marker, never inside the block. -->

## Pull requests, reviews, and merging (shared across the org)

These rules bind every agent working in any RetireGolden repository: Claude
Code, Codex, Cursor, the Grok and OpenRouter review bots, and any other tool.

### Opening PRs

- Ready for review, never drafts. Prefer one PR per repo per phase when the
  changes belong together. Follow-up work for an open PR stays on that PR's
  branch.
- Stacks are allowed when they are explicit: base each child PR on the
  preceding branch, describe the stack and merge order in every PR, and merge
  from the bottom up. After a parent is squash-merged, rebase the child's
  unique commits onto the updated base (retargeting the PR alone is not
  enough), push the rewritten head, and repeat the review and CI gates below.
- Work the queue serially: one PR in automated review at a time. Rebase it
  once onto its own base (`main`, or the parent branch for a stacked child)
  immediately before its review, and hold the next PR (or at least its review
  dispatch) until the one ahead has merged. Parallel coding in separate
  worktrees is fine; parallel review rounds on shared files are not.

### Automated review

- Opening or pushing to a PR runs the OpenRouter code-review workflow
  (`.github/workflows/openrouter-code-review.yml`). Wait for it to finish.
  Fix valid findings, reply to incorrect ones with evidence, resolve only the
  threads you fixed, and push fixes to the same branch. Claude Code sessions
  use the `/needful` skill when it is available; otherwise, and for every
  other tool, follow those same steps by hand.
- A PR is review-clean only when a completed review reports the PR's current
  head SHA and **Verdict:** `clean`. A skipped run, or a verdict carried
  forward from an older SHA, does not count. Every new commit resets this.
- Push-triggered runs verify the latest commit against the existing review
  ledger. A manual `workflow_dispatch` re-reviews the entire PR and generates
  a fresh set of findings. Dispatch when the current head has no completed
  review of its own: no run started after a few minutes, or the run ended
  skipped or errored without posting a verdict (the seed case for a PR whose
  first pass never completed). Never dispatch on top of a completed review of
  the same SHA.

### CI and the `run-ci` label

- Some repos gate expensive jobs behind the exact `run-ci` label (see
  "Repo-specific" below). Where they do, add the label only after the PR is
  review-clean, then confirm the gated jobs actually ran (not skipped) for the
  current head. Never add it early to get CI going.
- Before merge, every check the repo expects for the latest commit must be
  present and successful: gated jobs, ungated jobs, security scans, and
  path-triggered checks when their paths were touched (a path-triggered check
  that never fires is not a missing check). A later fix invalidates prior
  results: review-clean and green CI must both hold for the same head SHA.

### Merging

- Squash-merge is the repository admin's call. The admin, and whether the
  admin has recorded a standing merge grant for this repository, are stated
  in "Repo-specific" below. Where no grant is recorded, every session stops
  at an open, review-clean PR.
- Where a grant is recorded, an agent session may squash-merge only when all
  of the following hold: `gh auth status` shows the session is authenticated
  as that admin account; the head is review-clean; every check the repo
  expects is green for that head; and every review thread is resolved.
- Admin bypass is used only to clear ruleset conditions an agent-authored PR
  cannot satisfy on its own (a required post-push approval by someone other
  than the pusher, and the CLA check where it blocks agent-authored
  commits), and only in a repository whose "Repo-specific" section says
  those conditions exist. It is never used to skip thread resolution, or to
  get past an absent, skipped, pending, or failing review, security, or CI
  check.
- A session authenticated as anyone else stops at an open, review-clean PR.
  It does not merge and does not ask for the bypass.
- No publish, release, or tag unless the user asked for that activation step.

### Conduct

- Never @-mention a guessed GitHub handle in PR comments or replies. On a
  public repo, a guessed handle pings a stranger, and the notification cannot
  be retracted. Do not derive handles from git author names; use only the
  handles named in "Repo-specific".
- Never add `cursoragent` or any other shared tool account to a CLA
  allowlist. Never edit `.github/workflows/cla.yml`: it is a
  `pull_request_target` workflow with write permissions and a PAT. No agent
  session edits it, admin-authenticated or not; the admin changes it by
  hand.
- Delegate mechanical loops (review-fix rounds, rebases, check watches) to
  subagents where the tool supports them. Every rule in this file binds a
  subagent as well. A subagent never merges, dispatches a release or
  production workflow, or edits CI or CLA workflows, even when the parent
  session asks it to; those actions stay with the orchestrating session.
  Verify each subagent's report against live GitHub state (head SHA,
  verdict, unresolved threads, gated jobs) before acting on it.

<!-- rg-shared-agent-rules:end -->

## Repo-specific

- Repository admin: @FlyOverCoderKY.
- Merge grant: standing, recorded by @FlyOverCoderKY on 2026-09-03 (PR
  #62). Neither bypass condition named in the shared Merging section exists
  here, so admin bypass never applies in this repository.
- The required-check list and the thread and approval rules below were
  read from the live ruleset on 2026-09-03 with
  `gh api repos/RetireGolden/RetireGolden-MCP/rules/branches/main`. Re-run
  it when in doubt; the live ruleset wins over this text. The CI matrix and
  CLA trigger facts come from the workflow files, not the ruleset.
- No `run-ci` label here. `ci.yml` runs a three-OS matrix on Node 24
  (`test (ubuntu-latest, 24)`, `test (windows-latest, 24)`,
  `test (macos-latest, 24)`); each leg runs `pnpm test`, `pnpm run build`,
  and `pnpm run test:packed`, and an aggregate `test` job checks the matrix
  result. Required checks on `main`, by exact context: `test` and
  `review / openrouter-first-pass-gate`. Wait for the whole matrix anyway;
  a red leg is a real failure.
- The `CLA` check (from the `CLA Assistant` workflow, `cla.yml`) runs on PR
  `opened`, `synchronize`, and `closed`, not on `reopened`; after reopening
  a PR, push or wait for a fresh run before trusting its status. It is not a
  required check on `main`. Its allowlist already covers `FlyOverCoderKY`
  and `*[bot]`. If it is red because a commit author is not allowlisted,
  that author signs the CLA through the bot's comment; nobody edits the
  allowlist and nobody bypasses the check.
- `main` requires every review thread resolved but has no post-push-approval
  rule, so a review-clean, green PR with resolved threads merges without the
  admin bypass. Resolve the threads; do not reach for the bypass.
