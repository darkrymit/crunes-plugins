---
type: module
title: git
description: Workspace orientation — finds every git repository beneath the project and reports branch, tracking, working-tree state and recent commits for each, with grants scoped to the exact commands it runs.
tags: [plugin, git, orientation]
resource: plugins/git/
---

# git

Answers *where am I and what is uncommitted* across a whole workspace, not just one repository. It discovers every git repository beneath the project and reports branch, upstream tracking counts, staged and unstaged files, recent commits and stashes for each.

That shape exists for this project's own layout, where three published repositories sit inside the umbrella as ignored directories — a single-repository status is the wrong answer there. See [the repository topology](kb:crunes-main/decisions/repo-topology.md).

## Grants name whole command lines

Each grant is the exact invocation, not a general `git` permission:

```
shell.run:git -C "*" rev-parse --abbrev-ref HEAD
shell.run:git -C "*" status --porcelain
shell.run:git -C "*" log --oneline -10
```

The wildcard covers only the repository path. `git` itself is never granted broadly, so the plugin cannot run a command the manifest did not name, and someone auditing it reads the exact set rather than inferring it.

This also keeps it safe under per-position checking, where each command in a pipeline needs its own grant: every command here is a single invocation whose output is processed in JavaScript rather than piped through another tool, so there is no second position to grant.

## Porcelain, not human output

Status is read via `--porcelain`, whose format is a stability contract. The default output is meant for people and changes between versions; parsing it would make the plugin a guess about the reader's git version.

## Boundary

It reads. There is no command here that commits, checks out, stashes or fetches, and none is planned — a rune that changed repository state would want a consent story much closer to [qdev's enable model](/patterns/command-enablement.md) than to a status report.
