# Crunes Plugin: session

Discover and read Claude Code (`~/.claude/projects/`) and Antigravity (`~/.gemini/antigravity/brain/`) session transcripts as compact Markdown.

## Usage

```bash
crunes -p run session list
crunes -p run session list --all --harness agy
crunes -p run session digest latest --format compact --tail 5
crunes -p run session inspect <id> 1..4
```

## Permissions

- **`fs.glob`:** `~/.claude/projects::**/*.jsonl`, `~/.gemini/antigravity/brain::**/transcript.jsonl`
- **`fs.read`:** `~/.claude/projects/**`, `~/.gemini/antigravity/brain/**`, `**`
