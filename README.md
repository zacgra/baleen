# Baleen

Filter your AI agent's code changes before they surface. A whale of a review tool.

Baleen is a VS Code extension that runs Claude Code inside a Docker sandbox and intercepts every file edit for human review. You see a diff preview with approve/deny buttons before any change is applied.

## How it works

1. **Start a session** — `Baleen: Start Session` builds a Docker image (if needed) and launches Claude Code in a container with your project mounted at `/sandbox`.
2. **PreToolUse hook** — A shell hook intercepts `Edit` and `Write` tool calls, writing the proposed change to `.claude-review/pending/` and polling for a response.
3. **Diff preview** — The extension picks up the proposal, constructs before/after content, and opens a VS Code diff editor.
4. **Approve or deny** — Toolbar buttons write a response to `.claude-review/responses/`, unblocking the hook. On deny, any inline comments you added are compiled into structured feedback for Claude.

## Commands

| Command | Description |
|---|---|
| `Baleen: Start Session` | Launch a sandboxed Claude Code session |
| `Baleen: Stop Session` | Kill the container and clean up |
| `Baleen: Review Current File` | Open a HEAD vs working-copy diff for the active file |

## Security notes

### Shared authentication volume

Baleen uses a single Docker named volume (`baleen-auth`) to persist Claude Code credentials across container restarts. This volume is shared across all projects — authenticating once makes credentials available to every Baleen session on your machine. This is intentional for convenience so you don't need to re-authenticate each time you switch projects.

If you need per-project credential isolation, you can modify the volume name in `src/sandbox/docker.ts` (the `-v baleen-auth:/home/baleen/.claude` argument in `buildRunArgs`).

### Container hardening

- The container runs as a non-root user (`baleen`, uid 1000).
- `--security-opt=no-new-privileges` prevents privilege escalation.
- A tmpfs overlay on `$HOME` ensures no host credentials leak into the container.
- The project directory is mounted read-write at `/sandbox`.

## Development

```sh
bun install
bun run compile    # TypeScript → out/
bun run lint       # Biome check
bun run test       # VS Code integration tests
bun run deploy     # Lint, compile, package, and install the extension
```

## Requirements

- VS Code 1.85+
- Docker
