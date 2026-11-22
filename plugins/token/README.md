# Crunes Plugin: token

Estimate token counts (OpenAI & Claude) and inspect context weight before reading files.

## Usage

```bash
crunes -p run token count package.json
crunes -p run token count src/ --model claude --warn 4000
cat package.json | crunes -p run token count -
```

## Permissions

- **`fs.read`:** `.`, `**` (read target files and directory stats)
- **`fs.glob`:** `**::*` (expand directory targets, ignoring `node_modules/**` and `.git/**`)
