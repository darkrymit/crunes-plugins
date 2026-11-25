import { fs, rune, section } from '@utils'
import {
  fmtDuration,
  fmtTok,
  formatDigestMarkdown,
  formatInspectMarkdown,
  formatStatMarkdown,
  keepForDigest,
  keepForInspect,
  listSessions,
  parseSession,
  searchSessions,
} from './session.js'

function fmtAge(ms) {
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (diffSec < 60) return `${diffSec}s ago`
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDays = Math.floor(diffHr / 24)
  return `${diffDays}d ago`
}

export function args(b) {
  return b
    .option('-h, --help', 'Show help')
    .command('list', 'List recent sessions across Claude Code, Antigravity, and Codex', c => {
      c.positional('[query]', 'Filter by session id, title, or project')
       .option('-p, --project <name>', 'Filter by project or workspace name')
       .option('-a, --all', 'Show sessions across all projects', false)
       .option('--harness <name>', 'Filter by harness (claude | agy | codex)')
       .option('--subagents', 'Include child subagent sessions', false)
       .option('-s, --sort <by>', 'Sort by: recent | tokens | duration | size', 'recent')
       .option('-n, --limit <number>', 'Maximum sessions to return', '15')
    })
    .command('search', 'Search session transcripts by text or regex', c => {
      c.positional('<query>', 'Search text or /regex/flags')
       .option('-p, --project <name>', 'Filter by project or workspace name')
       .option('-a, --all', 'Search sessions across all projects', false)
       .option('--harness <name>', 'Filter by harness (claude | agy | codex)')
       .option('--subagents', 'Include child subagent sessions', false)
       .option('-n, --limit <number>', 'Maximum matching hits to return', '20')
    })
    .command('digest', 'Transform a session transcript into a Markdown spine', c => {
      c.positional('[id]', 'Session ID, path, or latest')
       .option('-f, --format <level>', 'Detail level: compact | standard | extended | full', 'compact')
       .option('-t, --tail <turns>', 'Only include the last N turns')
       .option('-p, --project <name>', 'Project filter when resolving latest')
       .option('--harness <name>', 'Harness filter (claude | agy | codex)')
    })
    .command('read', 'Alias for digest', c => {
      c.positional('[id]', 'Session ID, path, or latest')
       .option('-f, --format <level>', 'Detail level: compact | standard | extended | full', 'compact')
       .option('-t, --tail <turns>', 'Only include the last N turns')
       .option('-p, --project <name>', 'Project filter when resolving latest')
       .option('--harness <name>', 'Harness filter (claude | agy | codex)')
    })
    .command('stat', 'Show token, model, tool, and hot-turn usage for a single session', c => {
      c.positional('[id]', 'Session ID, path, or latest')
       .option('-p, --project <name>', 'Project filter when resolving latest')
       .option('--harness <name>', 'Harness filter (claude | agy | codex)')
       .option('--json', 'Include structured usage payload', false)
    })
    .command('inspect', 'Inspect step details and outputs', c => {
      c.positional('<id>', 'Session ID or path')
       .positional('<steps...>', 'Step indices or ranges (e.g. 14..18)')
       .option('-f, --format <level>', 'Detail level: compact | standard | extended | full', 'extended')
       .option('--harness <name>', 'Harness hint when resolving session ID')
    })
    .command('step', 'Alias for inspect', c => {
      c.positional('<id>', 'Session ID or path')
       .positional('<steps...>', 'Step indices or ranges (e.g. 14..18)')
       .option('-f, --format <level>', 'Detail level: compact | standard | extended | full', 'extended')
       .option('--harness <name>', 'Harness hint when resolving session ID')
    })
}

