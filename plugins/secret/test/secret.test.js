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
  const cmd = process.execPath
  const cli = useLocal ? localCrunesCli : fileURLToPath(import.meta.resolve('@darkrymit/crunes-cli'))
  const fullArgs = [cli, ...args]
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

  it('masks commented assignments and keeps the rest of the comment readable', () => {
    const out = maskConfig(
      [
        '# service config',
        '# DB_PASSWORD=fakecommentedpw',
        '#;  OLD_API_KEY=fakeoldvalue1',
        '; WEBHOOK_SECRET = fakehookvalue',
        '# PORT=8080',
        '# Run with: ./mvnw quarkus:dev',
      ].join('\n'),
      '.env'
    )
    for (const leak of ['fakecommentedpw', 'fakeoldvalue1', 'fakehookvalue']) assert.ok(!out.includes(leak), leak)
    assert.match(out, /^# service config$/m)
    assert.match(out, /^# DB_PASSWORD=fa••••••pw$/m)
    assert.match(out, /^#; {2}OLD_API_KEY=fa••••••e1$/m)
    assert.match(out, /^# PORT=8080$/m)
    assert.match(out, /^# Run with: \.\/mvnw quarkus:dev$/m)
  })

  it('treats names that are or end in key as sensitive, but not words that merely contain it', () => {
    const out = maskConfig(
      ['PROD_ELEVEN_KEY=fakevalue-one', 'key=fakevalue-two', 'app.signing.key=fakevalue-three', 'KEYBOARD=qwerty-layout', 'MONKEY=banana-split'].join('\n'),
      'app.properties'
    )
    assert.doesNotMatch(out, /fakevalue/)
    assert.match(out, /^KEYBOARD=qwerty-layout$/m)
    assert.match(out, /^MONKEY=banana-split$/m)
  })

  it('masks known token shapes under any name, in comments, plain lines and JSON', () => {
    const tokens = ['sk_1a2b3c4d5e6f7a8b9c0d', 'ghp_1a2b3c4d5e6f7a8b9c0d', 'AIza1a2b3c4d5e6f7a8b9c0d', 'tvly-dev-1a2b3c4d5e6f7a8b', 'eyJ1a2b3c4d5e6f.7a8b9c0d']
    const env = tokens.flatMap((t, i) => [`THING_${i}=${t}`, `# previously ${t} was used`, `  ${t}`]).join('\n')
    const out = maskConfig(env, '.env')
    const json = maskConfig(JSON.stringify({ thing: tokens[0], list: tokens }), 'config.json')
    for (const t of tokens) {
      assert.ok(!out.includes(t), t)
      assert.ok(!json.includes(t), t)
    }
    assert.match(out, /^# previously sk••••••0d was used$/m)
    assert.equal(maskConfig('NAME=risk_assessment_module', '.env'), 'NAME=risk_assessment_module')
  })

  it('masks private key blocks whole', () => {
    const block = ['-----BEGIN PRIVATE KEY-----', 'ZmFrZWtleWJvZHk=', 'c2Vjb25kbGluZQ==', '-----END PRIVATE KEY-----']
    const out = maskConfig(['A=1', ...block, 'B=2', `CERT="${block.join('\n')}"`, 'C=3'].join('\n'), '.env')
    assert.doesNotMatch(out, /ZmFrZWtleWJvZHk|c2Vjb25kbGluZQ/)
    assert.match(out, /^A=1$/m)
    assert.match(out, /^B=2$/m)
    assert.match(out, /^C=3$/m)
    assert.doesNotMatch(maskConfig(JSON.stringify({ pem: block.join('\n') }), 'a.json'), /ZmFrZWtleWJvZHk/)
    assert.equal(maskConfig(['A=1', ...block, 'B=2'].join('\n'), '.env', ['b']), 'B=2')
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
