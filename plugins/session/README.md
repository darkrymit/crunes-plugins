# Crunes Plugin: session

Discover and read Claude Code (`~/.claude/projects/`) and Antigravity (`~/.gemini/antigravity/brain/`) session transcripts as compact Markdown.

Because this plugin reads session transcripts outside the current project directory, it runs as a **native Node script** and requires `crunes plugin trust crunes-plugins@session` (or `crunes plugin install crunes-plugins@session -g` + trust).

## Usage

```bash
crunes -p run session list
crunes -p run session list --all --harness agy
crunes -p run session digest latest --format compact --tail 5
crunes -p run session inspect <id> 1..4
```
