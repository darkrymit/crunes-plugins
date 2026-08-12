// qdev -- Quarkus Dev UI toolbox
//
// Two transports:
//
// Dev MCP HTTP  POST /q/dev-mcp
//   Response: result.content[0].text (JSON string, parse it)
//   Discovery: POST /q/dev-mcp {"method":"tools/list","params":{}} on running server
//   Source: methods with @JsonRpcDescription in *JsonRPCService.java files
//           under extensions/devui/runtime/ and extensions/*/runtime-dev/
//
// WebSocket  ws://.../q/dev-ui/json-rpc-ws
//   Response: msg.result.object (one level deeper than standard JSON-RPC)
//   Use when: method absent from tools/list -- either no @JsonRpcDescription
//             (callable but not MCP-exposed) or Multi<> return (stream-only)
//   Param passing: matched by Java parameter name; missing/undefined params
//                  cause "wrong number of arguments" -- always guard before sending
//   Source: scratch/quarkus-main/extensions/*/runtime-dev/**/*JsonRPCService.java
//
// Transport decision for new subcommands:
//   1. Check tools/list on running server -- if present, use Dev MCP HTTP.
//   2. If absent, read the *JsonRPCService source:
//      - no @JsonRpcDescription + non-Multi return = WebSocket callable
//      - Multi<> return = subscription, WebSocket stream only, not wrappable

import { vars, rune, section } from '@utils'
import { resolveBaseUrl } from './transport.js'
import { revealLocked, valuesLocked } from './redact.js'
import { runLogs } from './logs.js'
import { runHealth } from './health.js'
import { runLogLevel } from './log-level.js'
import { runConfigList, runConfigGet, runConfigSet, runConfigProperties } from './config.js'
import { runFlywayStatus, runFlywayMigrate } from './flyway.js'
import { runCacheList, runCacheKeys, runCacheClear } from './cache.js'
import { runSchedulerList, runSchedulerRun, runSchedulerPause, runSchedulerResume, runSchedulerPauseAll, runSchedulerResumeAll } from './scheduler.js'
import { runEndpoints } from './endpoints.js'
import { runOpenapi } from './openapi.js'
import { runDevServices } from './dev-services.js'
import { runGraphqlSchema, runGraphqlQuery } from './graphql.js'
import { runDbSources, runDbTables, runDbSql } from './db.js'
import { runWorkspaceList, runWorkspaceGet, runWorkspaceSet } from './workspace.js'
import { runServerStart, runServerStop, runServerRestart, runServerStatus, runServerReload } from './server.js'

// Domain shorthands expand to all their subcommand keys
const DOMAIN_KEYS = {
  logs: ['logs'],
  health: ['health'],
  config: ['config.list', 'config.get', 'config.set', 'config.properties'],
  'log-level': ['log-level'],
  flyway: ['flyway.status', 'flyway.migrate'],
  cache: ['cache.list', 'cache.keys', 'cache.clear'],
  scheduler: ['scheduler.list', 'scheduler.run', 'scheduler.pause', 'scheduler.resume', 'scheduler.pause-all', 'scheduler.resume-all'],
  endpoints: ['endpoints'],
  graphql: ['graphql.schema', 'graphql.query'],
  openapi: ['openapi'],
  'dev-services': ['dev-services'],
  db: ['db.sources', 'db.tables', 'db.sql'],
  workspace: ['workspace.list', 'workspace.get', 'workspace.set'],
  server: ['server.start', 'server.stop', 'server.restart', 'server.status', 'server.reload'],
}

function resolveEnabledKeys(enable) {
  const keys = new Set()
  for (const entry of enable) {
    if (DOMAIN_KEYS[entry]) {
      for (const k of DOMAIN_KEYS[entry]) keys.add(k)
    } else {
      keys.add(entry)
    }
  }
  return keys
}

