import { fs, json, shell, rune, section } from '@utils'

const ISOLATE_MODULE = /\.rune\.m?js$/i
const RUNE_BLOCK_KEYS = {
  run: ['command', 'argv', 'permissions', 'output', 'pass', 'timeout'],
  repl: ['command', 'permissions'],
}

function joinRel(base, rel) {
  const cleanBase = base.replace(/^\.\//, '').replace(/\/+$/, '')
  const cleanRel = rel.replace(/^\.\//, '')
  return cleanBase ? `${cleanBase}/${cleanRel}` : cleanRel
}

export function args(b) {
  return b
    .option('-h, --help', 'Show help')
    .option('--only <plugin>', 'Check only the named plugin')
    .option('--skip-tests', 'Validate manifests and syntax without running *.test.js', false)
}

export async function run(parsed) {
  const stop = typeof rune.guard === 'function' ? rune.guard(parsed) : (parsed.help ? rune.helpSection(parsed.$command) : null)
  if (stop) return stop
  const only = parsed.only || null
  const skipTests = Boolean(parsed['skip-tests'])

  const errors = []
  const lines = []

  const marketplacePath = '.crunes-plugin/marketplace.json'
  if (!(await fs.exists(marketplacePath))) {
    throw new Error(`Missing marketplace registry at ${marketplacePath}`)
  }

  let marketplace
  try {
    marketplace = await json.read(marketplacePath)
  } catch (err) {
    throw new Error(`Invalid JSON in ${marketplacePath}: ${err.message}`)
  }

  if (marketplace.format !== '1') {
    errors.push(`marketplace.json: expected format "1", got "${marketplace.format}"`)
  }
  if (!marketplace.name) errors.push('marketplace.json: missing "name"')
  if (!Array.isArray(marketplace.plugins)) {
    throw new Error('marketplace.json: "plugins" must be an array')
  }

  lines.push(`Marketplace "${marketplace.name}" (format ${marketplace.format}, ${marketplace.plugins.length} plugins registered)`)

  const entries = only
    ? marketplace.plugins.filter(p => p.name === only)
    : marketplace.plugins

  if (only && entries.length === 0) {
    throw new Error(`Plugin "${only}" not found in ${marketplacePath}`)
  }

  for (const entry of entries) {
    const atPlugin = `marketplace.json plugin "${entry.name ?? 'unknown'}"`
    if (!entry.name) { errors.push(`${atPlugin}: missing "name"`); continue }
    if (!entry.version) { errors.push(`${atPlugin}: missing "version"`); continue }
    if (!entry.source) { errors.push(`${atPlugin}: missing "source"`); continue }

    const manifestPath = joinRel(entry.source, '.crunes-plugin/plugin.json')
    if (!(await fs.exists(manifestPath))) {
      errors.push(`${atPlugin}: missing manifest at ${manifestPath}`)
      continue
    }

    let manifest
    try {
      manifest = await json.read(manifestPath)
    } catch (err) {
      errors.push(`${atPlugin}: invalid JSON in ${manifestPath}: ${err.message}`)
      continue
    }

    if (manifest.format !== '1') {
      errors.push(`${atPlugin} plugin.json: expected format "1", got "${manifest.format}"`)
    }
    if (!manifest.runes || typeof manifest.runes !== 'object' || Array.isArray(manifest.runes)) {
      errors.push(`${atPlugin} plugin.json: "runes" must be an object`)
      continue
    }

    let runeCount = 0
    for (const [key, rune] of Object.entries(manifest.runes)) {
      runeCount++
      const atRune = `${entry.name}:${key}`

      if (!rune || typeof rune !== 'object' || Array.isArray(rune)) {
        errors.push(`${atRune}: rune definition must be an object`)
        continue
      }
      if (rune.path !== undefined || rune.permissions !== undefined) {
        errors.push(`${atRune}: legacy "path" or "permissions" found on rune; use run and repl blocks`)
      }
      if (rune.run == null) {
        errors.push(`${atRune}: missing required "run" block`)
        continue
      }

      for (const mode of ['run', 'repl']) {
        if (rune[mode] == null) continue
        const block = typeof rune[mode] === 'string' ? { command: rune[mode] } : rune[mode]
        if (typeof block !== 'object' || Array.isArray(block)) {
          errors.push(`${atRune}.${mode}: must be a module path string or an object`)
          continue
        }

        const unknown = Object.keys(block).filter(k => !RUNE_BLOCK_KEYS[mode].includes(k))
        if (unknown.length) {
          errors.push(`${atRune}.${mode}: unknown field(s) ${unknown.map(k => `"${k}"`).join(', ')}`)
        }

        if (typeof block.command !== 'string' || block.command === '') {
          errors.push(`${atRune}.${mode}: command must be a non-empty string`)
          continue
        }

        const isIsolate = ISOLATE_MODULE.test(block.command)
        if (mode === 'repl' && !isIsolate) {
          errors.push(`${atRune}.${mode}: repl.command must be a *.rune.js module`)
        }

        const targetPath = joinRel(entry.source, block.command)
        if (!(await fs.exists(targetPath))) {
          errors.push(`${atRune}.${mode}: target file does not exist: ${targetPath}`)
          continue
        }

        if (/\.m?js$/i.test(targetPath)) {
          const res = await shell.exec(`node --check "${targetPath}"`, { throw: false })
          if (res.exitCode !== 0) {
            errors.push(`${atRune}.${mode}: syntax check failed for ${targetPath}:\n${res.stderr}`)
          }
        }

        if (block.permissions != null) {
          if (!isIsolate) {
            errors.push(`${atRune}.${mode}: permissions block not allowed on native rune "${block.command}"`)
          } else if (
            typeof block.permissions !== 'object' ||
            Array.isArray(block.permissions) ||
            Object.keys(block.permissions).some(k => k !== 'allow' && k !== 'deny')
          ) {
            errors.push(`${atRune}.${mode}: permissions must be { "allow": [...], "deny": [...] }`)
          }
        }
      }
    }

    lines.push(`✓ ${entry.name} v${entry.version} (${runeCount} rune${runeCount === 1 ? '' : 's'} valid)`)
  }

  const dispatched = []
  if (!skipTests) {
    for (const entry of entries) {
      const pluginDir = entry.source.replace(/^\.\//, '').replace(/\/+$/, '')
      if (!(await fs.exists(`${pluginDir}/.crunes/config.json`))) continue

      const res = await rune.exec('check', [], { cwd: pluginDir })
      dispatched.push(entry.name)
      for (const sec of res.sections ?? []) {
        if (sec?.data?.content) lines.push(sec.data.content)
      }
      if (!res.ok) {
        errors.push(`${entry.name} check failed (exit ${res.exitCode}):\n${res.stderr || res.stdout}`)
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`${lines.join('\n')}\n\n✗ Check failed:\n${errors.map(e => `- ${e}`).join('\n')}`)
  }

  return [
    section.create('check', {
      type: 'markdown',
      content: lines.join('\n'),
      plugins: entries.map(e => e.name),
      dispatched,
    }),
  ]
}
