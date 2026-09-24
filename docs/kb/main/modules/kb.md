---
type: module
title: kb
description: Reads OKF knowledge bundles — what exists, what is in them and their text — from roots that must be configured rather than discovered, because a grant matches the pattern a rune passes and not the paths it resolves.
tags: [plugin, knowledge-base, okf]
resource: plugins/kb/
---

# kb

Queries knowledge bundles: which exist, what is in one, and the text of a document. It is what reads this project's own bundles, including this one.

Ships with a single root, `docs/kb`, and grants for exactly that path.

## Roots are configured, never discovered

The plugin does not scan for bundles. Every root is named in `vars.roots`, and each needs its own pair of grants:

```json
"vars": { "roots": ["docs/kb/main", "engine/docs/kb"] },
"permissions": {
  "run": {
    "allow": [
      "fs.glob:docs/kb/main/**/*.md",
      "fs.read:docs/kb/main/**",
      "fs.glob:engine/docs/kb/**/*.md",
      "fs.read:engine/docs/kb/**"
    ]
  }
}
```

**This is forced by how permissions work, not chosen for simplicity.** A grant is matched against the pattern string the rune passes to `fs.glob` — not against the paths that pattern resolves to. A rune that discovered a directory at runtime and built a glob from it would be passing a pattern nobody could have granted in advance, so the discovery would always be refused.

Configuring roots turns that constraint into an explicit, auditable list. It also means **a bundle nobody registered is invisible rather than broken**: the files are there and the rune does not know about them. Registration and authorship are two separate acts, and forgetting the second is the most common way a new bundle appears to do nothing.

Remember that declaring `allow` [replaces the plugin's grants](/gotchas/allow-replaces.md), so adding a root means restating the ones already there.

## Auditing links

`kb broken` and `kb dead` check the reference graph — links pointing at documents that do not exist, and documents nothing points at.

Extraction ignores fenced code blocks and inline backticks, so a path written as an example inside a snippet is not mistaken for a link. Without that, every document showing a sample path reported a broken reference to a file that was never meant to exist.

**Extensionless references resolve.** A link may name `specs/knowledge-base` or `specs/knowledge-base.md`, which matters because a path pasted from a search tool rarely carries the extension.

## Boundary

It reads markdown and reports on it. It does not enforce the [layout standard](kb:crunes-main/specs/knowledge-base.md) — it will read a bundle whose categories are invented and whose front matter is absent, and report nothing about it. Checking that an index bullet still matches its document's description is a separate concern, done by a rune in the umbrella repository.