export function args(b) {
  const enable = resolveEnabledKeys(vars.read('qdev.enable', []))

  if (enable.has('logs')) {
    b.command('logs', 'Log snapshot with optional filters', c => {
      c.option('--level <level>', 'Min level: DEBUG|INFO|WARN|ERROR')
       .option('--errors', 'Shorthand for --level ERROR')
       .option('--warnings', 'Shorthand for --level WARN')
       .option('--from <name>', 'Filter by logger name substring or regex (matches loggerName / loggerNameShort)')
       .option('--grep <pattern>', 'Keep entries whose message matches substring or regex, case-insensitive')
       .option('--exclude <pattern>', 'Drop entries whose message matches substring or regex, case-insensitive')
       .option('--since <time>', 'Only entries at or after this time today, e.g. 20:34 or 20:34:00')
       .option('--tail <n>', 'Show last N entries (default: 100); equivalent to --size')
       .option('--head <n>', 'Show first N entries instead of last N')
       .option('--size <n>', 'Alias for --tail')
       .option('--no-stacktrace', 'Hide stacktraces — shows message line only; re-run without flag for full trace')
    })
  }
  if (enable.has('health')) b.command('health', 'Show health check status')
  if (enable.has('config.list') || enable.has('config.get') || enable.has('config.set') || enable.has('config.properties')) {
    b.command('config', 'Runtime config commands', c => {
      if (enable.has('config.list')) {
        c.command('list', 'List config keys (keys only by default)', s => {
          s.option('--grep <pattern>', 'Key or value substring or regex filter')
          // --values / --reveal are registered only when unlocked, so a locked setup never
          // shows the agent a flag (or hint) it cannot use.
          if (!valuesLocked(vars)) {
            s.option('--values', 'Include values (secret-looking ones redacted)')
            s.option('--redact', 'With --values: force ALL values to redacted markers, even non-secrets')
            if (!revealLocked(vars, 'list')) s.option('--reveal', 'Include values in plaintext (no redaction)')
          }
        })
      }
      if (enable.has('config.get')) {
        c.command('get', 'Look up a single config key (with fuzzy suggestions if not found)', s => {
          s.positional('<key>', 'Exact config key name')
           .option('--redact', 'Force the value to a redacted marker, even if not secret')
          if (!revealLocked(vars, 'get')) s.option('--reveal', 'Show secret-looking values in plaintext')
        })
      }
      if (enable.has('config.set')) {
        c.command('set', 'Write a live config value', s => {
          s.positional('<key>', 'Config key')
           .positional('<value>', 'New value')
           .option('--profile <profile>', 'Config profile (optional)')
           .option('--target <target>', 'Target config file (optional)')
        })
      }
      if (enable.has('config.properties')) c.command('properties', 'Show raw application.properties')
    })
  }
  if (enable.has('log-level')) {
    b.command('log-level', 'Change runtime log level', c => {
      c.positional('<logger>', 'Logger name (e.g. io.quarkus.chat)')
       .positional('<level>', 'Level: DEBUG|INFO|WARN|ERROR|OFF|INHERIT')
    })
  }
  if (enable.has('flyway.status') || enable.has('flyway.migrate')) {
    b.command('flyway', 'Flyway commands', c => {
      if (enable.has('flyway.status')) c.command('status', 'Show datasources and migration state')
      if (enable.has('flyway.migrate')) c.command('migrate', 'Run pending migrations')
    })
  }
  if (enable.has('cache.list') || enable.has('cache.keys') || enable.has('cache.clear')) {
    b.command('cache', 'Cache commands', c => {
      if (enable.has('cache.list')) c.command('list', 'List caches and sizes')
      if (enable.has('cache.keys')) {
        c.command('keys', 'List keys in a cache', s => s.positional('<name>', 'Cache name'))
      }
      if (enable.has('cache.clear')) {
        c.command('clear', 'Clear a named cache', s => s.positional('<name>', 'Cache name'))
      }
    })
  }
  const hasSched = ['scheduler.list','scheduler.run','scheduler.pause','scheduler.resume','scheduler.pause-all','scheduler.resume-all'].some(k => enable.has(k))
  if (hasSched) {
    b.command('scheduler', 'Scheduler commands', c => {
      if (enable.has('scheduler.list')) c.command('list', 'List scheduled jobs')
      if (enable.has('scheduler.run')) {
        c.command('run', 'Trigger a scheduled job', s => s.positional('<job>', 'Job identity'))
      }
      if (enable.has('scheduler.pause')) {
        c.command('pause', 'Pause a scheduled job', s => s.positional('<job>', 'Job identity'))
      }
      if (enable.has('scheduler.resume')) {
        c.command('resume', 'Resume a scheduled job', s => s.positional('<job>', 'Job identity'))
      }
      if (enable.has('scheduler.pause-all')) c.command('pause-all', 'Pause all scheduled jobs')
      if (enable.has('scheduler.resume-all')) c.command('resume-all', 'Resume all scheduled jobs')
    })
  }
  if (enable.has('endpoints')) b.command('endpoints', 'List all REST/WS endpoints')
  if (enable.has('graphql.schema') || enable.has('graphql.query')) {
    b.command('graphql', 'GraphQL commands', c => {
      if (enable.has('graphql.schema')) c.command('schema', 'Dump GraphQL SDL schema')
      if (enable.has('graphql.query')) {
        c.command('query', 'Execute a GraphQL query', s => {
          s.positional('<query>', 'GraphQL query string')
           .option('--url <endpoint>', 'Override GraphQL endpoint URL')
        })
      }
    })
  }
  if (enable.has('openapi')) b.command('openapi', 'OpenAPI commands', c => c.command('schema', 'Dump OpenAPI JSON'))
  if (enable.has('dev-services')) b.command('dev-services', 'List running dev services')
  if (enable.has('db.sources') || enable.has('db.tables') || enable.has('db.sql')) {
    b.command('db', 'Datasource commands', c => {
      if (enable.has('db.sources')) c.command('sources', 'List datasources')
      if (enable.has('db.tables')) {
        c.command('tables', 'List tables', s => s.option('--datasource <name>', 'Datasource name'))
      }
      if (enable.has('db.sql')) {
        c.command('sql', 'Execute SQL query', s => {
          s.positional('<query>', 'SQL query string')
           .option('--datasource <name>', 'Datasource name')
           .option('--page <n>', 'Page number (default: 0)')
           .option('--size <n>', 'Page size (default: 20)')
        })
      }
    })
  }
  if (enable.has('workspace.list') || enable.has('workspace.get') || enable.has('workspace.set')) {
    b.command('workspace', 'Workspace file commands', c => {
      if (enable.has('workspace.list')) c.command('list', 'List workspace items')
      if (enable.has('workspace.get')) {
        c.command('get', 'Get workspace item content', s => s.positional('<path>', 'Item path'))
      }
      if (enable.has('workspace.set')) {
        c.command('set', 'Save workspace item content', s => {
          s.positional('<path>', 'Item path').positional('<content>', 'New content')
        })
      }
    })
  }
  if (['server.start','server.stop','server.restart','server.status','server.reload'].some(k => enable.has(k))) {
    b.command('server', 'Dev server lifecycle commands', c => {
      if (enable.has('server.start')) c.command('start', 'Start the dev server')
      if (enable.has('server.stop')) c.command('stop', 'Stop the managed dev server')
      if (enable.has('server.restart')) c.command('restart', 'Restart the dev server')
      if (enable.has('server.status')) c.command('status', 'Show server status and recent logs')
      if (enable.has('server.reload')) c.command('reload', 'Trigger hot reload via stdin')
    })
  }

  return b
}

