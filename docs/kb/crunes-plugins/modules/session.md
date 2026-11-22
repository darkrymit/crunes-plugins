---
type: module
title: session
description: Global isolate reader for Claude Code and Antigravity session transcripts with list, digest, and inspect lenses.
tags: [plugin, global, session]
resource: plugins/session/
---

# session

Converts raw Claude Code (`~/.claude/projects/`) and Antigravity (`~/.gemini/antigravity/brain/`) JSONL transcripts into three progressive Markdown lenses (`list`, `digest`, `inspect`).

## Usage

Installed globally with `-g` (`crunes plugin install crunes-plugins@session -g`), so it runs in any directory.

- `crunes -p run session list [--all] [--harness claude|agy]` — discover matching sessions
- `crunes -p run session digest [id] [--format compact|standard|extended|full] [--tail N]` — render a session spine
- `crunes -p run session inspect <id> <steps...>` — drill down into specific step outputs

## Permissions

Declares `fs.glob` (`~/.claude/projects::**/*.jsonl`, `~/.gemini/antigravity/brain::**/transcript.jsonl`) and `fs.read` (`~/.claude/projects/**`, `~/.gemini/antigravity/brain/**`, `**`).
