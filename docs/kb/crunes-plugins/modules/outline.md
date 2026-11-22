---
type: module
title: outline
description: Global structural code outliner that collapses function/method bodies for brace languages and Python, with piped stdin support.
tags: [plugin, global, outline]
resource: plugins/outline/
---

# outline

Collapses function and method bodies (`{ /* ... */ }` for brace languages, `...` for Python) while preserving signatures, types, classes, and annotations. Strips comments and imports by default.

## Usage

Installed globally with `-g` (`crunes plugin install crunes-plugins@outline -g`), so it runs in any directory.

- `crunes -p run outline show <files...>` — outline one or more source files
- `cat file.js | crunes -p run outline show -` — outline piped `stdin` via `@utils` `stdin`
- `-c, --comments` — preserve comments and docstrings
- `-i, --imports` — preserve import statements

## Permissions

Declares `fs.read:.` and `fs.read:**`. Piped `stdin` uses `@utils` `stdin` with no extra grant.
