---
type: module
title: qdev
description: Quarkus Dev UI access over HTTP and a JSON-RPC websocket, observation-only until a project opts into named commands, with five controls governing what resolved configuration may reveal.
tags: [plugin, quarkus, redaction]
resource: plugins/qdev/
---

# qdev

Reaches a running Quarkus application's Dev UI: logs, health, configuration, endpoints, dev-services, OpenAPI and GraphQL schemas, Flyway status, cache and scheduler listings, datasources.

It talks to the app over HTTP and a JSON-RPC websocket, and can manage the dev server itself as a [job](kb:crunes-cli-main/modules/job.md).

## Observation by default

Everything that changes state is off until named in `qdev.enable` and paired with its grant — the full rule is in [read-only by default](/patterns/command-enablement.md). Disabled by default: config writes, log-level changes, Flyway migrations, cache clears, scheduler mutations, arbitrary SQL, workspace writes, and all of `server.*`.

`server.reload` is the one command whose grant is easy to get wrong: it writes to the running process's stdin, so it needs `shell.job.write`, which `shell.job.read` does not imply.

## Configuration can leak, so redaction is a first-class concern

`qdev config list` and `qdev config get` read **resolved** runtime configuration. Quarkus does no masking, so those values can include live API keys, database passwords and tokens — which would otherwise land verbatim in an agent's transcript and stay there.

Five vars govern this, and they exist because the default behaviour of the underlying endpoint is unsafe for this consumer in a way it is not for a browser:

| Var | Effect |
|---|---|
| `qdev.config.redactKeys` | patterns always redacted, however innocuous the name |
| `qdev.config.allowKeys` | patterns always shown, overriding name-based detection |
| `qdev.config.lockReveal` | blocks `--reveal` on both `list` and `get` |

Name-based detection handles the obvious cases; `redactKeys` exists for the secret whose name gives nothing away, and `allowKeys` for the false positive that matters. `lockReveal` defaults to on, so the escape hatch is itself something a project must open.

## Boundary

It observes and drives a *development* server. It is not an operations tool and holds no notion of an environment beyond the base URL it is pointed at — pointing it at something that is not a local dev instance is possible and is not defended against.
