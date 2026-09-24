---
okf_version: 0.2
kb_version: 0.1
kb: crunes-plugins-main
---

# crunes-plugins knowledge base

The first-party marketplace: what each plugin is for, the boundary it keeps, and the rules that govern how a project widens one.

Nothing here executes. Every rune in this repository runs inside the CLI's isolate under grants the installing project consented to — the runtime is [`crunes-cli-main`](kb:crunes-cli-main/index.md), and the model these plugins are written against is [`crunes-main`](kb:crunes-main/index.md).

**Commands, options and vars are not listed here.** Each plugin's README carries its command reference and the complete `allow` block meant to be copied, and `crunes docs rune <key>` renders the live schema from the installed version. This bundle holds what neither of those can say: why a plugin is shaped the way it is, and what goes wrong.

## Patterns

* [Read-only by default, widened by pairing a var with a grant](/patterns/command-enablement.md) - A plugin exposing commands that mutate state ships them disabled, and enabling one is two edits — naming it in an enable var and adding the grant it needs — so neither edit alone can surprise anyone.

## Modules

* [git](/modules/git.md) - Workspace orientation — finds every git repository beneath the project and reports branch, tracking, working-tree state and recent commits for each, with grants scoped to the exact commands it runs.
* [kb](/modules/kb.md) - Reads OKF knowledge bundles — what exists, what is in them and their text — from roots that must be configured rather than discovered, because a grant matches the pattern a rune passes and not the paths it resolves.
* [qdev](/modules/qdev.md) - Quarkus Dev UI access over HTTP and a JSON-RPC websocket, observation-only until a project opts into named commands, with five controls governing what resolved configuration may reveal.

## Gotchas

* [Declaring allow replaces the plugin's grants](/gotchas/allow-replaces.md) - A project that declares allow for a plugin rune discards the manifest's list rather than adding to it, so widening a plugin means restating every grant it already had.
