import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  cancelSignals,
  emptyRegistry,
  listSignals,
  parseDuration,
  setSignal,
  shellQuote,
  sleeperCommand,
  takeDue,
} from '../src/signal.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pluginDir = path.resolve(__dirname, '..')
const localCrunesCli = path.resolve(__dirname, '../../../../crunes-cli/dist/cli.js')

function runCrunes(cwd, args, env) {
  const useLocal = fs.existsSync(localCrunesCli)
  const cmd = process.execPath
  const cli = useLocal ? localCrunesCli : fileURLToPath(import.meta.resolve('@darkrymit/crunes-cli'))
  const fullArgs = [cli, ...args]
  return execFileSync(cmd, fullArgs, { cwd, env, encoding: 'utf8' })
}

const arm = (reg, name, token, now = 0) =>
  setSignal(reg, { name, durationMs: 1000, cmd: ['echo', name], now, token })

describe('signal.js (pure unit)', () => {
  it('parses compound durations and rejects junk', () => {
    assert.equal(parseDuration('1h30m'), 5_400_000)
    assert.equal(parseDuration('90s'), 90_000)
    assert.equal(parseDuration('1.5s'), 1500)
    assert.throws(() => parseDuration('40'), /invalid duration/)
    assert.throws(() => parseDuration('5m junk'), /invalid duration/)
    assert.throws(() => parseDuration(''), /required/)
  })

  it('fires only for the token the sleeper started with', () => {
    const reg = emptyRegistry()
    arm(reg, 'a', 't1')
    assert.equal(takeDue(reg, { name: 'a', token: 'wrong' }), null)
    assert.deepEqual(takeDue(reg, { name: 'a', token: 't1' }).cmd, ['echo', 'a'])
    assert.equal(takeDue(reg, { name: 'a', token: 't1' }), null, 'fires once')
  })

  it('re-arming orphans the old sleeper', () => {
    const reg = emptyRegistry()
    arm(reg, 'a', 'old')
    arm(reg, 'a', 'new')
    assert.equal(takeDue(reg, { name: 'a', token: 'old' }), null)
    assert.ok(takeDue(reg, { name: 'a', token: 'new' }))
  })

  it('cancels by prefix without touching other names, then due skips', () => {
    const reg = emptyRegistry()
    arm(reg, 'cache/x/20m', 't1')
    arm(reg, 'cache/x/10m', 't2')
    arm(reg, 'cache/y/20m', 't3')
    assert.deepEqual(cancelSignals(reg, { prefix: 'cache/x/' }).sort(), ['cache/x/10m', 'cache/x/20m'])
    assert.equal(takeDue(reg, { name: 'cache/x/20m', token: 't1' }), null)
    assert.deepEqual(listSignals(reg, { now: 0 }).map(s => s.name), ['cache/y/20m'])
    assert.deepEqual(cancelSignals(reg, { names: ['missing'] }), [], 'idempotent')
    assert.throws(() => cancelSignals(reg, {}), /names|prefix/)
  })

  it('requires a command and quotes it for bash', () => {
    assert.throws(() => setSignal(emptyRegistry(), { name: 'a', durationMs: 1, cmd: [], now: 0, token: 't' }), /command is required/)
    assert.equal(shellQuote(['echo', "it's", 'a b']), `'echo' 'it'\\''s' 'a b'`)
    assert.equal(
      sleeperCommand({ scriptPath: 'C:/p q/src/sleeper.mjs', token: 't', durationMs: 2500 }),
      `node "C:/p q/src/sleeper.mjs" t 2500`
    )
  })
})

describe('signal.rune.js (E2E isolate + real background jobs)', () => {
  it('fires a timer once, skips a cancelled one, and fires a re-armed one once', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crunes-signal-test-'))
    try {
      const storeDir = path.join(tmp, 'store')
      const homeDir = path.join(tmp, 'home')
      const workDir = path.join(tmp, 'work')
      fs.mkdirSync(storeDir, { recursive: true })
      fs.mkdirSync(homeDir, { recursive: true })
      fs.mkdirSync(path.join(workDir, '.crunes'), { recursive: true })
      const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, '.crunes-plugin', 'plugin.json'), 'utf8'))
      fs.writeFileSync(
        path.join(storeDir, 'plugins.json'),
        JSON.stringify({
          format: '1',
          plugins: {
            'local@signal': {
              version: '1.0.0',
              path: pluginDir,
              cacheDir: pluginDir,
              local: true,
              installedAt: new Date().toISOString(),
              consentedPermissions: { signal: manifest.runes.signal.run.permissions },
            },
          },
        }),
        'utf8'
      )
      fs.writeFileSync(
        path.join(workDir, '.crunes', 'config.json'),
        JSON.stringify({ format: '1', plugins: { 'local@signal': true } }),
        'utf8'
      )
      const env = { ...process.env, CRUNES_STORE: storeDir, HOME: homeDir, USERPROFILE: homeDir }
      const node = process.execPath.replace(/\\/g, '/')
      const marker = name => path.join(tmp, `${name.replace(/\//g, '-')}.marker`).replace(/\\/g, '/')
      const appendCmd = name => ['--', node, '-e', "require('fs').appendFileSync(process.argv[1],'x')", marker(name)]
      const set = (name, dur) => runCrunes(workDir, ['-p', 'run', 'signal', 'set', name, '--in', dur, ...appendCmd(name)], env)
      const read = name => (fs.existsSync(marker(name)) ? fs.readFileSync(marker(name), 'utf8') : '')

      assert.match(set('t/fires', '8s'), /armed t\/fires/)
      set('t/cancelled', '8s')
      set('t/rearmed', '8s')
      set('t/rearmed', '10s')
      assert.match(runCrunes(workDir, ['-p', 'run', 'signal', 'cancel', '--prefix', 't/cancel'], env), /cancelled 1 signal\b/)
      assert.match(runCrunes(workDir, ['-p', 'run', 'signal', 'list'], env), /t\/fires[\s\S]*t\/rearmed/)

      const deadline = Date.now() + 60_000
      while (Date.now() < deadline && !(read('t/fires') && read('t/rearmed'))) {
        await new Promise(r => setTimeout(r, 500))
      }
      // Let the orphaned first t/rearmed sleeper and the cancelled one wake and (not) fire.
      await new Promise(r => setTimeout(r, 5000))

      assert.equal(read('t/fires'), 'x', 'fired exactly once')
      assert.equal(read('t/rearmed'), 'x', 're-armed signal fired exactly once')
      assert.equal(read('t/cancelled'), '', 'cancelled signal never fired')
      assert.match(runCrunes(workDir, ['-p', 'run', 'signal', 'list'], env), /no armed signals/)
    } finally {
      // Windows refuses to delete a folder a stray sleeper still holds; that must not mask the assertion above.
      try {
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 })
      } catch (e) {
        if (e.code !== 'EPERM' && e.code !== 'EBUSY') throw e
      }
    }
  })
})
