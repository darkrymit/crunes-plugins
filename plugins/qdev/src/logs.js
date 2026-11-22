import { section } from '@utils'
import { jsonRpcCall } from './transport.js'

const LEVEL_ORDER = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 }

function normalizeLevel(raw) {
  const up = (raw ?? '').toUpperCase()
  if (up === 'WARNING') return 'WARN'
  if (up === 'SEVERE') return 'ERROR'
  if (up === 'FINE' || up === 'FINER' || up === 'FINEST') return 'DEBUG'
  return up
}

function meetsMinLevel(entryLevel, minLevel) {
  if (!minLevel) return true
  return (LEVEL_ORDER[normalizeLevel(entryLevel)] ?? 0) >= (LEVEL_ORDER[normalizeLevel(minLevel)] ?? 0)
}

function parseTimestamp(raw) {
  if (!raw) return 0
  if (typeof raw === 'number') return raw
  return new Date(raw).getTime()
}

function formatTimestamp(raw) {
  if (!raw) return '??:??:??.???'
  const d = new Date(typeof raw === 'number' ? raw : raw)
  if (isNaN(d.getTime())) return '??:??:??.???'
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}.${String(d.getMilliseconds()).padStart(3,'0')}`
}

function formatEntry(e) {
  const ts = formatTimestamp(e.timestamp)
  const level = normalizeLevel(e.level).padStart(5)
  const logger = (e.loggerNameShort ?? e.loggerName ?? '').slice(0, 20).padEnd(20)
  const line = `${ts} ${level}  ${logger}  ${e.formattedMessage ?? ''}`
  if (e.stacktrace?.length > 0) return line + '\n' + e.stacktrace.map(l => `  ${l}`).join('\n')
  return line
}

function makeMatcher(pattern) {
  try { const re = new RegExp(pattern, 'i'); return s => re.test(s) }
  catch { const p = pattern.toLowerCase(); return s => s.toLowerCase().includes(p) }
}

export async function runLogs(args, baseUrl) {
  const allEntries = await jsonRpcCall(baseUrl, 'devui-logstream_history', {})
  if (!Array.isArray(allEntries)) {
    return section.create('qdev-logs', { type: 'markdown', content: `**[Error]** Unexpected response: ${JSON.stringify(allEntries).slice(0, 200)}` })
  }

  // --errors / --warnings shorthands
  const effectiveLevel = args.errors ? 'ERROR' : args.warnings ? 'WARN' : args.level

  let out = allEntries.filter(e => !['line', 'blank', 'help'].includes(e.type))
  if (effectiveLevel) out = out.filter(e => meetsMinLevel(e.level, effectiveLevel))
  if (args.from) {
    const fn = makeMatcher(args.from)
    out = out.filter(e => fn(e.loggerName ?? '') || fn(e.loggerNameShort ?? ''))
  }
  if (args.grep) {
    const fn = makeMatcher(args.grep)
    out = out.filter(e => fn(e.formattedMessage ?? ''))
  }
  if (args.exclude) {
    const fn = makeMatcher(args.exclude)
    out = out.filter(e => !fn(e.formattedMessage ?? ''))
  }
  if (args.since) {
    const today = new Date(); today.setHours(0,0,0,0)
    const parts = args.since.split(':').map(s => parseInt(s, 10) || 0)
    const sinceMs = today.getTime() + (parts[0]||0)*3600000 + (parts[1]||0)*60000 + (parts[2]||0)*1000
    out = out.filter(e => parseTimestamp(e.timestamp) >= sinceMs)
  }
  const headN = args.head != null ? parseInt(args.head, 10) : null
  const tailN = args.tail != null ? parseInt(args.tail, 10) : null
  const max = headN ?? tailN ?? parseInt(args.size ?? '100', 10)
  const isHead = headN != null
  const truncated = out.length > max
  if (truncated) out = isHead ? out.slice(0, max) : out.slice(out.length - max)

  const activeFilters = []
  if (effectiveLevel) activeFilters.push(`level=${effectiveLevel}`)
  if (args.from) activeFilters.push(`from="${args.from}"`)
  if (args.grep) activeFilters.push(`grep="${args.grep}"`)
  if (args.exclude) activeFilters.push(`exclude="${args.exclude}"`)
  if (args.since) activeFilters.push(`since=${args.since}`)
  if (truncated) activeFilters.push(`size=${max} (${isHead ? 'first' : 'last'} ${max} shown)`)
  if (args['no-stacktrace']) activeFilters.push('stacktraces=hidden')

  const countLine = activeFilters.length > 0
    ? `**${out.length} entries** (filtered from ${allEntries.length} total)`
    : `**${out.length} entries** (of ${allEntries.length} total)`
  const timeLine = out.length > 0
    ? ` · ${formatTimestamp(out[0].timestamp)} - ${formatTimestamp(out[out.length - 1].timestamp)}`
    : ''
  const filterLine = activeFilters.length > 0 ? `\nFilters: ${activeFilters.join(', ')}` : ''
  const summary = `${countLine}${timeLine}${filterLine}`

  if (out.length === 0) {
    return section.create('qdev-logs', { type: 'markdown', content: summary + '\n\nNo entries matched filters.' })
  }

  const noStacktrace = args['no-stacktrace'] != null
  const formatFn = noStacktrace
    ? e => { const ts = formatTimestamp(e.timestamp); const level = normalizeLevel(e.level).padStart(5); const logger = (e.loggerNameShort ?? e.loggerName ?? '').slice(0, 20).padEnd(20); return `${ts} ${level}  ${logger}  ${e.formattedMessage ?? ''}` }
    : formatEntry

  return [
    section.create('qdev-logs-summary', { type: 'markdown', content: summary }),
    section.create('qdev-logs-entries', { type: 'markdown', content: '```\n' + out.map(formatFn).join('\n') + '\n```' }),
  ]
}
