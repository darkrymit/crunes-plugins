---
type: gotcha
title: Declaring allow replaces the plugin's grants
description: A project that declares allow for a plugin rune discards the manifest's list rather than adding to it, so widening a plugin means restating every grant it already had.
tags: [permissions, plugin, configuration]
---

# Declaring `allow` replaces the plugin's grants

A plugin's manifest declares the permissions its runes need, and the user consents to them at install. The moment a project declares its own `allow` for that rune, **the manifest's list is gone** — replaced, not extended.

```json
{
  "runes": {
    "crunes-plugins@kb:kb": {
      "permissions": { "run": { "allow": ["fs.read:engine/docs/kb/**"] } }
    }
  }
}
```

That config does not add a second root to `kb`. It leaves `kb` with *only* that one grant, and the `docs/kb` root the plugin shipped with stops working.

The correct edit restates everything:

```json
"allow": [
  "fs.glob:docs/kb/**/*.md",
  "fs.read:docs/kb/**",
  "fs.glob:engine/docs/kb/**/*.md",
  "fs.read:engine/docs/kb/**"
]
```

## Why replacement rather than union

Union is the more forgiving default and it cannot express the thing that matters: **a project restricting a plugin.** With additive semantics, a project could only ever widen what a plugin asked for, and narrowing a plugin you half-trust would be impossible.

`deny` is the other half of the rule and behaves the opposite way — it always unions, from every layer, so no layer can weaken a restriction another imposed.

## How it presents

It does not present as a configuration error. The config is valid, the rune runs, and one operation fails with a permission message naming a scope that looks like it should have been covered. The natural reading is *the grant is wrong*; the actual cause is *the other grants are missing*.

Each plugin README prints the complete working `allow` block for exactly this reason — it is meant to be copied whole and edited, never assembled from the one line being added. See [read-only by default](/patterns/command-enablement.md).