export async function run(parsed) {
  const cmd = parsed.$command

  if (cmd === 'list') {
    const skipped = [];
    const items = await listSessions({
      onSkip: (stub, err) => skipped.push(`${stub.path}: ${err.message}`),
      cwd: await fs.resolve('.'),
      project: parsed.project,
      all: Boolean(parsed.all),
      harness: parsed.harness,
      subagents: Boolean(parsed.subagents),
      sort: parsed.sort || 'recent',
      query: parsed.query,
      limit: Number(parsed.limit) || 15,
    })

    const skipNote = skipped.map(s => `\n(skipped unreadable transcript ${s})`).join('')
    if (items.length === 0) {
      return [section.create('session', { type: 'markdown', content: `No matching sessions found.${skipNote}`, sessions: [] })]
    }

    const lines = items.map(s => {
      const hBadge = s.harness === 'claude' ? 'claude' : (s.harness === 'codex' ? 'codex ' : 'agy   ')
      const projBadge = (s.project || 'unknown').padEnd(14).slice(0, 14)
      const ageBadge = fmtAge(s.endedMs || s.mtimeMs).padStart(7)
      const durBadge = fmtDuration(s.durationMs || 0).padStart(6)
      const tokBadge = fmtTok(s.usage).padEnd(25)
      const subPrefix = s.isSubagent ? `[sub<-${(s.parentId || '').slice(0, 6)}] ` : ''
      const title = s.title || s.firstPrompt || ''
      return `${s.shortId}  ${hBadge}  ${projBadge}  ${ageBadge}  ${durBadge}  ${tokBadge}  ${subPrefix}${title}`
    })

    return [section.create('session', { type: 'markdown', content: lines.join('\n') + skipNote, sessions: items })]
  }

  if (cmd === 'search') {
    const skipped = []
    const hits = await searchSessions(parsed.query, {
      onSkip: (s, err) => skipped.push(`${s.path}: ${err.message}`),
      cwd: await fs.resolve('.'),
      project: parsed.project,
      all: Boolean(parsed.all),
      harness: parsed.harness,
      subagents: Boolean(parsed.subagents),
      limit: Number(parsed.limit) || 20,
    })
    const skipNote = skipped.map(s => `\n(skipped unreadable transcript ${s})`).join('')
    if (hits.length === 0) {
      return [section.create('session', { type: 'markdown', content: `No matching transcript lines found.${skipNote}`, hits: [] })]
    }
    const lines = hits.map(h => {
      const hBadge = h.harness === 'claude' ? 'claude' : (h.harness === 'codex' ? 'codex ' : 'agy   ')
      const loc = h.turnNum ? `U/A#${h.turnNum} step #${h.step}` : `step #${h.step}`
      return `${h.shortId}  ${hBadge}  ${(h.project || 'unknown').padEnd(14).slice(0, 14)}  [${loc} · ${h.kind}]  ${h.snippet}`
    })
    return [section.create('session', { type: 'markdown', content: lines.join('\n') + skipNote, hits })]
  }

  if (cmd === 'digest' || cmd === 'read') {
    const sessionData = await parseSession(parsed.id || 'latest', {
      cwd: await fs.resolve('.'),
      project: parsed.project,
      harness: parsed.harness,
      keep: keepForDigest(parsed.format || 'compact'),
    })
    const md = formatDigestMarkdown(sessionData, { format: parsed.format || 'compact', tail: parsed.tail })
    return [section.create('session', { type: 'markdown', content: md })]
  }

  if (cmd === 'stat') {
    const sessionData = await parseSession(parsed.id || 'latest', {
      cwd: await fs.resolve('.'),
      project: parsed.project,
      harness: parsed.harness,
      keep: keepForDigest('compact'),
    })
    const md = formatStatMarkdown(sessionData)
    const payload = { type: 'markdown', content: md }
    if (parsed.json) {
      payload.stat = {
        id: sessionData.meta.id,
        harness: sessionData.meta.harness,
        project: sessionData.meta.project,
        durationMs: sessionData.meta.durationMs,
        usage: sessionData.meta.usage,
        modelUsage: sessionData.meta.modelUsage,
        toolCounts: sessionData.meta.toolCounts,
        compactions: sessionData.meta.compactions.length,
        thinkingTurns: sessionData.meta.thinkingTurns,
      }
    }
    return [section.create('session', payload)]
  }

  if (cmd === 'inspect' || cmd === 'step') {
    const stepSpec = Array.isArray(parsed.steps) ? parsed.steps.join(',') : String(parsed.steps || '')
    const sessionData = await parseSession(parsed.id, {
      cwd: await fs.resolve('.'),
      harness: parsed.harness,
      keep: keepForInspect(stepSpec),
    })
    const md = await formatInspectMarkdown(sessionData, stepSpec, { format: parsed.format || 'extended' })
    return [section.create('session', { type: 'markdown', content: md })]
  }

  if (parsed.help || !cmd) {
    return rune.helpSection()
  }
  throw new Error('use one of: list, search, digest, read, stat, inspect, step')
}
