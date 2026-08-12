import { section, vars } from '@utils'
import { devMcpCall, jsonRpcCall } from './transport.js'
import { buildRedactor, resolveReveal, valuesLocked, revealLocked, marker } from './redact.js'

function makeConfigMatcher(pattern) {
  try { const re = new RegExp(pattern, 'i'); return s => re.test(s) }
  catch { const p = pattern.toLowerCase(); return s => s.toLowerCase().includes(p) }
}

export async function runConfigList(args, baseUrl) {
  // getAllValues is a DEV_UI method, disabled-by-default over Dev MCP -- use the WebSocket transport.
  const data = await jsonRpcCall(baseUrl, 'devui-configuration_getAllValues') ?? {}
  const entries = Object.entries(data)
  let filtered = entries
  if (args.grep) {
    const fn = makeConfigMatcher(args.grep)
    filtered = entries.filter(([k, v]) => fn(k) || fn(String(v)))
  }
  if (filtered.length === 0) {
    return section.create('qdev-config', { type: 'markdown', content: args.grep ? `No config entries matched "${args.grep}".` : 'No config entries found.' })
  }

  const valuesUnlocked = !valuesLocked(vars)
  // --redact forces EVERY value to a marker (even non-secrets) and wins over --reveal. It only
  // acts on a shown values table -- it does NOT imply --values (no --values => keys only). Same
  // lock family as --values, so it isn't registered when values are locked (see index.js).
  const forceRedact = !!args.redact
  const reveal = forceRedact ? false : resolveReveal(vars, args, 'list')
  // Values appear ONLY when unlocked AND --values is explicitly passed, so nothing leaks by
  // accident. When values are locked, --values isn't even a registered flag (see index.js).
  const showValues = valuesUnlocked && !!args.values

  if (!showValues) {
    const keys = filtered.map(([k]) => k)
    // Guidance mentions a flag only when that flag actually exists (unlocked). A locked setup
    // says nothing about --values/--reveal -- no hint that a hidden capability could be enabled.
    const valuesHint = valuesUnlocked
      ? (revealLocked(vars, 'list')
          ? ' — `--values` for redacted values'
          : ' — `--values` for redacted values, `--values --reveal` for plaintext')
      : ''
    const note = (valuesUnlocked && args.reveal && !args.values)
      ? `ℹ️ \`--reveal\` only affects redaction — pass \`--values --reveal\` to include plaintext values; showing keys only.\n\n`
      : ''
    const header = args.grep
      ? `Showing ${keys.length} of ${entries.length} keys matching "${args.grep}" (keys only${valuesHint})\n\n`
      : `${keys.length} config keys (keys only${valuesHint})\n\n`
    return section.create('qdev-config', { type: 'markdown', content: note + header + '```\n' + keys.join('\n') + '\n```' })
  }

  const redactor = buildRedactor(vars)
  let redactedCount = 0
  const maxKeyLen = Math.min(60, Math.max(...filtered.map(([k]) => k.length)))
  const lines = filtered.map(([k, v]) => {
    let shown = String(v)
    if (forceRedact) { shown = marker('forced'); redactedCount++ }
    else if (!reveal) {
      const reason = redactor.reason(k, v)
      if (reason) { shown = marker(reason); redactedCount++ }
    }
    return `${k.padEnd(maxKeyLen)}  ${shown}`
  })
  const notice = forceRedact
    ? `🔒 All ${filtered.length} values force-redacted (\`--redact\`).\n\n`
    : redactedCount > 0
      ? (revealLocked(vars, 'list')
          ? `🔒 ${redactedCount} of ${filtered.length} values redacted as secret-looking.\n\n`
          : `🔒 ${redactedCount} of ${filtered.length} values redacted as secret-looking. Re-run with \`--reveal\` to show plaintext.\n\n`)
      : ''
  const header = args.grep ? `Showing ${filtered.length} of ${entries.length} entries matching "${args.grep}"\n\n` : ''
  return section.create('qdev-config', { type: 'markdown', content: notice + header + '```\n' + lines.join('\n') + '\n```' })
}

export async function runConfigGet(args, baseUrl) {
  const key = args.key
  if (!key) return section.create('qdev-config', { type: 'markdown', content: '**[Error]** Usage: qdev config get <key>' })
  // getAllValues is a DEV_UI method, disabled-by-default over Dev MCP -- use the WebSocket transport.
  const data = await jsonRpcCall(baseUrl, 'devui-configuration_getAllValues') ?? {}
  // --redact forces the value to a marker even if it's not secret; it wins over --reveal.
  const forceRedact = !!args.redact
  const reveal = forceRedact ? false : resolveReveal(vars, args, 'get')
  const redactor = buildRedactor(vars)
  const render = k => {
    if (forceRedact) return marker('forced')
    const reason = reveal ? null : redactor.reason(k, data[k])
    return reason ? marker(reason) : `\`${data[k]}\``
  }
  if (key in data) {
    const reason = forceRedact ? 'forced' : (reveal ? null : redactor.reason(key, data[key]))
    const note = reason === 'forced'
      ? `\n(value force-redacted via \`--redact\`)`
      : reason
        ? (revealLocked(vars, 'get')
            ? `\n(secret-looking value hidden)`
            : `\n(secret-looking value hidden — re-run with \`--reveal\` to show)`)
        : ''
    return section.create('qdev-config', { type: 'markdown', content: `\`${key}\` = ${render(key)}${note}` })
  }
  // fuzzy suggestions -- these print other keys' values, so redact them the same way
  const kl = key.toLowerCase()
  const suggestions = Object.keys(data).filter(k => k.toLowerCase().includes(kl)).slice(0, 5)
  const hint = suggestions.length > 0 ? `\n\nDid you mean?\n${suggestions.map(s => `  ${s} = ${render(s)}`).join('\n')}` : ''
  return section.create('qdev-config', { type: 'markdown', content: `**[Not found]** No config key \`${key}\`.${hint}` })
}

export async function runConfigSet(args, baseUrl) {
  const name = args.key
  const value = args.value
  if (!name || value == null) {
    return section.create('qdev-config', { type: 'markdown', content: '**[Error]** Usage: qdev config set <key> <value>' })
  }
  const toolArgs = { name, value }
  if (args.profile) toolArgs.profile = args.profile
  if (args.target) toolArgs.target = args.target
  await devMcpCall(baseUrl, 'devui-configuration_updateProperty', toolArgs)
  return section.create('qdev-config', { type: 'markdown', content: `Config \`${name}\` set to \`${value}\`.` })
}

export async function runConfigProperties(baseUrl) {
  // getProjectProperties is a DEV_UI method, disabled-by-default over Dev MCP -- use the WebSocket transport.
  const data = await jsonRpcCall(baseUrl, 'devui-configuration_getProjectProperties')
  const content = data?.value ?? data ?? ''
  return section.create('qdev-config-properties', { type: 'markdown', content: '```properties\n' + content + '\n```' })
}
