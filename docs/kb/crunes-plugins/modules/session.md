---
type: module
title: session
description: Global isolate reader for Claude Code and Antigravity session transcripts with list, digest, and inspect lenses.
tags: [plugin, global, session]
resource: plugins/session/
---

# session

Converts raw Claude Code (`~/.claude/projects/`) and Antigravity desktop, CLI and IDE (`~/.gemini/antigravity{,-cli,-ide}/brain/`) JSONL transcripts into three progressive Markdown lenses (`list`, `digest`, `inspect`).

## Usage

Installed globally with `-g` (`crunes plugin install crunes-plugins@session -g`), so it runs in any directory.

- `crunes -p run session list [--all] [--harness claude|agy]` — discover matching sessions
- `crunes -p run session digest [id] [--format compact|standard|extended|full] [--tail N]` — render a session spine
- `crunes -p run session inspect <id> <steps...>` — drill down into specific step outputs

## Large transcripts

Transcripts can outgrow the sandbox memory limit, so summaries never hold a large one whole. A file under 1 MB is read once, because extra host calls cost more than they save. A larger one reads the first and last lines with `fs.read` ranges (title, project, times) and streams only the records it must count through `fs.readLinesStream` with `contains`, which leaves tool output on the host. Codex needs no head: every record it uses is matched. `list` must scan every uncached file before it can sort, because order follows the transcript's own last timestamp rather than the file's modification time. The summary cache is saved every 100 files so an interrupted first scan resumes.

`digest`, `stat`, `inspect` and `search` stream too. Each tool output is applied to its call as it arrives (status, exit code, error, answer), then a keep rule drops whatever the command does not print: a digest keeps at most the excerpt it shows, `inspect` keeps the requested steps, `search` matches on arrival. A call whose result has already gone by (a repeated row) triggers a second pass over the results. Conversation text is always kept, so memory still grows with the dialogue and with the longest line.

## Permissions

Declares `fs.glob` (`~/.claude/projects::**/*.jsonl`, `~/.gemini/antigravity{,-cli,-ide}/brain::**/transcript.jsonl`, one grant each) and `fs.read` (`~/.claude/projects/**`, `~/.gemini/antigravity{,-cli,-ide}/brain/**`, one grant each, `**`).
