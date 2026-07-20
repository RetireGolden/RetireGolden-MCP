# Connect your AI client

Copy-paste setup for the public **stdio** path (`npx -y @retiregolden/mcp`) across
common MCP clients. No build, no account, no API key — the client launches the
server as a local subprocess and talks to it over stdin/stdout.

RetireGolden MCP is **educational / decision-support only** — not tax, legal, or
financial advice. See [DISCLAIMER.md](../DISCLAIMER.md).

> Every client below runs the **same** command:
> `npx -y @retiregolden/mcp` (or the installed `retiregolden-mcp` bin). The only
> thing that differs is where each client keeps its config file and how it
> handles the agent skill.

## About the skill

The agent skill ([`skills/retiregolden/SKILL.md`](../skills/retiregolden/SKILL.md),
MIT) tells the client *how* to drive the tools (typed `build_plan` first, prefer
`batch_evaluate` for search, always surface caveats). It ships inside the npm
tarball, so after any install it lives at:

```
node_modules/@retiregolden/mcp/skills/retiregolden/SKILL.md
```

Only Claude clients have a native skill format. For Cursor and Codex, translate
the same guidance into that client's rules/instructions file (templates below).

---

## 1. Claude Desktop

### MCP server

Edit `claude_desktop_config.json` and add the server under `mcpServers`:

```json
{
  "mcpServers": {
    "retiregolden": {
      "command": "npx",
      "args": ["-y", "@retiregolden/mcp"]
    }
  }
}
```

Where the file lives:

| OS      | Path |
|---------|------|
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| macOS   | `~/Library/Application Support/Claude/claude_desktop_config.json` |

Create the file if it does not exist. Fully quit and relaunch Claude Desktop
after editing — it reads the config on startup.

### Skill

Two ways to make the skill available:

- **claude.ai (Settings → Capabilities → Skills):** upload the shipped
  `node_modules/@retiregolden/mcp/skills/retiregolden/SKILL.md` (drop the whole
  `retiregolden/` folder if the uploader accepts a directory). Skills synced here
  are available to Claude Desktop signed into the same account.
- **Claude Code project skills:** copy the folder into a project's
  `.claude/skills/` (see the Claude Code section below).

---

## 2. Claude Code

### MCP server

Either add a project-scoped `.mcp.json` at the repo root:

```json
{
  "mcpServers": {
    "retiregolden": {
      "command": "npx",
      "args": ["-y", "@retiregolden/mcp"]
    }
  }
}
```

…or register it from the CLI:

```bash
claude mcp add retiregolden -- npx -y @retiregolden/mcp
```

Add `-s user` to `claude mcp add` to make it available across all your projects
instead of just the current one.

### Skill

Drop the skill folder into `.claude/skills/` so the directory looks like:

```
.claude/skills/retiregolden/SKILL.md
```

Copy it straight from the installed package, e.g.:

```bash
mkdir -p .claude/skills/retiregolden
cp node_modules/@retiregolden/mcp/skills/retiregolden/SKILL.md .claude/skills/retiregolden/
```

Use `~/.claude/skills/` instead of a project path to install it for every
project. Claude Code auto-discovers `SKILL.md` from the frontmatter `name` /
`description`.

---

## 3. Cursor

### MCP server

Cursor reads MCP config from `mcp.json`:

- Project scope: `.cursor/mcp.json` at the repo root.
- Global scope: `~/.cursor/mcp.json`.

Same server block:

```json
{
  "mcpServers": {
    "retiregolden": {
      "command": "npx",
      "args": ["-y", "@retiregolden/mcp"]
    }
  }
}
```

### Skill → Cursor rules

Cursor has no skill format, so translate the skill into a **project rule**.
Create `.cursor/rules/retiregolden.mdc`. Rather than duplicating all of
`SKILL.md`, point the model at the tool surface and the non-negotiable units /
framing rules:

```md
---
description: RetireGolden retirement-math MCP tools
alwaysApply: false
---

# RetireGolden calculator tools

When the user asks for US retirement-planning math (projections, Roth
conversions, claiming ages, IRMAA, RMDs), use the `retiregolden` MCP tools.

Rules:
- Educational / decision-support only. Do not prescribe securities trades or
  present results as financial advice.
- Start with `build_plan` (typed `household` + `policy`, or full plan JSON),
  then `run_projection` / `batch_evaluate`.
- For combinatorial search (claim ages, conversion brackets, ordering), use
  `batch_evaluate` with a modest policy list — not thousands of single runs.
- Call `explain_modeled_result` when summarizing so assumptions, caveats, and
  limitations stay visible.
- Money is nominal USD; ages in years. Read returned `caveats` — some engine
  knobs are best-effort.
```

Reload Cursor after adding the server; the rule applies as soon as the file is
saved.

---

## 4. Codex (OpenAI)

Codex (the CLI/desktop coding agent under the ChatGPT brand) stores MCP servers
in `config.toml` and takes project instructions from `AGENTS.md`.

### MCP server

Add to `~/.codex/config.toml` (per-project `.codex/config.toml` also works for
trusted projects). Each server is one `[mcp_servers.<name>]` table; the presence
of `command` selects the stdio transport:

```toml
[mcp_servers.retiregolden]
command = "npx"
args = ["-y", "@retiregolden/mcp"]
```

Or add it from the CLI (everything after `--` is the server command):

```bash
codex mcp add retiregolden -- npx -y @retiregolden/mcp
```

List what's configured with `codex mcp list`.

> Note the snake_case `mcp_servers` table (not `mcpServers`) — Codex silently
> ignores the block if the key is spelled the JSON way.

### Skill → AGENTS.md

Codex has no skill format either; put the same guidance in an `AGENTS.md` at your
repo root (Codex reads it automatically, walking from the project root down to
the working directory):

```md
# RetireGolden calculator tools

For US retirement-planning math (projections, Roth conversions, claiming ages,
IRMAA, RMDs), use the `retiregolden` MCP tools.

- Educational / decision-support only — never present results as financial
  advice or prescribe securities trades.
- Start with `build_plan` (typed `household` + `policy`, or full plan JSON),
  then `run_projection` / `batch_evaluate`.
- Use `batch_evaluate` (modest policy list) for combinatorial search instead of
  many single projections.
- Call `explain_modeled_result` when summarizing so caveats stay visible.
- Money is nominal USD; ages in years. Honor returned `caveats`.
```

---

## What leaves your machine

The MCP path is **local**: your AI client spawns `@retiregolden/mcp` as a child
process and exchanges JSON-RPC over stdio. Plan inputs, projections, and session
state live **in memory** in that subprocess — nothing is written to disk or sent
to a RetireGolden server by this package.

What the client sends to its *own* model provider is a separate matter: your
prompts, and the tool inputs/outputs the client chooses to include in the model
context, are governed by that AI client's data practices (Anthropic for Claude
Desktop / Claude Code, Anthropic via Cursor, OpenAI for Codex, etc.). Review the
client's privacy terms if the numbers you type are sensitive.
