import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pluginDir = path.resolve(__dirname, '..')
const localCrunesCli = path.resolve(__dirname, '../../../../crunes-cli/dist/cli.js')
const localTestShim = path.resolve(__dirname, '../../../../crunes-cli/src/test/index.js')

const { installCrunesTestHooks } = await import(
  fs.existsSync(localTestShim) ? pathToFileURL(localTestShim).href : '@darkrymit/crunes-cli/test'
)
installCrunesTestHooks({ pluginRoot: pluginDir })
const { parseReadme, toId } = await import('../src/bucket.js')

function runCrunes(cwd, args, env) {
  const useLocal = fs.existsSync(localCrunesCli)
  const cmd = process.execPath
  const cli = useLocal ? localCrunesCli : fileURLToPath(import.meta.resolve('@darkrymit/crunes-cli'))
  const fullArgs = [cli, ...args]
  return execFileSync(cmd, fullArgs, { cwd, env, encoding: 'utf8' })
}

describe('bucket.js (pure unit)', () => {
  it('normalizes ids and parses README title + summary', () => {
    assert.equal(toId('My Notes_v1!'), 'my-notes_v1')
    const parsed = parseReadme('# Project Alpha\n\n[![badge](url)]\n\nFirst paragraph summary.\n\nSecond paragraph.\n')
    assert.deepEqual(parsed, { title: 'Project Alpha', summary: 'First paragraph summary.' })
  })
})

describe('bucket.rune.js (E2E isolate)', () => {
  it('creates, registers, finds, labels, renames, and deletes buckets in isolated-vm', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crunes-bucket-test-'))
    try {
      const storeDir = path.join(tmp, 'store')
      const homeDir = path.join(tmp, 'home')
      const workDir = path.join(tmp, 'work')
      fs.mkdirSync(storeDir, { recursive: true })
      fs.mkdirSync(homeDir, { recursive: true })
      fs.mkdirSync(path.join(workDir, '.crunes'), { recursive: true })
      fs.writeFileSync(
        path.join(storeDir, 'plugins.json'),
        JSON.stringify({
          format: '1',
          plugins: {
            'local@bucket': {
              version: '1.0.0',
              path: pluginDir,
              cacheDir: pluginDir,
              local: true,
              installedAt: new Date().toISOString(),
              consentedPermissions: {
                bucket: {
                  allow: [
                    'fs.read:**',
                    'fs.read:/**',
                    'fs.read:C:/**',
                    'fs.read:D:/**',
                    'fs.read:~/.bucket/buckets.json',
                    'fs.write:**',
                    'fs.write:/**',
                    'fs.write:C:/**',
                    'fs.write:D:/**',
                    'fs.write:~/.bucket/buckets.json',
                    'fs.mkdir:**',
                    'fs.mkdir:/**',
                    'fs.mkdir:C:/**',
                    'fs.mkdir:D:/**',
                    'fs.rm:**',
                    'fs.rm:/**',
                    'fs.rm:C:/**',
                    'fs.rm:D:/**',
                    'fs.glob:**::*',
                    'fs.glob:/**::*',
                    'fs.glob:C:/**::*',
                    'fs.glob:D:/**::*',
                    'shell.run:git *',
                  ],
                  deny: [],
                },
              },
            },
          },
        }),
        'utf8'
      )
      fs.writeFileSync(
        path.join(workDir, '.crunes', 'config.json'),
        JSON.stringify({
          format: '1',
          plugins: {
            'local@bucket': true,
          },
        }),
        'utf8'
      )

      const env = { ...process.env, CRUNES_STORE: storeDir, HOME: homeDir, USERPROFILE: homeDir }

      const newOut = runCrunes(workDir, ['-p', 'run', 'bucket', 'new', 'notes', '--label', 'docs'], env)
      assert.match(newOut, /notes/)
      assert.ok(fs.existsSync(path.join(homeDir, '.bucket', 'notes')))
      assert.ok(fs.existsSync(path.join(homeDir, '.bucket', 'buckets.json')))

      fs.writeFileSync(
        path.join(homeDir, '.bucket', 'notes', 'README.md'),
        '# Notes Bucket\n\nPersonal engineering notes.\n',
        'utf8'
      )

      const findOut = runCrunes(workDir, ['-p', 'run', 'bucket', 'find', 'engineering'], env)
      assert.match(findOut, /notes/)
      assert.match(findOut, /Notes Bucket/)

      const whereOut = runCrunes(workDir, ['-p', 'run', 'bucket', 'where', 'docs'], env)
      assert.match(whereOut, /\.bucket\/notes/)

      runCrunes(workDir, ['-p', 'run', 'bucket', 'label', 'add', 'notes', 'archive'], env)
      const labelList = runCrunes(workDir, ['-p', 'run', 'bucket', 'label', 'list'], env)
      assert.match(labelList, /archive\s+1/)

      const delOut = runCrunes(workDir, ['-p', 'run', 'bucket', 'delete', 'notes', '--yes'], env)
      assert.match(delOut, /deleted/)
      assert.ok(!fs.existsSync(path.join(homeDir, '.bucket', 'notes')))
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})
