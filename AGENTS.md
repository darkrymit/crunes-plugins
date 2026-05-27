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
- **SANDBOX COMPATIBILITY REQUIRED** — Rune code inside `plugins/<plugin-name>/runes/` is executed by the Crunes CLI inside isolated-vm sandboxes. It **cannot** access standard Node.js built-in modules directly. All I/O operations must use the standard `utils` API injected by the CLI runtime.
- **ONLY READ FILES THAT IMPACT IMPLEMENTATION** — Ask "will this file's contents change my implementation approach?" before reading files inside a plugin to save token context.

## Coding Principles

### Think Before Coding
State assumptions explicitly before implementing. If multiple interpretations exist, present them — don't pick silently. If something is unclear, stop and ask; don't guess.

### Simplicity First
Minimum code that solves the problem. No features, abstractions, configurability, or error handling beyond what was asked. If you write 200 lines and it could be 50, rewrite it.

### Surgical Changes
Touch only what the request requires. Don't improve adjacent code, comments, or formatting. Match existing style. If you notice unrelated dead code, mention it — don't delete it. Remove only imports/variables/functions that your own changes made unused.

### Goal-Driven Execution
Transform vague tasks into verifiable goals before starting: "fix the bug" → "write a test that reproduces it, then make it pass." For multi-step tasks, state a brief plan with a verifiable check per step.

## Marketplace Architecture

Each plugin is stored in `plugins/<plugin-name>/` and has a structure matching:
```
plugins/<plugin-name>/
  .crunes-plugin/
    config.json          ← Defines plugin runes, permissions, and entry points
  runes/
    <rune-name>.js       ← The sandboxed ESM runnable code
  README.md              ← Plugin documentation and schema details
```

## Local & Manual Testing Workflow

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
  3. Execute via the local CLI: `node path/to/crunes-cli/dist/cli.js -p use local-testing:<rune-name>`.
