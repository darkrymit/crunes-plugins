# Crunes Plugin: source

Check whether registered outside sources (`tiktok-channel`, `youtube-channel`, `git-repo`, `site`, `file`) moved since last recorded.

## Usage

```bash
crunes -p run source check sources.json
crunes -p run source record sources.json --id my-repo
crunes -p run source check sources.json --json
```

## Permissions

- **`fs.read` / `fs.write` / `fs.glob`:** `**` (read/update sources JSON and hash local files)
- **`shell.run`:** `git *`, `yt-dlp *`, `uvx *`, `uv *`, `where.exe *`, `which *`
