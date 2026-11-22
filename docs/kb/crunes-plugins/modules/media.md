---
type: module
title: media
description: Global isolate pipeline for downloading video media, extracting keyframes, transcribing speech, and packing .mcf archives.
tags: [plugin, global, media]
resource: plugins/media/
---

# media

Prepares video URLs or local files into keyframe timelines (`timeline.md` + `frames/*.jpg`), packs/unpacks `.mcf` zip archives via `@utils` `archive`, and lists creator channels.

## Usage

Installed globally with `-g` (`crunes plugin install crunes-plugins@media -g`).

- `crunes -p run media list <profile> [--platform tiktok|youtube]` — list creator videos without downloading
- `crunes -p run media download <source> -o <dir> [--subtitles] [--dry-run]` — download video and metadata
- `crunes -p run media prep <source> -o <dir> [--whisper] [--skip-frames]` — build timeline and extract keyframes
- `crunes -p run media pack <dir> -o <file.mcf>` / `unpack <archive> -o <dir>` — zip/unzip prepared bundles
- `crunes -p run media frames <video> -o <dir> --from <s> --to <s>` — extract dense frame ranges

## Permissions

Declares `fs.read:**`, `fs.write:**`, `fs.glob:**::*`, and `shell.run` for `yt-dlp`, `uvx`, `uv`, `ffmpeg`, `python`, `where.exe`, and `which`.
