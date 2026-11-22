---
type: module
title: token
description: Global token counter (OpenAI & Claude) for files, directories, and piped stdin, with budget warnings via --warn.
tags: [plugin, global, tokens]
resource: plugins/token/
---

# token

Estimates token counts (OpenAI and calibrated ~1.30x Claude), character counts, word counts, and line counts before reading large files or directories, and supports piped `stdin` via `-`.

## Usage

Installed globally with `-g` (`crunes plugin install crunes-plugins@token -g`), so it runs in any directory.

- `crunes -p run token count <files...>` — count one or more files or directories (ignoring `node_modules/**` and `.git/**`)
- `cat file | crunes -p run token count -` — count piped `stdin` via `@utils` `stdin`
- `--model <claude|openai|both>` — filter output to one model family
- `--warn <tokens>` — emit a `!` budget warning when the Claude estimate exceeds the threshold

## Permissions

Declares `fs.read:.`, `fs.read:**`, and `fs.glob:**::*`. Piped `stdin` uses `@utils` `stdin` with no extra grant.
