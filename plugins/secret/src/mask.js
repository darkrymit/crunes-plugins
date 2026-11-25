const SENSITIVE_KEY =
  /(secret|token|password|passwd|pwd|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth|signature|salt|session|oauth|webhook|cookie|dsn|(?:^|[_.-])key$)/i

// Requires a digit, so that prose and identifiers with the same prefix stay readable.
const TOKEN_SHAPE =
  /(?<![A-Za-z0-9])(?:sk[-_]|rk_|pk_live_|gh[pousr]_|github_pat_|glpat-|xox[a-z]-|AIza|AKIA|tvly-|fc-|whsec_|wsec_|SG\.|eyJ)(?=[\w.+/=-]*\d)[\w.+/=-]{12,}/g

const KEY_BLOCK_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY/
const KEY_BLOCK_END = /-----END [A-Z0-9 ]*PRIVATE KEY/
const COMMENTED_ASSIGNMENT = /^(\s*[#;][#;\s]*(?:export\s+)?)([A-Za-z_][\w.-]*)\s*([=:])(.*)$/

function extname(filename) {
  if (!filename) return ''
  const base = filename.split(/[/\\]/).pop() || ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot).toLowerCase() : ''
}

export function maskValue(value) {
  const text = String(value).trim()
  if (!text) return ''
  if (text.length <= 6) return '••••'
  return `${text.slice(0, 2)}${'•'.repeat(6)}${text.slice(-2)}`
}

/** Scrub `scheme://user:password@host` wherever it appears in a value. */
export function maskUrlCredentials(value) {
  return String(value).replace(
    /([a-z][a-z0-9+.-]*:\/\/)([^:/\s@]+):([^@\s]+)@/gi,
    (_m, scheme, user) => `${scheme}${user}:••••@`
  )
}

/** Mask whatever is recognizably secret in free text, whatever it is called. */
export function maskText(text) {
  const raw = String(text)
  if (KEY_BLOCK_BEGIN.test(raw)) return '••••'
  return maskUrlCredentials(raw).replace(TOKEN_SHAPE, token => maskValue(token))
}

export function maskFor(key, value) {
  return SENSITIVE_KEY.test(key) && !KEY_BLOCK_BEGIN.test(value) ? maskValue(value) : maskText(value)
}

function maskComment(line) {
  const match = COMMENTED_ASSIGNMENT.exec(line)
  if (!match || !SENSITIVE_KEY.test(match[2])) return maskText(line)
  const [, prefix, key, sep, rawVal] = match
  const trimmedVal = rawVal.trim()
  const isQuoted =
    (trimmedVal.startsWith('"') && trimmedVal.endsWith('"')) ||
    (trimmedVal.startsWith("'") && trimmedVal.endsWith("'"))
  // Treat `# Auth: see the wiki` as prose rather than a key=value assignment when `:` has multi-word unquoted text
  if (sep === ':' && !isQuoted && /\s/.test(trimmedVal)) {
    return maskText(line)
  }
  return `${prefix}${key}=${maskFor(key, rawVal)}`
}

export function maskJson(value, key = '') {
  if (Array.isArray(value)) return value.map(v => maskJson(v, key))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = maskJson(v, k)
    return out
  }
  if (typeof value === 'string') return maskFor(key, value)
  return value
}

export function parseWantedKeys(key, keys) {
  if (keys) {
    const list = String(keys)
      .split(',')
      .map(k => k.trim().toLowerCase())
      .filter(Boolean)
    return list.length > 0 ? list : null
  }
  if (key) {
    const k = String(key).trim().toLowerCase()
    return k ? [k] : null
  }
  return null
}

export function maskConfig(content, filename, wanted = null) {
  if (extname(filename) === '.json') {
    let parsedJson
    try {
      parsedJson = JSON.parse(content)
    } catch (err) {
      throw new Error(`that is not valid JSON: ${err.message}`)
    }
    const masked = maskJson(parsedJson)
    const filtered =
      wanted && masked && typeof masked === 'object' && !Array.isArray(masked)
        ? Object.fromEntries(Object.entries(masked).filter(([k]) => wanted.includes(k.toLowerCase())))
        : masked
    return JSON.stringify(filtered, null, 2)
  }

  const lines = []
  let inKeyBlock = false
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()

    if (inKeyBlock) {
      inKeyBlock = !KEY_BLOCK_END.test(line)
      continue
    }
    inKeyBlock = KEY_BLOCK_BEGIN.test(line) && !KEY_BLOCK_END.test(line)

    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';') || trimmed.startsWith('[')) {
      if (!wanted) lines.push(maskComment(line))
      continue
    }

    const match = /^([^=:]+)[=:](.*)$/.exec(line)
    if (!match) {
      if (!wanted) lines.push(maskText(line))
      continue
    }

    const key = match[1].trim()
    if (wanted && !wanted.includes(key.toLowerCase())) continue
    lines.push(`${key}=${maskFor(key, match[2])}`)
  }

  return lines.join('\n')
}
