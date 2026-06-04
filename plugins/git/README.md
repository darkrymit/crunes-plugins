# Crunes Plugin: git

Git context runes — collapse common multi-step git queries into single structured outputs for Agentic Coders.

## Usage

```bash
crunes run git:status
```

*Note: In a monorepo, `git:status` will automatically discover all sub-repositories and output a separate section for each.*

## Permissions Architecture

This plugin runs in the V8 sandbox and explicitly scopes permissions to guarantee it cannot modify or accidentally leak non-git data:

- **`fs.glob`:** Strictly limited to `**/.git` discovery.
- **`shell.run`:** Strictly limited to non-destructive read-only commands (`git status`, `git log`, `git rev-parse`, `git rev-list`, and `git stash list`). It cannot run `git commit`, `git checkout`, etc.
