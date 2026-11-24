// Pure registry logic for the signal plugin: no @utils imports so node --test can load it.
//
// The registry file is the source of truth. Each armed signal carries a random token,
// and its sleeper (src/sleeper.mjs) fires it on wake only if the token still matches. A cancel or re-arm replaces or
// drops the token, so a stale sleeper finds no match and exits without firing. Nothing
// is ever killed: jobs are filed per project folder, so a cancel run from another folder
// could not reach them.

const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }

export function parseDuration(input) {
  const raw = String(input ?? '').trim()
  if (!raw) throw new Error('duration is required (e.g. 40m, 1h30m, 90s)')
  const tokenRe = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/gi
  let total = 0
  let matched = 0
  let match
  while ((match = tokenRe.exec(raw)) !== null) {
    if (match.index !== matched) break
    matched += match[0].length
    total += parseFloat(match[1]) * UNIT_MS[match[2].toLowerCase()]
  }
  if (matched !== raw.length || total <= 0) {
    throw new Error(`invalid duration: "${raw}" (expected e.g. 40m, 1h30m, 90s)`)
  }
  return Math.round(total)
}

export function emptyRegistry() {
  return { format: '1', signals: {} }
}

export function parseRegistry(text) {
  if (!text || !String(text).trim()) return emptyRegistry()
  const data = JSON.parse(text)
  return { format: '1', signals: data && typeof data.signals === 'object' && data.signals ? data.signals : {} }
}

export function newToken(random = Math.random) {
  return random().toString(36).slice(2, 10) + random().toString(36).slice(2, 10)
}

export function setSignal(reg, { name, durationMs, cmd, now, token }) {
  const clean = String(name ?? '').trim()
  if (!clean) throw new Error('signal name is required')
  if (!Array.isArray(cmd) || cmd.length === 0) throw new Error('command is required: set <name> --in <dur> -- <cmd...>')
  const sig = { name: clean, token, durationMs, cmd, createdAt: now, firesAt: now + durationMs }
  reg.signals[clean] = sig
  return sig
}

function select(reg, { names = [], prefix }) {
  const all = Object.values(reg.signals)
  if (prefix) return all.filter(s => s.name.startsWith(prefix))
  return names.map(n => reg.signals[n]).filter(Boolean)
}

export function cancelSignals(reg, { names, prefix }) {
  if ((!names || names.length === 0) && !prefix) throw new Error('provide signal <names...> or --prefix <prefix>')
  const hits = select(reg, { names, prefix })
  for (const s of hits) delete reg.signals[s.name]
  return hits.map(s => s.name)
}

export function listSignals(reg, { prefix, now }) {
  return Object.values(reg.signals)
    .filter(s => !prefix || s.name.startsWith(prefix))
    .map(s => ({ ...s, remainingMs: Math.max(0, s.firesAt - now) }))
    .sort((a, b) => a.firesAt - b.firesAt || a.name.localeCompare(b.name))
}

// Returns the signal to fire and removes it, or null when the token no longer matches
// (cancelled or re-armed since this sleeper started).
export function takeDue(reg, { name, token }) {
  const sig = reg.signals[name]
  if (!sig || sig.token !== token) return null
  delete reg.signals[name]
  return sig
}

// Display only: the stored argv joined with POSIX single quotes for `list`.
export function shellQuote(argv) {
  return argv.map(a => `'${String(a).replace(/'/g, `'\\''`)}'`).join(' ')
}

// Double quotes work in cmd.exe, bash and sh alike; only the script path can hold spaces,
// the token and milliseconds are alphanumeric.
export function sleeperCommand({ scriptPath, token, durationMs }) {
  return `node "${scriptPath}" ${token} ${durationMs}`
}

export function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}
