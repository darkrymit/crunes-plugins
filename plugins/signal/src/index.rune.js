import { fs, rune, section, shell } from '@utils'
import {
  cancelSignals,
  formatDuration,
  listSignals,
  newToken,
  parseDuration,
  parseRegistry,
  setSignal,
  shellQuote,
  sleeperCommand,
} from './signal.js'

const REGISTRY_DIR = '~/.signal'
const REGISTRY = '~/.signal/signals.json'

async function withRegistry(fn) {
  const text = (await fs.exists(REGISTRY)) ? await fs.read(REGISTRY) : ''
  const reg = parseRegistry(text)
  const before = JSON.stringify(reg)
  const result = await fn(reg)
  if (JSON.stringify(reg) !== before) {
    await fs.mkdir(REGISTRY_DIR)
    await fs.write(REGISTRY, JSON.stringify(reg, null, 2))
  }
  return result
}

function asArray(val) {
  if (val === undefined || val === null) return []
  return Array.isArray(val) ? val.map(String) : [String(val)]
}

function out(key, content, data = {}) {
  return [section.create(`signal:${key}`, { type: 'markdown', content, ...data })]
}

export function args(b) {
  return b
    .option('-h, --help', 'Show help')
    .command('set', 'Arm or re-arm a named timer that runs a command when it expires', c => {
      c.positional('<name>', 'Signal name (use / to group, e.g. cache/claude/abc/20m)')
       .positional('[cmd...]', 'Command to run on fire, after --')
       .option('--in <duration>', 'Delay before firing (e.g. 40m, 1h30m, 90s)')
    })
    .command('cancel', 'Cancel signals by name or prefix (idempotent)', c => {
      c.positional('[names...]', 'Signal names')
       .option('--prefix <prefix>', 'Cancel every signal whose name starts with prefix')
    })
    .command('list', 'List armed signals', c => {
      c.positional('[prefix]', 'Only names starting with prefix')
       .option('--json', 'Print JSON', false)
    })
}

export async function run(parsed) {
  const stop = typeof rune.guard === 'function' ? rune.guard(parsed) : (parsed.help || !parsed.$command ? rune.helpSection(parsed.$command) : null)
  if (stop) return stop
  const cmd = parsed.$command

  if (cmd === 'set') {
    if (!parsed.in) throw new Error('--in <duration> is required')
    const durationMs = parseDuration(parsed.in)
    const token = newToken()
    const sig = await withRegistry(async reg =>
      setSignal(reg, { name: parsed.name, durationMs, cmd: asArray(parsed.cmd), now: Date.now(), token })
    )
    // Shortcut: a cancelled or re-armed signal's sleeper stays alive until its deadline; upgrade: kill by job id once jobs are reachable across project folders
    const scriptPath = `${CRUNES_PLUGIN_ROOT}/src/sleeper.mjs`.replace(/\\/g, '/')
    await shell.job.start(sleeperCommand({ scriptPath, token, durationMs }))
    return out('set', `armed ${sig.name} for ${formatDuration(durationMs)}`, { signal: sig })
  }

  if (cmd === 'cancel') {
    const cancelled = await withRegistry(async reg =>
      cancelSignals(reg, { names: asArray(parsed.names), prefix: parsed.prefix })
    )
    return out('cancel', `cancelled ${cancelled.length} signal${cancelled.length === 1 ? '' : 's'}`, { cancelled })
  }

  if (cmd === 'list') {
    const rows = await withRegistry(async reg => listSignals(reg, { prefix: parsed.prefix, now: Date.now() }))
    if (parsed.json) return out('list', JSON.stringify(rows, null, 2), { signals: rows })
    const lines = rows.map(s => `${s.name}  fires in ${formatDuration(s.remainingMs)}  ${shellQuote(s.cmd)}`)
    return out('list', lines.join('\n') || 'no armed signals', { signals: rows })
  }

  return rune.helpSection()
}