function buildKnownCommands(enable) {
  const known = []
  if (enable.has('logs'))               known.push('logs')
  if (enable.has('health'))             known.push('health')
  if (enable.has('log-level'))          known.push('log-level')
  if (enable.has('config.list'))        known.push('config list')
  if (enable.has('config.get'))         known.push('config get')
  if (enable.has('config.set'))         known.push('config set')
  if (enable.has('config.properties'))  known.push('config properties')
  if (enable.has('flyway.status'))      known.push('flyway status')
  if (enable.has('flyway.migrate'))     known.push('flyway migrate')
  if (enable.has('cache.list'))         known.push('cache list')
  if (enable.has('cache.keys'))         known.push('cache keys')
  if (enable.has('cache.clear'))        known.push('cache clear')
  if (enable.has('scheduler.list'))     known.push('scheduler list')
  if (enable.has('scheduler.run'))      known.push('scheduler run')
  if (enable.has('scheduler.pause'))    known.push('scheduler pause')
  if (enable.has('scheduler.resume'))   known.push('scheduler resume')
  if (enable.has('scheduler.pause-all'))  known.push('scheduler pause-all')
  if (enable.has('scheduler.resume-all')) known.push('scheduler resume-all')
  if (enable.has('endpoints'))          known.push('endpoints')
  if (enable.has('openapi'))            known.push('openapi schema')
  if (enable.has('dev-services'))       known.push('dev-services')
  if (enable.has('graphql.schema'))     known.push('graphql schema')
  if (enable.has('graphql.query'))      known.push('graphql query')
  if (enable.has('db.sources'))         known.push('db sources')
  if (enable.has('db.tables'))          known.push('db tables')
  if (enable.has('db.sql'))             known.push('db sql')
  if (enable.has('workspace.list'))     known.push('workspace list')
  if (enable.has('workspace.get'))      known.push('workspace get')
  if (enable.has('workspace.set'))      known.push('workspace set')
  if (enable.has('server.start'))       known.push('server start')
  if (enable.has('server.stop'))        known.push('server stop')
  if (enable.has('server.restart'))     known.push('server restart')
  if (enable.has('server.status'))      known.push('server status')
  if (enable.has('server.reload'))      known.push('server reload')
  return known
}

