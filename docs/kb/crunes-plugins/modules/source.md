---
type: module
title: source
description: Global isolate tracker for checking whether registered channels, git repos, sites, or files moved since recorded.
tags: [plugin, global, source]
resource: plugins/source/
---

# source

Tracks external dependencies (`tiktok-channel`, `youtube-channel`, `git-repo`, `site`, `file`) in a JSON file and reports whether each is `same`, `moved`, `new`, `unstable`, or `error`.

## Usage

Installed globally with `-g` (`crunes plugin install crunes-plugins@source -g`).

- `crunes -p run source check <file> [--id <id>] [--json]` — compare each source against its recorded state
- `crunes -p run source record <file> [--id <id>] [--json]` — update each source's recorded version to now

## Permissions

Declares `fs.read:**`, `fs.write:**`, `fs.glob:**::*`, and `shell.run` for `git`, `yt-dlp`, `uvx`, `uv`, `where.exe`, and `which`.
