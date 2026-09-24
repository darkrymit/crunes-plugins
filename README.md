# Crunes Plugins

The official first-party plugin marketplace for Crunes.

## Installation

Add this entire repository as a marketplace to your workspace:

```bash
crunes marketplace add darkrymit/crunes-plugins
```

Once the marketplace is added, you can install any of the bundled plugins, for example:

```bash
crunes plugin install crunes-plugins@git
```

## Plugins

| Plugin | What it does |
|---|---|
| [`git`](plugins/git) | Orientation snapshot — discovers every git repository in the workspace and reports branch, tracking, staged/unstaged files, and recent commits for each. |
| [`kb`](plugins/kb) | Queries knowledge bundles: what exists, what is in them, and their text. Reads `docs/kb` out of the box; other layouts are configured through `vars.roots`. |
| [`qdev`](plugins/qdev) | Quarkus Dev UI CLI — logs, health, config, flyway, cache, scheduler, endpoints, graphql, openapi, dev-services and datasources. Read-only by default; mutating commands are opted into through `qdev.enable`. |

Each plugin's README documents its commands, vars, and the exact grants it needs.

## License

MIT — [Tamerlan Hurbanov (DarkRymit)](https://github.com/darkrymit)

