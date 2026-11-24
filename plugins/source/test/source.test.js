import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const srcDir = path.resolve(__dirname, '../src')
const localCrunesCli = path.resolve(__dirname, '../../../../crunes-cli/dist/cli.js')
const localTestShim = path.resolve(__dirname, '../../../../crunes-cli/src/test/index.js')

const { setupCrunesTest } = await import(
  fs.existsSync(localTestShim) ? pathToFileURL(localTestShim).href : '@darkrymit/crunes-cli/test'
)
const { checkSources, recordSources, tiktokPostDate, validateSources } = await import('../src/source.js')

function runCrunes(cwd, args) {
  const useLocal = fs.existsSync(localCrunesCli)
  const cmd = useLocal ? process.execPath : 'crunes'
  const fullArgs = useLocal ? [localCrunesCli, ...args] : args
  return execFileSync(cmd, fullArgs, { cwd, encoding: 'utf8' })
}

describe('source.js (unit with @utils shim)', () => {
  it('validates schemas and decodes TikTok post dates', () => {
    assert.throws(() => validateSources({}, 'bad.json'), /needs a "sources" array/)
    const ts = BigInt(Math.floor(Date.parse('2026-11-01T00:00:00Z') / 1000)) << 32n
    assert.equal(tiktokPostDate(ts.toString()), '2026-11-01')
  })

  it('records and checks local file and site sources', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crunes-source-unit-'))
    const env = setupCrunesTest({ cwd: tmp })
    try {
      const targetFile = path.join(tmp, 'notes.txt')
      const sourcesFile = path.join(tmp, 'sources.json')
      fs.writeFileSync(targetFile, 'hello v1\n', 'utf8')
      fs.writeFileSync(
        sourcesFile,
        JSON.stringify({
          sources: [
            { id: 'notes', type: 'file', location: 'notes.txt' },
            { id: 'docs', type: 'site', location: 'https://example.com' },
          ],
        }),
        'utf8'
      )

      const rec = await recordSources(sourcesFile, { now: new Date('2026-11-20T00:00:00Z') })
      assert.equal(rec.length, 2)
      assert.equal(rec[0].status, 'recorded')

      const same = await checkSources(sourcesFile, { now: new Date('2026-11-22T00:00:00Z') })
      assert.deepEqual(
        same.map(r => r.status),
        ['same', 'same']
      )

      fs.writeFileSync(targetFile, 'hello v2\n', 'utf8')
      const moved = await checkSources(sourcesFile, { now: new Date('2026-11-22T00:00:00Z') })
      assert.deepEqual(
        moved.map(r => r.status),
        ['moved', 'same']
      )
    } finally {
      await env.cleanup()
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('source.rune.js (E2E isolate)', () => {
  it('runs record and check on local file and site sources inside isolated-vm', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crunes-source-iso-'))
    try {
      fs.mkdirSync(path.join(tmp, '.crunes', 'runes'), { recursive: true })
      fs.cpSync(srcDir, path.join(tmp, '.crunes', 'runes', 'source'), { recursive: true })
      fs.writeFileSync(
        path.join(tmp, '.crunes', 'config.json'),
        JSON.stringify({
          format: '1',
          runes: {
            source: {
              run: {
                command: '.crunes/runes/source/index.rune.js',
                permissions: { allow: ['fs.read:**', 'fs.write:**', 'fs.glob:**::*'] },
              },
            },
          },
        }),
        'utf8'
      )

      fs.writeFileSync(path.join(tmp, 'data.txt'), 'alpha\n', 'utf8')
      fs.writeFileSync(
        path.join(tmp, 'sources.json'),
        JSON.stringify({ sources: [{ id: 'data', type: 'file', location: 'data.txt' }] }),
        'utf8'
      )

      const recOut = runCrunes(tmp, ['-p', 'run', 'source', 'record', 'sources.json'])
      assert.match(recOut, /data\s+file\s+recorded/)

      const sameOut = runCrunes(tmp, ['-p', 'run', 'source', 'check', 'sources.json'])
      assert.match(sameOut, /data\s+file\s+same/)

      fs.writeFileSync(path.join(tmp, 'data.txt'), 'beta\n', 'utf8')
      const movedOut = runCrunes(tmp, ['-p', 'run', 'source', 'check', 'sources.json'])
      assert.match(movedOut, /data\s+file\s+moved/)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})
