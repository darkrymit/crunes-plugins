// Secret redaction for `qdev config list` / `config get`.
//
// getAllValues returns every resolved config value in plaintext (Quarkus Dev UI does no
// masking), so `config` output can carry live API keys, DB passwords, tokens etc. into the
// agent transcript. This module decides, per entry, whether a value must be hidden.
//
// Decision ladder (first match wins):
//   1. empty/null value            -> show   (nothing to leak)
//   2. key in redactKeys (project) -> REDACT (denylist -- highest; catches secrets under
//                                             innocuous key names, e.g. `*.origin-header`)
//   3. key in allowKeys (project)  -> show   (operator vouches it is safe)
//   4. key matches STRONG_KEY_RE   -> REDACT (secret by name, even if value looks innocuous)
//   5. numeric / boolean value     -> show   (counts, TTLs, flags -- not secrets)
//   6. value matches a secret shape-> REDACT (known prefix, embedded URL creds, opaque token)
//   7. otherwise                   -> show
//
// Thresholds were tuned against a real ~2000-key Quarkus config (see audit-secrets.mjs): a bare
// `token` key rule and dotted opaque values (Java FQCNs, Kafka topics, model names) were the main
// false positives and were removed; embedded-URL-credential detection was added.
//
// Built-in patterns are generic (project-independent). Per-project tuning via crunes vars:
//   qdev.config.redactKeys / allowKeys       -- force redact / force show, by key pattern
//   qdev.config.lockReveal      (default ON)  -- global plaintext lock (list + get)
//   qdev.config.list.lockReveal (default OFF) -- extra list-only plaintext lock (master: global)
//   qdev.config.list.lockValues (default ON)  -- list-only bulk-values lock (`list --values`)
// Locks default to locked (reveal ON, values ON): a developer opts INTO exposure locally
// (config.local.json), and while a lock is on the flag it gates is never registered -- the
// agent can't see or attempt it.

// Secret KEY-NAME fragments (matched case-insensitively, anywhere in the key). One per line so
// this stays readable and easy to extend -- prefer adding a line over growing a dense regex.
// `[-_.]?` lets a word-break be a dash, underscore, dot or nothing (api-key / api_key / apikey).
const SECRET_KEY_PATTERNS = [
  'password', 'passwd', 'pwd',
  'secret',
  'credential',
  'webhook',
  'signing',
  '\\bsalt\\b',                 // guarded: don't match "default", "asphalt"
  'dsn',
  'connection[-_.]?string',
  'api[-_.]?key',
  'access[-_.]?key',
  'private[-_.]?key',
  'client[-_.]?secret',
  // credential tokens only -- NOT `max-tokens`, `token-price`, `token-state-manager`:
  'access[-_.]?token', 'auth[-_.]?token', 'bearer[-_.]?token', 'refresh[-_.]?token', 'session[-_.]?token',
]
const STRONG_KEY_RE = new RegExp(SECRET_KEY_PATTERNS.join('|'), 'i')

// Secret VALUE prefixes: a value starting with any of these is a key/token whatever the key name.
const SECRET_VALUE_PREFIXES = [
  'sk-', 'sk_',                 // OpenAI / Stripe style keys
  'AIza',                       // Google API key
  'ghp_', 'gho_',               // GitHub tokens
  'xoxb-', 'xoxa-', 'xoxp-',    // Slack tokens
  'eyJ',                        // JWT (base64 of '{"')
  '-----BEGIN',                 // PEM private key block
]
const hasSecretPrefix = s => SECRET_VALUE_PREFIXES.some(p => s.startsWith(p))

// Credentials embedded in a URL: scheme://user:pass@host (covers jdbc / amqp / redis / ... URLs).
const URL_CRED_RE = /:\/\/[^/\s:@]+:[^/\s:@]+@/
// Opaque token: long, NO dots (dots => FQCN / dotted config id, not a secret), high entropy.
const OPAQUE_RE = /^[A-Za-z0-9+/=_~-]{24,}$/

