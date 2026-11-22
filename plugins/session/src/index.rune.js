import { fs, rune, section } from '@utils'
import {
  formatDigestMarkdown,
  formatInspectMarkdown,
  listSessions,
  parseSession,
} from './session.js'

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

function createIsolateIo() {
  return {
    exists: p => fs.exists(p),
    stat: async p => {
      try {
        return await fs.stat(p)
      } catch {
        return null
      }
    },
    readText: p => fs.read(p),
    readHeadTail: async p => {
      const headRaw = await fs.read(p, { from: 1, to: 80, throw: false })
      const tailRaw = await fs.read(p, { from: -80, throw: false })
      const split = s => (s ? s.split(/\r?\n/).map(l => l.trim()).filter(Boolean) : [])
      return { headLines: split(headRaw), tailLines: split(tailRaw) }
    },
    glob: (pattern, cwd) => fs.glob(pattern, { cwd, dot: true }),
  }
}

export function args(b) {
  return b
    .option('-h, --help', 'Show help')
    .command('list', 'List recent sessions across Claude Code and Antigravity', c => {
      c.positional('[query]', 'Filter by session id, title, or project')
       .option('-p, --project <name>', 'Filter by project or workspace name')
       .option('-a, --all', 'Show sessions across all projects', false)
       .option('--harness <name>', 'Filter by harness (claude | agy)')
       .option('--subagents', 'Include child subagent sessions', false)
       .option('-n, --limit <number>', 'Maximum sessions to return', '15')
    })
    .command('digest', 'Transform a session transcript into a Markdown spine', c => {
      c.positional('[id]', 'Session ID, path, or latest')
       .option('-f, --format <level>', 'Detail level: compact | standard | extended | full', 'compact')
       .option('-t, --tail <turns>', 'Only include the last N turns')
       .option('-p, --project <name>', 'Project filter when resolving latest')
       .option('--harness <name>', 'Harness filter (claude | agy)')
    })
    .command('read', 'Alias for digest', c => {
      c.positional('[id]', 'Session ID, path, or latest')
       .option('-f, --format <level>', 'Detail level: compact | standard | extended | full', 'compact')
       .option('-t, --tail <turns>', 'Only include the last N turns')
       .option('-p, --project <name>', 'Project filter when resolving latest')
       .option('--harness <name>', 'Harness filter (claude | agy)')
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
  const io = createIsolateIo()
  const cmd = parsed.$command

  if (cmd === 'list') {
    const items = await listSessions({
      io,
      cwd: await fs.resolve('.'),
      project: parsed.project,
      all: Boolean(parsed.all),
      harness: parsed.harness,
      subagents: Boolean(parsed.subagents),
      query: parsed.query,
      limit: Number(parsed.limit) || 15,
    })

    if (items.length === 0) {
      return [section.create('session', { type: 'markdown', content: 'No matching sessions found.', sessions: [] })]
    }

    const lines = items.map(s => {
      const hBadge = s.harness === 'claude' ? 'claude' : 'agy   '
      const projBadge = (s.project || 'unknown').padEnd(14).slice(0, 14)
      const ageBadge = fmtAge(s.mtimeMs).padStart(7)
      const sizeBadge = fmtSize(s.size).padStart(7)
      const subPrefix = s.isSubagent ? `[sub<-${(s.parentId || '').slice(0, 6)}] ` : ''
      const title = s.title || s.firstPrompt || ''
      return `${s.shortId}  ${hBadge}  ${projBadge}  ${ageBadge}  ${sizeBadge}  ${subPrefix}${title}`
    })

    return [section.create('session', { type: 'markdown', content: lines.join('\n'), sessions: items })]
  }

  if (cmd === 'digest' || cmd === 'read') {
    const sessionData = await parseSession(parsed.id || 'latest', {
      io,
      cwd: await fs.resolve('.'),
      project: parsed.project,
      harness: parsed.harness,
    })
    const md = formatDigestMarkdown(sessionData, { format: parsed.format || 'compact', tail: parsed.tail })
    return [section.create('session', { type: 'markdown', content: md })]
  }

  if (cmd === 'inspect' || cmd === 'step') {
    const sessionData = await parseSession(parsed.id, {
      io,
      cwd: await fs.resolve('.'),
      harness: parsed.harness,
    })
    const stepSpec = Array.isArray(parsed.steps) ? parsed.steps.join(',') : String(parsed.steps || '')
    const md = await formatInspectMarkdown(sessionData, stepSpec, { format: parsed.format || 'extended', io })
    return [section.create('session', { type: 'markdown', content: md })]
  }

  if (parsed.help || !cmd) {
    return rune.helpSection()
  }
  throw new Error('use one of: list, digest, read, inspect, step')
}
