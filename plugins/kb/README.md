# kb

Query knowledge bundles: `list` shows what bundles exist and how they are laid out, `read` returns the text of documents addressed by ref. Bundles are discovered from document frontmatter rather than from configuration, so adding a bundle to a project is a matter of writing an `index.md`, not editing config.

## Install

```bash
crunes -p marketplace add darkrymit/crunes-plugins
crunes -p plugin install crunes-plugins@kb
crunes -p run kb list
```

Out of the box the plugin looks in `docs/kb`. Any other layout needs configuration — see [Configuring roots](#configuring-roots).

## Bundle contract

A bundle root is an `index.md` whose frontmatter carries **`kb_version`**. Its **`kb`** field supplies the bundle id that every ref is built from.

```markdown
---
okf_version: 1
kb_version: 1
kb: core
---
# Core knowledge

The prose before the first ## heading becomes the bundle's summary.
```

kb extends OKF. `kb_version` and `kb` are kb's own fields; `okf_version`, `type`, `title`, `description`, `tags`, and `resource` are OKF's. The OKF fields are read where present and used to enrich output — `resource` in particular names the source file a document is about — but **none of them is required**. A document whose frontmatter is missing or does not parse stays listable and readable; it is simply reported as `(untyped)`.

Only `kb_version` gates discovery. A bundle marked with `okf_version` alone is not a kb bundle and will not be found.

## Commands

### `kb list [--brief]`

One section per bundle: its id, its directory, its title and summary, and a tree of every directory carrying an `index.md`. The indented entries in that tree are exactly the refs `read` accepts, and the trailing number is how many documents sit directly in that directory.

`--brief` drops the titles and summaries, keeping ids, paths, counts, and the tree.

Section names are bundle ids, so a single knowledge base is selected with a section filter rather than a flag:

```bash
crunes -p run kb[-s core] list
```

The filter belongs inside the key's brackets, with the command following as a separate argument.

### `kb read <refs...>`

Prints each named document in full, then every document those documents link to, one hop deep, in brief. A brief is the title, description, and `##` headings — enough to decide whether a full read is worth it. To get a linked document in full, pass it as a ref of its own.

Accepted ref forms:

| Form | Meaning |
|---|---|
| `core/specs/alpha.md` | Bundle id and path — what `list` prints, and the canonical form |
| `kb:core/specs/alpha.md` | The same, in the form documents use to link to each other |
| `core` | A bundle root, or any directory carrying an `index.md` |
| `/specs/alpha.md` | Bundle-absolute; resolves inside the linking document's own bundle |
| `docs/kb/specs/alpha.md` | A plain filesystem path, as pasted from a search tool |

A bundle-absolute ref that matches more than one bundle is reported with the full refs to choose from, ready to paste back:

```
/specs/shared.md — in 2 bundles. Use one of: core/specs/shared.md  extra/specs/shared.md
```

## Configuring roots

The plugin ships one root, `docs/kb`, with grants for exactly that path. Any other layout is configured through the fully-qualified override key:

```json
{
  "runes": {
    "crunes-plugins@kb:kb": {
      "vars": { "roots": ["docs/kb", "engine/docs/kb"] },
      "permissions": {
        "run": {
          "allow": [
            "fs.glob:docs/kb/**/*.md",
            "fs.read:docs/kb/**",
            "fs.glob:engine/docs/kb/**/*.md",
            "fs.read:engine/docs/kb/**"
          ]
        }
      }
    }
  }
}
```

Two rules govern that block, and both bite silently if missed:

**Declaring `allow` replaces the plugin's grants entirely — it does not add to them.** The example above restates `docs/kb` even though the plugin already granted it, because the moment a project declares `allow`, the manifest's list is gone. Every root needs its own `fs.glob:<root>/**/*.md` and `fs.read:<root>/**` pair.

**Grants must be literal patterns.** A grant is matched against the pattern string the rune passes to `fs.glob`, not against the paths it resolves to. This is also why roots are configured rather than discovered: a pattern built at runtime from a directory the rune just found could never have been granted in advance.

A root whose grants are missing does not fail the command. It is reported in `list` output as a named problem, so an incomplete allow list looks like this rather than like silence:

```
! could not search:
  engine/docs/kb/**/*.md — 'fs.glob:engine/docs/kb/**/*.md' is not permitted.
```
