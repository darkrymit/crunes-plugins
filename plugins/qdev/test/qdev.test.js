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
  const cmd = process.execPath
  const cli = useLocal ? localCrunesCli : fileURLToPath(import.meta.resolve('@darkrymit/crunes-cli'))
  const fullArgs = [cli, ...args]
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

  it('starts, reports and stops the project Maven wrapper with the configured profile', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crunes-qdev-server-'))
    const argsFile = path.join(tmp, 'mvnw-args.txt')
    const qdev = (...cmd) => runCrunes(tmp, ['-p', 'run', 'qdev', 'server', ...cmd])
    try {
      fs.mkdirSync(path.join(tmp, '.crunes', 'runes'), { recursive: true })
      fs.cpSync(srcDir, path.join(tmp, '.crunes', 'runes', 'qdev'), { recursive: true })
      // Like the real wrapper: exec a second script, which execs the JVM (node here).
      const node = process.execPath.split(path.sep).join('/')
      fs.writeFileSync(path.join(tmp, 'mvnw'), '#!/bin/sh\nprintf "%s\\n" "$@" > mvnw-args.txt\nexec sh mvn.sh\n', { mode: 0o755 })
      fs.writeFileSync(path.join(tmp, 'mvn.sh'), `exec "${node}" server.mjs\n`)
      fs.writeFileSync(path.join(tmp, 'server.mjs'), 'import fs from "node:fs"\nfs.writeFileSync("server.pid", String(process.pid))\nsetTimeout(() => {}, 60000)\n')
      fs.writeFileSync(
        path.join(tmp, '.crunes', 'config.json'),
        JSON.stringify({
          format: '1',
          runes: {
            qdev: {
              vars: {
                'qdev.enable': ['server'],
                'qdev.baseUrl': 'http://localhost:1',
                'qdev.server.profile': 'dev,gemini',
              },
              run: {
                command: '.crunes/runes/qdev/index.rune.js',
                permissions: {
                  allow: [
                    'fs.read:./.crunes/runes/qdev/**',
                    'fs.read:.crunes/runes/qdev/**',
                    'http.fetch:GET::**/q/health',
                    'cache.read:@local-cache::qdev-server',
                    'cache.write:@local-cache::qdev-server',
                    'shell.job.start:./mvnw quarkus:dev *',
                    'shell.run:./mvnw quarkus:dev *',
                    'shell.job.exists',
                    'shell.job.kill',
                    'shell.job.read',
                  ],
                },
              },
            },
          },
        }),
        'utf8'
      )

      assert.match(qdev('start'), /Server starting/)
      for (let i = 0; i < 100 && !fs.existsSync(argsFile); i++) await new Promise(r => setTimeout(r, 100))
      assert.ok(fs.existsSync(argsFile), 'mvnw was never invoked')
      const args = fs.readFileSync(argsFile, 'utf8').trim().split('\n')
      assert.deepEqual(args, ['quarkus:dev', '-Dquarkus.console.basic=true', '-Dquarkus.profile=dev,gemini'])

      assert.match(qdev('status'), /running \(managed\)/)
      const pidFile = path.join(tmp, 'server.pid')
      for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await new Promise(r => setTimeout(r, 100))
      const serverPid = Number(fs.readFileSync(pidFile, 'utf8'))
      const alive = () => { try { process.kill(serverPid, 0); return true } catch { return false } }
      assert.ok(alive(), 'the server process never started')

      assert.match(qdev('stop'), /Server stopped/)
      for (let i = 0; i < 100 && alive(); i++) await new Promise(r => setTimeout(r, 100))
      if (alive()) {
        process.kill(serverPid, 'SIGKILL')
        assert.fail('the server process outlived qdev server stop')
      }
      assert.match(qdev('status'), /stopped/)
    } finally {
      try { qdev('stop') } catch {}
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  })
})
