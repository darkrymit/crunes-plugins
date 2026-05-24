# AGENTS.md — Crunes Plugins Monorepo

AI-first guide to the official `crunes-plugins` repository.

## Marketplace Registration
This entire repository functions as a single Crunes marketplace.
Any new plugin added to this repository MUST be registered in `.crunes-plugin/marketplace.json` at the root.

## Plugin Boundaries
Plugins live in `plugins/<plugin-name>`.
When modifying a specific plugin (e.g., `git`), **you must read the `AGENTS.md` specific to that plugin** (e.g., `plugins/git/AGENTS.md`) before making any changes. Each plugin has strict internal architectural rules (like precision glob scanning, permission scopes, etc.) that must be respected.
