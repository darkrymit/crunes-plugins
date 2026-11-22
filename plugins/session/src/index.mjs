#!/usr/bin/env node
import {
  listSessions,
  parseSession,
  formatDigestMarkdown,
  formatInspectMarkdown,
} from './session.mjs'

function fmtAge(mtimeMs) {
  const diffSec = Math.max(0, Math.floor((Date.now() - mtimeMs) / 1000))
  if (diffSec < 60) return `${diffSec}s ago`
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDays = Math.floor(diffHr / 24)
  return `${diffDays}d ago`
}

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function printHelp() {
  process.stdout.write(
    [
      'Usage: crunes -p run session <command> [options]',
      '',
      'Commands:',
      '  list [query]              List recent Claude Code and Antigravity sessions',
      '  digest [id]               Render a session transcript as a Markdown spine (alias: read)',
      '  inspect <id> <steps...>   Inspect step details and outputs (alias: step)',
      '',
      'Options:',
      '  -p, --project <name>      Filter by project or workspace name',
      '  -a, --all                 Show sessions across all projects',
      '  --harness <name>          Filter by harness (claude | agy)',
      '  --subagents               Include child subagent sessions in list',
      '  -n, --limit <number>      Max sessions to return (default: 15)',
      '  -f, --format <level>      Detail level: compact | standard | extended | full',
      '  -t, --tail <turns>        Only include the last N turns in digest',
      '  -h, --help                Show help',
      '',
    ].join('\n')
  )
}

function parseCliArgs(argv) {
  const positionals = []
  const opts = {}
  const valueFlags = new Set(['-p', '--project', '--harness', '-n', '--limit', '-f', '--format', '-t', '--tail'])

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help') {
      opts.help = true
    } else if (arg === '-a' || arg === '--all') {
      opts.all = true
    } else if (arg === '--subagents') {
      opts.subagents = true
    } else if (valueFlags.has(arg)) {
      const val = argv[++i]
      if (val === undefined) throw new Error(`missing value for ${arg}`)
      if (arg === '-p' || arg === '--project') opts.project = val
      else if (arg === '--harness') opts.harness = val
      else if (arg === '-n' || arg === '--limit') opts.limit = val
      else if (arg === '-f' || arg === '--format') opts.format = val
      else if (arg === '-t' || arg === '--tail') opts.tail = val
    } else if (arg.startsWith('--') && arg.includes('=')) {
      const idx = arg.indexOf('=')
      const k = arg.slice(0, idx)
      const val = arg.slice(idx + 1)
      if (k === '--project') opts.project = val
      else if (k === '--harness') opts.harness = val
      else if (k === '--limit') opts.limit = val
      else if (k === '--format') opts.format = val
      else if (k === '--tail') opts.tail = val
      else throw new Error(`unknown option: ${k}`)
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option: ${arg}`)
    } else {
      positionals.push(arg)
    }
  }

  return { positionals, opts }
}

function main() {
  const { positionals, opts } = parseCliArgs(process.argv.slice(2))
  const [cmd, ...rest] = positionals

  if (opts.help || !cmd) {
    printHelp()
    return
  }

  if (cmd === 'list') {
    const query = rest.join(' ') || undefined
    const items = listSessions({
      cwd: process.cwd(),
      project: opts.project,
      all: Boolean(opts.all),
      harness: opts.harness,
      subagents: Boolean(opts.subagents),
      query,
      limit: Number(opts.limit) || 15,
    })

    if (items.length === 0) {
      process.stdout.write('No matching sessions found.\n')
      return
    }

    for (const s of items) {
      const hBadge = s.harness === 'claude' ? 'claude' : 'agy   '
      const projBadge = (s.project || 'unknown').padEnd(14).slice(0, 14)
      const ageBadge = fmtAge(s.mtimeMs).padStart(7)
      const sizeBadge = fmtSize(s.size).padStart(7)
      const subPrefix = s.isSubagent ? `[sub<-${(s.parentId || '').slice(0, 6)}] ` : ''
      const title = s.title || s.firstPrompt || ''
      process.stdout.write(`${s.shortId}  ${hBadge}  ${projBadge}  ${ageBadge}  ${sizeBadge}  ${subPrefix}${title}\n`)
    }
    return
  }

  if (cmd === 'digest' || cmd === 'read') {
    const id = rest[0] || 'latest'
    const parsed = parseSession(id, {
      cwd: process.cwd(),
      project: opts.project,
      harness: opts.harness,
    })
    process.stdout.write(formatDigestMarkdown(parsed, { format: opts.format || 'compact', tail: opts.tail }) + '\n')
    return
  }

  if (cmd === 'inspect' || cmd === 'step') {
    const [id, ...steps] = rest
    if (!id || steps.length === 0) {
      throw new Error('inspect requires <id> and <steps...>. Example: crunes -p run session inspect <id> 1..4')
    }
    const parsed = parseSession(id, {
      cwd: process.cwd(),
      harness: opts.harness,
    })
    process.stdout.write(formatInspectMarkdown(parsed, steps.join(','), { format: opts.format || 'extended' }) + '\n')
    return
  }

  throw new Error(`unknown command: ${cmd}. Run with --help for usage.`)
}

try {
  main()
} catch (err) {
  process.stderr.write(`${err.message}\n`)
  process.exit(1)
}
