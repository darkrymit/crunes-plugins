# qdev

A CLI over the [Quarkus](https://quarkus.io) Dev UI. It reads logs, health, runtime config, flyway state, caches, scheduled jobs, endpoints, GraphQL and OpenAPI schemas, dev services, and datasources — reaching them over Dev MCP HTTP and the Dev UI websocket.

Every command is a live query against a running application. **The target app must be running in dev mode**, at `http://localhost:8080` by default; point elsewhere with the `qdev.baseUrl` var.

## Install

```bash
crunes -p marketplace add darkrymit/crunes-plugins
crunes -p plugin install crunes-plugins@qdev
crunes -p run qdev --help
```

## Enabling commands

`qdev.enable` decides which commands are registered. A command that is not enabled does not exist: it is absent from `--help` and cannot be invoked. The var accepts a domain shorthand, which expands to all of that domain's keys, or individual keys:

```json
{ "vars": { "qdev.enable": ["logs", "flyway", "config.get"] } }
```

`flyway` expands to `flyway.status` and `flyway.migrate`; `config.get` enables exactly one config subcommand.

The plugin ships this default set:

```
logs, health, config.list, config.get, endpoints, dev-services,
openapi, graphql.schema, flyway.status, cache.list, scheduler.list,
db.sources, db.tables
```

Every one of them only observes. Everything that mutates state, migrates a database, or spawns a process is off until you ask for it: `config.set`, `flyway.migrate`, `cache.clear`, the `scheduler` mutations, `db.sql`, `workspace.set`, `log-level`, and all of `server.*`.

### Widening takes two edits

Enabling a command is not enough — it also needs the permission its work requires, and the plugin deliberately ships none for spawning processes. Both go in the same override entry:

```json
{
  "runes": {
    "crunes-plugins@qdev:qdev": {
      "vars": { "qdev.enable": ["logs", "health", "server.start", "server.stop"] },
      "permissions": {
        "run": {
          "allow": [
            "http.fetch:POST::**/q/dev-mcp",
            "http.fetch:POST::**/graphql",
            "http.fetch:GET::**/q/health",
            "ws.client:ws*://*/q/dev-ui/json-rpc-ws",
            "cache.read:@local-cache::qdev-server",
            "cache.write:@local-cache::qdev-server",
            "shell.job.start:mvnw quarkus:dev *",
            "shell.job.exists",
            "shell.job.kill",
            "shell.job.read"
          ]
        }
      }
    }
  }
}
```

All six of the plugin's own grants are restated there, and that is not redundancy: **declaring `allow` replaces the plugin's list entirely rather than adding to it.** Omit them and the commands that were working stop working.

## Config secrets

`qdev config list` and `qdev config get` read resolved runtime configuration. Quarkus does no masking, so those values can include live API keys, database passwords, and tokens — which would otherwise land in an agent's transcript. Five controls govern this:

| Var | Default | Effect |
|---|---|---|
| `qdev.config.redactKeys` | `[]` | Key patterns always redacted, even under innocuous names |
| `qdev.config.allowKeys` | `[]` | Key patterns always shown, overriding name-based detection |
| `qdev.config.lockReveal` | `true` | Blocks `--reveal` on both `list` and `get` |
| `qdev.config.list.lockReveal` | `false` | Adds a `list`-only `--reveal` block |
| `qdev.config.list.lockValues` | `true` | Blocks `list --values` entirely |

Beyond those, values are judged on a first-match-wins ladder: denylist, then allowlist, then secret-looking key names, then numeric and boolean values (shown), then secret-shaped values — known key prefixes, credentials embedded in a URL, and long high-entropy opaque strings.

One property is worth stating outright: **while a lock is on, the flag it gates is not registered at all.** It does not appear in help and cannot be attempted, so an agent is never shown an exposure it may not have. Unlocking is a deliberate local act, best done in a gitignored `.crunes/config.local.json`.

## Commands

| Command | What it does |
|---|---|
| `qdev logs` | Log snapshot; filter by `--level`, `--from`, `--grep`, `--since`, `--tail`, `--head` |
| `qdev health` | Health check status |
| `qdev config list` | Config keys, keys-only by default |
| `qdev config get <key>` | One config key, with suggestions if not found |
| `qdev endpoints` | All REST and WebSocket endpoints |
| `qdev dev-services` | Running dev services |
| `qdev openapi schema` | OpenAPI JSON |
| `qdev graphql schema` | GraphQL SDL |
| `qdev flyway status` | Datasources and migration state |
| `qdev cache list` | Caches and their sizes |
| `qdev scheduler list` | Scheduled jobs |
| `qdev db sources` | Datasources |
| `qdev db tables` | Tables, optionally `--datasource` |

Disabled by default but available through `qdev.enable`: `config set`, `config properties`, `log-level`, `flyway migrate`, `cache keys`, `cache clear`, `scheduler run/pause/resume/pause-all/resume-all`, `graphql query`, `db sql`, `workspace list/get/set`, and `server start/stop/restart/status/reload`.

Scope help to any command rather than reading the whole index:

```bash
crunes -p run qdev config --help
crunes -p run qdev logs --help
```
