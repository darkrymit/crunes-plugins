# Crunes Plugin: media

Download, transcribe, pack/unpack (`.mcf` zip archives), and prepare video media and keyframe timelines.

## Usage

```bash
crunes -p run media list https://www.youtube.com/@handle
crunes -p run media download https://example.com/video --out ./media-out --dry-run
crunes -p run media prep ./video.mp4 --out ./media-out
crunes -p run media pack ./media-out -o ./media.mcf
crunes -p run media unpack ./media.mcf -o ./restored
crunes -p run media frames ./video.mp4 --out ./frames --from 10 --to 20
```

## Permissions

- **`fs.read` / `fs.write` / `fs.glob`:** `**` (read source videos, write timelines/frames, zip/unzip `.mcf` archives)
- **`shell.run`:** `yt-dlp *`, `uvx *`, `uv *`, `ffmpeg *`, `python *`, `where.exe *`, `which *`
