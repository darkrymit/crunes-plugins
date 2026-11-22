---
type: module
title: session
description: Global native-script reader for Claude Code and Antigravity session transcripts with list, digest, and inspect lenses.
tags: [plugin, global, session, native]
resource: plugins/session/
---

# session

Converts raw Claude Code (`~/.claude/projects/`) and Antigravity (`~/.gemini/antigravity/brain/`) JSONL transcripts into three progressive Markdown lenses (`list`, `digest`, `inspect`).

## Usage

Installed globally with `-g` and trusted (`crunes plugin install crunes-plugins@session -g` + `crunes plugin trust crunes-plugins@session`), so it can read transcript directories under `$HOME`.

- `crunes -p run session list [--all] [--harness claude|agy]` — discover matching sessions
- `crunes -p run session digest [id] [--format compact|standard|extended|full] [--tail N]` — render a session spine
- `crunes -p run session inspect <id> <steps...>` — drill down into specific step outputs

## Runtime

Runs as a native Node script (`src/index.mjs`) with no `run.permissions` block.
