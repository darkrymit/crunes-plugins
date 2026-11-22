---
type: module
title: secret
description: Global masked config reader for .env, .ini, .properties, .conf, and .json files that scrubs secret values and inline URL credentials.
tags: [plugin, global, secrets]
resource: plugins/secret/
---

# secret

Reads configuration and `.env` files while masking sensitive keys and embedded `scheme://user:password@host` URL credentials so configuration shape can be inspected without leaking secrets into transcripts.

## Usage

Installed globally with `-g` (`crunes plugin install crunes-plugins@secret -g`), so it runs in any directory.

- `crunes -p run secret read <file>` — print the file with secret values and URL credentials masked
- `-k, --key <name>` — output only the named key
- `--keys <a,b,c>` — output only the comma-separated keys

## Permissions

Declares `fs.read:.` and `fs.read:**`.
