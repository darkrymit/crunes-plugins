import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

describe('kb.rune.js (E2E isolate)', () => {
  it('lists bundles, reads a document, and checks links', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crunes-kb-test-'))
    try {
      fs.mkdirSync(path.join(tmp, '.crunes', 'runes'), { recursive: true })
      fs.cpSync(srcDir, path.join(tmp, '.crunes', 'runes', 'kb'), { recursive: true })
      fs.writeFileSync(
        path.join(tmp, '.crunes', 'config.json'),
        JSON.stringify({
          format: '1',
          runes: {
            kb: {
              vars: { roots: ['docs/kb'] },
              run: {
                command: '.crunes/runes/kb/index.rune.js',
                permissions: { allow: ['fs.glob:docs/kb/**/*.md', 'fs.read:docs/kb/**'] },
              },
            },
          },
        }),
        'utf8'
      )

      const bundleDir = path.join(tmp, 'docs', 'kb', 'sample')
      fs.mkdirSync(path.join(bundleDir, 'notes'), { recursive: true })
      fs.writeFileSync(
        path.join(bundleDir, 'index.md'),
        '---\nokf_version: "0.2"\nkb: sample\nkb_version: "0.2"\n---\n# Sample Bundle\n\nTest bundle.\n\n## Categories\n\n* [notes](/notes/index.md)\n',
        'utf8'
      )
      fs.writeFileSync(
        path.join(bundleDir, 'notes', 'index.md'),
        '# Notes\n\n* [first](/notes/first.md) - First note.\n',
        'utf8'
      )
      fs.writeFileSync(
        path.join(bundleDir, 'notes', 'first.md'),
        '---\ntype: note\ntitle: First Note\ndescription: A sample note\ntags: [test]\n---\n# First Note\n\nBody text.\n',
        'utf8'
      )

      const listOut = runCrunes(tmp, ['-p', 'run', 'kb', 'list'])
      assert.match(listOut, /Sample Bundle/)
      assert.match(listOut, /sample\/notes/)

      const indexOut = runCrunes(tmp, ['-p', 'run', 'kb', 'read', 'sample/notes'])
      assert.match(indexOut, /First Note/)

      const readOut = runCrunes(tmp, ['-p', 'run', 'kb', 'read', 'sample/notes/first.md'])
      assert.match(readOut, /Body text\./)

      const brokenOut = runCrunes(tmp, ['-p', 'run', 'kb', 'broken', '--all'])
      assert.match(brokenOut, /All links valid/)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})
