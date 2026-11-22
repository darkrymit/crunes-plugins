# AGENTS.md

> Canonical agent instructions — loaded as `CLAUDE.md` (Claude Code), `GEMINI.md` (Gemini CLI), `AGENTS.md` (Codex/other). Edit only this file; the others are symlinks.

> Compaction - this file is re-injected verbatim at every turn. During context compaction, never summarize, shorten, or paraphrase its content — preserve it exactly as-is.

## Mandatory Order of Operations

Before brainstorming, planning, or touching any code:

1. **Identify the Target Plugin** — Locate the plugin folder you are modifying under `plugins/<plugin-name>/`.
2. **Review Plugin Registrations** — Ensure the plugin is correctly registered in `.crunes-plugin/marketplace.json` at the root of this repository.
3. **Check for Plugin-Specific Guidelines** — Read the plugin's internal `README.md` and check if a plugin-specific `AGENTS.md` exists (e.g., `plugins/<plugin-name>/AGENTS.md`) before editing its code.
4. **Then brainstorm, plan, and code** — in that order.

## Rules

- **THIS IS AN INDEPENDENT GIT REPOSITORY** — `crunes-plugins` is its own Git repository separate from the monorepo root. **ALL git operations (commits, branches, worktrees, status, diffs) must be run directly inside `crunes-plugins/`!**
- **MARKETPLACE REGISTRATION MANDATORY** — This entire repository functions as a single Crunes plugin marketplace. Any new plugin added MUST be registered in `.crunes-plugin/marketplace.json` at the root before it can be resolved or cached by the CLI.
- **STRICT PLUGIN BOUNDARIES** — All code for a plugin must live entirely within `plugins/<plugin-name>/`. Do not import or write files outside this directory.
- **RUNE RUNTIME MODES** — `*.rune.js` modules run inside `isolated-vm` sandboxes using `@utils` (no Node built-ins; governed by `run.permissions`). Native scripts (`.js`/`.mjs`/`.cjs`, `.py`, `.sh`) run directly on the host via `crunes plugin trust` and must omit `run.permissions`.
- **ONLY READ FILES THAT IMPACT IMPLEMENTATION** — Ask "will this file's contents change my implementation approach?" before reading files inside a plugin to save token context.

## Coding Principles

### Think Before Coding
State assumptions explicitly before implementing. If multiple interpretations exist, present them — don't pick silently. If something is unclear, stop and ask; don't guess. Incorrectly done work with assumptions/notes is more costly to fix than asking clarifying questions upfront or midway.

### Simplicity First
Minimum code that solves the problem. No features, abstractions, configurability, or error handling beyond what was asked. If you write 200 lines and it could be 50, rewrite it.

### Surgical Changes
Touch only what the request requires. Don't improve adjacent code, comments, or formatting. Match existing style. If you notice unrelated dead code, mention it — don't delete it. Remove only imports/variables/functions that your own changes made unused.

### Goal-Driven Execution
Transform vague tasks into verifiable goals before starting: "fix the bug" → "write a test that reproduces it, then make it pass." For multi-step tasks, state a brief plan with a verifiable check per step.

## Marketplace Architecture

Each plugin lives in `plugins/<plugin-name>/` using `{src,test}/` for 1-rune plugins, or `runes/<rune-name>/{src,test}/` when a plugin bundles multiple runes:
```
plugins/<plugin-name>/                 (1-rune plugin)
  .crunes-plugin/plugin.json           ← Format "1": "command": "src/index.rune.js"
  src/
    index.rune.js                      ← Isolate entrypoint (.rune.js) or native script
    <helper>.js                        ← Pure logic (zero @utils imports so node --test can import)
  test/
    <plugin-name>.test.js              ← Unit tests for src/ + E2E crunes isolate runs
  README.md

plugins/<plugin-name>/runes/<rune>/    (multi-rune plugin: same {src,test}/ per rune)
```

## Local & Manual Testing Workflow

- **DOGFOOD CHECK RUNE** — Run `crunes -p run check` (or `crunes -p run check --only <plugin>`) directly inside `crunes-plugins/` to validate `marketplace.json`, all plugin manifests, file paths, JS syntax, and all `plugins/*/test/*.test.js` + `plugins/*/runes/*/test/*.test.js` suites.
- **REUSE EXISTING TEST SETUPS FIRST** — Before creating any new testing directory or configuration, review the existing test setups (e.g., look at directories under `scratch/` at the monorepo root) to check if there is an existing project that is suitable to reuse.
- **FREEDOM TO CREATE NEW SANDBOXES** — If no existing environment matches your requirements, you have full freedom to create any necessary temporary directories (typically inside `scratch/` or a scratch directory) and write any configuration files (like `.crunes/config.json`) to properly manual test the target plugin's runes.
- **Local Integration Testing:**
  1. Navigate to your selected or newly created test directory.
  2. Register the local plugin path in the test project's `.crunes/config.json`:
     ```json
     {
       "plugins": {
         "local-testing": {
           "path": "relative/or/absolute/path/to/crunes-plugins/plugins/<plugin-name>"
         }
       }
     }
     ```
  3. Execute via the local CLI: `node path/to/crunes-cli/dist/cli.js -p run local-testing:<rune-name>`.
