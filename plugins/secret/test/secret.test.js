import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { maskConfig, maskUrlCredentials, maskValue } from '../src/mask.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const srcDir = path.resolve(__dirname, '../src')
const localCrunesCli = path.resolve(__dirname, '../../../../crunes-cli/dist/cli.js')

function runCrunes(cwd, args) {
  const useLocal = fs.existsSync(localCrunesCli)
  const cmd = useLocal ? process.execPath : 'crunes'
  const fullArgs = useLocal ? [localCrunesCli, ...args] : args
  return execFileSync(cmd, fullArgs, { cwd, encoding: 'utf8' })
}

describe('mask (pure unit)', () => {
  it('masks short and long sensitive values and scrubs URL credentials', () => {
    assert.equal(maskValue('abc'), '••••')
    assert.equal(maskValue('supersecret123'), 'su••••••23')
    assert.equal(
      maskUrlCredentials('postgres://admin:hunter2@db.internal:5432/app'),
      'postgres://admin:••••@db.internal:5432/app'
    )
  })

  it('masks .env and .json configs and filters by wanted keys', () => {
    const env = [
      '# service config',
      'PORT=8080',
      'API_KEY=sk-1234567890abcdef',
      'DATABASE_URL=postgres://user:pass123@localhost:5432/db',
    ].join('\n')

    const maskedEnv = maskConfig(env, '.env')
    assert.match(maskedEnv, /PORT=8080/)
    assert.match(maskedEnv, /API_KEY=sk••••••ef/)
    assert.match(maskedEnv, /DATABASE_URL=postgres:\/\/user:••••@localhost:5432\/db/)
    assert.doesNotMatch(maskedEnv, /pass123/)

    const filteredJson = maskConfig(
      JSON.stringify({ port: 3000, apiSecret: 'topsecret99', host: 'localhost' }),
      'config.json',
      ['port', 'apisecret']
    )
    const parsed = JSON.parse(filteredJson)
    assert.deepEqual(parsed, { port: 3000, apiSecret: 'to••••••99' })
  })
})

describe('secret.rune.js (E2E isolate)', () => {
  it('reads .env and .json files with masking and --key / --keys filtering', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crunes-secret-test-'))
    try {
      fs.mkdirSync(path.join(tmp, '.crunes', 'runes'), { recursive: true })
      fs.cpSync(srcDir, path.join(tmp, '.crunes', 'runes', 'secret'), { recursive: true })
      fs.writeFileSync(
        path.join(tmp, '.crunes', 'config.json'),
        JSON.stringify({
          format: '1',
          runes: {
            secret: {
              run: {
                command: '.crunes/runes/secret/index.rune.js',
                permissions: { allow: ['fs.read:.', 'fs.read:**'] },
              },
            },
          },
        }),
        'utf8'
      )
      fs.writeFileSync(
        path.join(tmp, '.env'),
        'HOST=localhost\nDB_PASSWORD=mysecretpassword\nREDIS_URL=redis://default:s3cr3t@cache:6379\n',
        'utf8'
      )
      fs.writeFileSync(
        path.join(tmp, 'app.json'),
        JSON.stringify({ port: 8080, token: 'ghp_1234567890abcdef' }),
        'utf8'
      )

      const envOut = runCrunes(tmp, ['-p', 'run', 'secret', 'read', '.env'])
      assert.match(envOut, /HOST=localhost/)
      assert.match(envOut, /DB_PASSWORD=my••••••rd/)
      assert.match(envOut, /REDIS_URL=redis:\/\/default:••••@cache:6379/)
      assert.doesNotMatch(envOut, /mysecretpassword/)
      assert.doesNotMatch(envOut, /s3cr3t/)

      const keyOut = runCrunes(tmp, ['-p', 'run', 'secret', 'read', '.env', '--key', 'HOST'])
      assert.match(keyOut, /HOST=localhost/)
      assert.doesNotMatch(keyOut, /DB_PASSWORD/)

      const jsonOut = runCrunes(tmp, ['-p', 'run', 'secret', 'read', 'app.json', '--keys', 'port,token'])
      assert.match(jsonOut, /"port": 8080/)
      assert.match(jsonOut, /"token": "gh••••••ef"/)
      assert.doesNotMatch(jsonOut, /ghp_1234567890abcdef/)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})
