import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')

const ISOLATE_MODULE = /\.rune\.m?js$/i
const RUNE_BLOCK_KEYS = {
  run: ['command', 'argv', 'permissions', 'output', 'pass', 'timeout'],
  repl: ['command', 'permissions'],
}

let errors = 0
function fail(msg) {
  console.error(`✗ ${msg}`)
  errors++
}

function ok(msg) {
  console.log(`✓ ${msg}`)
}

console.log('Validating crunes-plugins marketplace...\n')

// 1. Marketplace Registry
const marketplacePath = path.join(rootDir, '.crunes-plugin', 'marketplace.json')
if (!fs.existsSync(marketplacePath)) {
  fail(`Missing marketplace registry at ${marketplacePath}`)
  process.exit(1)
}

let marketplace
try {
  marketplace = JSON.parse(fs.readFileSync(marketplacePath, 'utf8'))
} catch (e) {
  fail(`Invalid JSON in ${marketplacePath}: ${e.message}`)
  process.exit(1)
}

if (marketplace.format !== '1') {
  fail(`marketplace.json: expected format "1", got "${marketplace.format}"`)
}
if (!marketplace.name) fail('marketplace.json: missing "name"')
if (!Array.isArray(marketplace.plugins)) {
  fail('marketplace.json: "plugins" must be an array')
  process.exit(1)
}

ok(`Marketplace registry "${marketplace.name}" (format ${marketplace.format}, ${marketplace.plugins.length} plugins registered)`)

// 2. Validate Each Registered Plugin
for (const entry of marketplace.plugins) {
  const atPlugin = `marketplace.json plugin "${entry.name ?? 'unknown'}"`
  if (!entry.name) { fail(`${atPlugin}: missing "name"`); continue }
  if (!entry.version) { fail(`${atPlugin}: missing "version"`); continue }
  if (!entry.source) { fail(`${atPlugin}: missing "source"`); continue }

  const pluginDir = path.resolve(rootDir, entry.source)
  if (!fs.existsSync(pluginDir) || !fs.statSync(pluginDir).isDirectory()) {
    fail(`${atPlugin}: source directory "${entry.source}" does not exist`)
    continue
  }

  const manifestPath = path.join(pluginDir, '.crunes-plugin', 'plugin.json')
  if (!fs.existsSync(manifestPath)) {
    fail(`${atPlugin}: missing manifest at ${path.relative(rootDir, manifestPath)}`)
    continue
  }

  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch (e) {
    fail(`${atPlugin}: invalid JSON in ${path.relative(rootDir, manifestPath)}: ${e.message}`)
    continue
  }

  if (manifest.format !== '1') {
    fail(`${atPlugin} plugin.json: expected format "1", got "${manifest.format}"`)
  }
  if (!manifest.runes || typeof manifest.runes !== 'object' || Array.isArray(manifest.runes)) {
    fail(`${atPlugin} plugin.json: "runes" must be an object`)
    continue
  }

  let runeCount = 0
  for (const [key, rune] of Object.entries(manifest.runes)) {
    runeCount++
    const atRune = `${entry.name}:${key}`

    if (!rune || typeof rune !== 'object' || Array.isArray(rune)) {
      fail(`${atRune}: rune definition must be an object`)
      continue
    }

    if (rune.path !== undefined || rune.permissions !== undefined) {
      fail(`${atRune}: legacy "path" or "permissions" found on rune; use run and repl blocks`)
    }

    if (rune.run == null) {
      fail(`${atRune}: missing required "run" block`)
      continue
    }

    for (const mode of ['run', 'repl']) {
      if (rune[mode] == null) continue
      const block = typeof rune[mode] === 'string' ? { command: rune[mode] } : rune[mode]
      if (typeof block !== 'object' || Array.isArray(block)) {
        fail(`${atRune}.${mode}: must be a module path string or an object`)
        continue
      }

      const unknown = Object.keys(block).filter(k => !RUNE_BLOCK_KEYS[mode].includes(k))
      if (unknown.length) {
        fail(`${atRune}.${mode}: unknown field(s) ${unknown.map(k => `"${k}"`).join(', ')}`)
      }

      if (typeof block.command !== 'string' || block.command === '') {
        fail(`${atRune}.${mode}: command must be a non-empty string`)
        continue
      }

      const isIsolate = ISOLATE_MODULE.test(block.command)
      if (mode === 'repl' && !isIsolate) {
        fail(`${atRune}.${mode}: repl.command must be a *.rune.js module`)
      }

      const targetPath = path.resolve(pluginDir, block.command)
      if (!fs.existsSync(targetPath)) {
        fail(`${atRune}.${mode}: target file does not exist: ${path.relative(rootDir, targetPath)}`)
        continue
      }

      // Check JS syntax if it's a JS file
      if (/\.m?js$/i.test(targetPath)) {
        try {
          execFileSync(process.execPath, ['--check', targetPath], { stdio: 'pipe' })
        } catch (syntaxErr) {
          fail(`${atRune}.${mode}: syntax check failed for ${path.relative(rootDir, targetPath)}:\n${syntaxErr.stderr?.toString()}`)
        }
      }

      if (block.permissions != null) {
        if (!isIsolate) {
          fail(`${atRune}.${mode}: permissions block not allowed on native rune "${block.command}"`)
        } else if (typeof block.permissions !== 'object' || Array.isArray(block.permissions) ||
                   Object.keys(block.permissions).some(k => k !== 'allow' && k !== 'deny')) {
          fail(`${atRune}.${mode}: permissions must be { "allow": [...], "deny": [...] }`)
        }
      }
    }
  }

  ok(`Plugin "${entry.name}" v${entry.version} (${runeCount} rune${runeCount === 1 ? '' : 's'} verified, all files and syntax valid)`)
}

console.log('')
if (errors > 0) {
  console.error(`✗ Validation failed with ${errors} error${errors === 1 ? '' : 's'}.`)
  process.exit(1)
} else {
  console.log(`✓ All plugins in crunes-plugins are valid and structurally sound.`)
  process.exit(0)
}
