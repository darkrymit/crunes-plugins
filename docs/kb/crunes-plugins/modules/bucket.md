---
type: module
title: bucket
description: Global isolate registry for folders anywhere on disk (default root ~/.bucket), searchable by id, label, or README.
tags: [plugin, global, bucket]
resource: plugins/bucket/
---

# bucket

Indexes folders anywhere on disk in `~/.bucket/buckets.json` (with `~/.bucket` as the default root for `new`) and extracts README titles and summaries on read.

## Usage

Installed globally with `-g` (`crunes plugin install crunes-plugins@bucket -g`).

- `crunes -p run bucket new <id> [--in <dir>] [--git] [-l <label>]` — create and register a bucket
- `crunes -p run bucket register <dir> [--id <id>] [-l <label>]` — index an existing folder
- `crunes -p run bucket where <name>` / `find <words...>` / `list` — resolve or search buckets
- `crunes -p run bucket info <id>` / `rename <id> <newId>` / `deregister <id>` / `delete <id> --yes`
- `crunes -p run bucket label <add|rm|list>` — manage bucket labels

## Permissions

Declares `fs.read`, `fs.write` (on `**` and `~/.bucket/buckets.json`), `fs.mkdir:**`, `fs.rm:**`, `fs.glob:**::*`, and `shell.run:git *`.
