# Crunes Plugin: session

Discover, search, inspect, and audit token usage for Claude Code (`~/.claude/projects/`), Antigravity desktop, CLI and IDE (`~/.gemini/antigravity{,-cli,-ide}/brain/`), and Codex (`~/.codex/sessions/`) session transcripts.

## Usage

```bash
crunes -p run session list
crunes -p run session list --all --sort tokens
crunes -p run session list --harness codex
crunes -p run session search "Navigation-Typing-Repair" --all
crunes -p run session stat latest
crunes -p run session digest latest --format compact --tail 5
crunes -p run session inspect <id> 1..4
```

## Permissions

- **`fs.glob`:** `~/.claude/projects::**/*.jsonl`, `~/.gemini/antigravity{,-cli,-ide}/brain::**/transcript.jsonl` (one grant each), `~/.codex/sessions::**/*.jsonl`
- **`fs.read`:** `~/.claude/projects/**`, `~/.gemini/antigravity{,-cli,-ide}/brain/**` (one grant each), `~/.codex/sessions/**`, `~/.crunes/cache/**`, `**`
- **`fs.write`:** `~/.crunes/cache/**`