function shannonEntropy(s) {
  const freq = {}
  for (const ch of s) freq[ch] = (freq[ch] ?? 0) + 1
  let e = 0
  for (const c of Object.values(freq)) { const p = c / s.length; e -= p * Math.log2(p) }
  return e
}

function isNumericOrBool(v) {
  const s = String(v).trim()
  if (s === '') return false
  if (/^(true|false)$/i.test(s)) return true
  return /^-?\d+(\.\d+)?$/.test(s)
}

function looksLikeSecretValue(v) {
  const s = String(v)
  if (hasSecretPrefix(s)) return true
  if (URL_CRED_RE.test(s)) return true
  // long, opaque and high-entropy -> almost certainly a key/token/hash rather than prose
  if (OPAQUE_RE.test(s) && shannonEntropy(s) >= 4.0) return true
  return false
}

function compileList(patterns) {
  return (patterns ?? []).map(p => {
    try { return new RegExp(p, 'i') }
    catch { const lit = String(p).toLowerCase(); return { test: s => s.toLowerCase().includes(lit) } }
  })
}

function anyMatch(res, s) { return res.some(re => re.test(s)) }

// Returns a reason tag string if the value must be redacted, or null to show it.
export function redactReason(key, value, { allowRes, redactRes }) {
  if (value == null || String(value) === '') return null
  if (anyMatch(redactRes, key)) return 'denylist'
  if (anyMatch(allowRes, key)) return null
  if (STRONG_KEY_RE.test(key)) return 'strong-key'
  if (isNumericOrBool(value)) return null
  if (looksLikeSecretValue(value)) return 'value-shape'
  return null
}

// Whether a key name alone marks it secret (ignores the value). Used by the audit helper to
// find secrets hiding under innocuous key names (which this returns null for).
export function keyMatchesSecretName(key) {
  return STRONG_KEY_RE.test(key) ? 'strong-key' : null
}

// The placeholder rendered in place of a secret value. Self-describing so the reader knows
// it is a redaction (not the real value) and why, without leaking any of the value.
export function marker(reason) { return `<redacted: ${reason}>` }

function boolVar(vars, key, dflt = false) {
  const v = vars.read(key, dflt)
  return v === true || v === 'true'
}

// Whether plaintext reveal is hard-blocked for a command (scope 'list' or 'get'). Two locks,
// most-restrictive-wins with the GLOBAL lock as master:
//   qdev.config.lockReveal       (global,    default ON)  -- governs both list and get
//   qdev.config.list.lockReveal  (list-only, default OFF) -- can only ADD restriction to list
// So `list --reveal` needs BOTH unlocked; `get --reveal` needs only the global unlocked. Global
// ON => everything locked regardless of the list flag; "get-only reveal" = global OFF + list ON.
// A developer unlocks by setting these to false in their gitignored config.local.json.
export function revealLocked(vars, scope) {
  if (boolVar(vars, 'qdev.config.lockReveal', true)) return true
  if (scope === 'list' && boolVar(vars, 'qdev.config.list.lockReveal', false)) return true
  return false
}

// Whether bulk value listing is hard-blocked (`config list --values`). List-only. Default ON.
export function valuesLocked(vars) {
  return boolVar(vars, 'qdev.config.list.lockValues', true)
}

// Whether values may be shown in plaintext for a command: only when that command's reveal is
// unlocked AND --reveal was explicitly passed. Locked => always redacted, no flag to override.
export function resolveReveal(vars, args, scope) {
  if (revealLocked(vars, scope)) return false
  return !!args.reveal
}

// Builds a redactor bound to this project's allow/redact lists.
export function buildRedactor(vars) {
  const allowRes = compileList(vars.read('qdev.config.allowKeys', []))
  const redactRes = compileList(vars.read('qdev.config.redactKeys', []))
  return { reason: (key, value) => redactReason(key, value, { allowRes, redactRes }) }
}