function fuzzyMatch(input, enable) {
  const known = buildKnownCommands(enable)
  const cmd = input.toLowerCase()
  const cmdTokens = cmd.split(/\s+/).filter(w => w.length > 2)
  const suggestions = known.filter(k => {
    if (k === cmd) return true
    const kTokens = k.split(/\s+/)
    return cmdTokens.some(w => kTokens.some(kt => kt === w || kt.startsWith(w)))
  })
  const hint = suggestions.length > 0
    ? `\n\nDid you mean?\n${suggestions.map(s => `  qdev ${s}`).join('\n')}\n\nRun \`qdev --help\` to see all commands.`
    : `\n\nRun \`qdev --help\` to see all commands.`
  return section.create('qdev-error', { type: 'markdown', content: `**[Unknown command]** \`${input}\`${hint}` })
}

export async function run(args) {
  if(args.help) return rune.helpSection()
  const enable = resolveEnabledKeys(vars.read('qdev.enable', []))

  if (!args.$command && args.$rest.length > 0) {
    return fuzzyMatch(args.$rest.join(' '), enable)
  }

  const baseUrl = resolveBaseUrl()

  try {
    switch (args.$command) {
      case 'logs':                return runLogs(args, baseUrl)
      case 'health':              return runHealth(baseUrl)
      case 'log-level':           return runLogLevel(args, baseUrl)
      case 'config list':         return runConfigList(args, baseUrl)
      case 'config get':          return runConfigGet(args, baseUrl)
      case 'config set':          return runConfigSet(args, baseUrl)
      case 'config properties':   return runConfigProperties(baseUrl)
      case 'flyway status':       return runFlywayStatus(baseUrl)
      case 'flyway migrate':      return runFlywayMigrate(baseUrl)
      case 'cache list':          return runCacheList(baseUrl)
      case 'cache keys':          return runCacheKeys(args, baseUrl)
      case 'cache clear':         return runCacheClear(args, baseUrl)
      case 'scheduler list':      return runSchedulerList(baseUrl)
      case 'scheduler run':       return runSchedulerRun(args, baseUrl)
      case 'scheduler pause':     return runSchedulerPause(args, baseUrl)
      case 'scheduler resume':    return runSchedulerResume(args, baseUrl)
      case 'scheduler pause-all': return runSchedulerPauseAll(baseUrl)
      case 'scheduler resume-all':return runSchedulerResumeAll(baseUrl)
      case 'endpoints':           return runEndpoints(baseUrl)
      case 'openapi schema':      return runOpenapi(baseUrl)
      case 'dev-services':        return runDevServices(baseUrl)
      case 'graphql schema':      return runGraphqlSchema(baseUrl)
      case 'graphql query':       return runGraphqlQuery(args, baseUrl)
      case 'db sources':          return runDbSources(baseUrl)
      case 'db tables':           return runDbTables(args, baseUrl)
      case 'db sql':              return runDbSql(args, baseUrl)
      case 'workspace list':      return runWorkspaceList(baseUrl)
      case 'workspace get':       return runWorkspaceGet(args, baseUrl)
      case 'workspace set':       return runWorkspaceSet(args, baseUrl)
      case 'server start':        return runServerStart(baseUrl)
      case 'server stop':         return runServerStop(baseUrl)
      case 'server restart':      return runServerRestart(baseUrl)
      case 'server status':       return runServerStatus(baseUrl)
      case 'server reload':       return runServerReload(baseUrl)
      default:
        return section.create('qdev-error', { type: 'markdown', content: `**[Error]** Unknown command: "${args.$command}". Run \`qdev --help\` to see all commands.` })
    }
  } catch (err) {
    return section.create('qdev-error', { type: 'markdown', content: `**[Error]** ${err.message}` })
  }
}
