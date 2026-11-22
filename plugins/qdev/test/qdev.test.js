import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildRedactor, marker, redactReason, revealLocked, valuesLocked } from '../src/redact.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const srcDir = path.resolve(__dirname, '../src')
const localCrunesCli = path.resolve(__dirname, '../../../../crunes-cli/dist/cli.js')

function makeVars(map = {}) {
  return {
    read(key, dflt) {
      return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : dflt
    },
  }
}

function runCrunes(cwd, args) {
  const useLocal = fs.existsSync(localCrunesCli)
  const cmd = useLocal ? process.execPath : 'crunes'
  const fullArgs = useLocal ? [localCrunesCli, ...args] : args
  return execFileSync(cmd, fullArgs, { cwd, encoding: 'utf8' })
}

describe('redact (pure unit)', () => {
  it('redacts strong keys and secret value shapes while allowing numbers/booleans', () => {
    const redactor = buildRedactor(makeVars({ 'qdev.config.allowKeys': ['safe\\.secret'] }))
    assert.equal(redactor.reason('quarkus.datasource.password', 'hunter2'), 'strong-key')
    assert.equal(redactor.reason('app.custom', 'sk-1234567890abcdef12345678'), 'value-shape')
    assert.equal(redactor.reason('app.max-tokens', '4096'), null)
    assert.equal(redactor.reason('safe.secret', 'anything'), null)
    assert.equal(marker('strong-key'), '<redacted: strong-key>')
    assert.equal(redactReason('k', '', { allowRes: [], redactRes: [] }), null)
  })

  it('defaults reveal and bulk values locks to locked', () => {
    const v = makeVars()
    assert.equal(revealLocked(v, 'list'), true)
    assert.equal(revealLocked(v, 'get'), true)
    assert.equal(valuesLocked(v), true)

    const unlocked = makeVars({ 'qdev.config.lockReveal': false })
    assert.equal(revealLocked(unlocked, 'get'), false)
    assert.equal(revealLocked(unlocked, 'list'), false)
  })
})

describe('qdev.rune.js (E2E isolate)', () => {
  it('renders help with enabled default commands', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crunes-qdev-test-'))
    try {
      fs.mkdirSync(path.join(tmp, '.crunes', 'runes'), { recursive: true })
      fs.cpSync(srcDir, path.join(tmp, '.crunes', 'runes', 'qdev'), { recursive: true })
      fs.writeFileSync(
        path.join(tmp, '.crunes', 'config.json'),
        JSON.stringify({
          format: '1',
          runes: {
            qdev: {
              vars: { 'qdev.enable': ['logs', 'health'] },
              run: {
                command: '.crunes/runes/qdev/index.rune.js',
                permissions: { allow: ['fs.read:./.crunes/runes/qdev/**', 'fs.read:.crunes/runes/qdev/**'] },
              },
            },
          },
        }),
        'utf8'
      )

      const helpOut = runCrunes(tmp, ['-p', 'run', 'qdev', '--help'])
      assert.match(helpOut, /logs/)
      assert.match(helpOut, /health/)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})
