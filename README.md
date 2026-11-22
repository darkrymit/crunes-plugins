# Crunes Plugins

The official first-party plugin marketplace for Crunes.

## Installation

Add this entire repository as a marketplace:

```bash
crunes marketplace add darkrymit/crunes-plugins
```

Install **global tools** once (available in every directory):

```bash
crunes plugin install crunes-plugins@token -g
```

Install **project plugins** inside a specific repository:

```bash
crunes plugin install crunes-plugins@kb
```

## Global Tools (`-g`)

| Plugin | What it does |
|---|---|
| [`token`](plugins/token) | Estimates token counts (OpenAI & Claude) and checks context budgets for files, directories, or piped `stdin`. |
| [`outline`](plugins/outline) | Structural code outline: collapses function and method bodies while preserving signatures, types, and classes. |
| [`secret`](plugins/secret) | Reads `.env`, `.ini`, `.properties`, `.conf`, and `.json` files with secret values and URL credentials masked. |
| [`session`](plugins/session) | Discovers and reads Claude Code and Antigravity session transcripts as compact Markdown (native script, requires `crunes plugin trust`). |

## Project Plugins

| Plugin | What it does |
|---|---|
| [`kb`](plugins/kb) | Queries knowledge bundles: what exists, what is in them, and their text. Reads `docs/kb` out of the box; other layouts are configured through `vars.roots`. |
| [`qdev`](plugins/qdev) | Quarkus Dev UI CLI — logs, health, config, flyway, cache, scheduler, endpoints, graphql, openapi, dev-services and datasources. Read-only by default; mutating commands are opted into through `qdev.enable`. |

Each plugin's README documents its commands, vars, and the exact grants it needs.

## License

MIT — [Tamerlan Hurbanov (DarkRymit)](https://github.com/darkrymit)
