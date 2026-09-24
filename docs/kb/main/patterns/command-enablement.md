---
type: pattern
title: Read-only by default, widened by pairing a var with a grant
description: A plugin exposing commands that mutate state ships them disabled, and enabling one is two edits — naming it in an enable var and adding the grant it needs — so neither edit alone can surprise anyone.
tags: [plugin, permissions, safety]
---

# Read-only by default, widened by pairing a var with a grant

A plugin whose commands only observe can ship them all on. A plugin that can also change something ships those commands **off**, and turning one on takes two deliberate edits in the project's config:

1. **Name the command** in the plugin's enable var.
2. **Add the grant** that command needs to the `allow` list.

Neither edit alone does anything useful, and that is the design rather than an inconvenience.

## Why two edits rather than one

A grant alone is inert: the command is still disabled, so a permission added speculatively — or copied from a README without thinking — grants nothing.

A name alone fails loudly: the command runs and is refused at the call it needed the grant for, naming the missing scope. The failure is at the exact operation, not at startup, so the message points at what to add.

The pair is what makes the capability set of an installed plugin **readable from the project's config** rather than from the plugin's source. Someone auditing a repository can see which mutating commands are live without reading any plugin code.

## The `qdev` case

`qdev` defaults to observation: logs, health, config reads, endpoints, dev-services, schema dumps, migration and cache and scheduler *listings*. Everything that changes state is off — config writes, migrations, cache clears, scheduler mutations, arbitrary SQL, workspace writes, log-level changes, and all of `server.*`.

Starting a dev server is the clearest instance. It needs `server.start` in `qdev.enable` **and** `shell.job.start:mvnw quarkus:dev *` in `allow`. The grant is scoped to the command line it may start, so enabling the feature does not hand the plugin a general process spawner.

`server.reload` then needs one more grant than the rest, because it drives the running process through its stdin: `shell.job.write`, which `shell.job.read` does not cover. Read and write are separate tokens, and pairing them by eye is the mistake this pattern is meant to catch.

## Declaring `allow` replaces, it does not extend

The rule that makes this sharp and also makes it bite: **a project declaring `allow` for a plugin rune discards the plugin's own grants entirely.**

So widening a plugin is never "add the one new line". It is "restate the working set, plus the new line". Omitting the rest does not leave them in place; it removes them, and commands that worked yesterday start failing.

Each plugin's README prints the full working list for this reason, so the block is copied whole rather than assembled from memory. See [restating the grant list](/gotchas/allow-replaces.md).
