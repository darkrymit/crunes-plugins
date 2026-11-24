# Crunes Plugin: session

Discover, inspect, and audit token usage for Claude Code (`~/.claude/projects/`) and Antigravity (`~/.gemini/antigravity/brain/`) session transcripts.

## Usage

```bash
crunes -p run session list
crunes -p run session list --all --sort tokens
crunes -p run session stat latest
crunes -p run session digest latest --format compact --tail 5
crunes -p run session inspect <id> 1..4
```

## Permissions

- **`fs.glob`:** `~/.claude/projects::**/*.jsonl`, `~/.gemini/antigravity/brain::**/transcript.jsonl`
- **`fs.read`:** `~/.claude/projects/**`, `~/.gemini/antigravity/brain/**`, `**`
