import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { estimateTokens } from '../src/estimate.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const srcDir = path.resolve(__dirname, '../src')
const localCrunesCli = path.resolve(__dirname, '../../../../crunes-cli/dist/cli.js')

function runCrunes(cwd, args, input) {
  const useLocal = fs.existsSync(localCrunesCli)
  const cmd = useLocal ? process.execPath : 'crunes'
  const fullArgs = useLocal ? [localCrunesCli, ...args] : args
  return execFileSync(cmd, fullArgs, { cwd, input, encoding: 'utf8' })
}

describe('estimateTokens (pure unit)', () => {
  it('returns zeros for empty content', () => {
    assert.deepEqual(estimateTokens(''), {
      chars: 0,
      words: 0,
      lines: 0,
      openai: 0,
      claude: 0,
    })
  })

  it('estimates prose with ~1.30x Claude/OpenAI ratio', () => {
    const text = 'The quick brown fox jumps over the lazy dog.\nSecond line with some numbers 123456 and symbols #$%^&*.'
    const stats = estimateTokens(text)
    assert.equal(stats.chars, text.length)
    assert.equal(stats.lines, 2)
    assert.equal(stats.words, 18)
    assert.ok(stats.openai > 15)
    assert.ok(stats.claude > stats.openai)
    assert.equal(Math.round(stats.openai * 1.3), stats.claude)
  })
})

describe('token.rune.js (E2E isolate)', () => {
  it('counts file, warns on budget, sweeps directory, and reads piped stdin', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crunes-token-test-'))
    try {
      fs.mkdirSync(path.join(tmp, '.crunes', 'runes'), { recursive: true })
      fs.cpSync(srcDir, path.join(tmp, '.crunes', 'runes', 'token'), { recursive: true })
      fs.writeFileSync(
        path.join(tmp, '.crunes', 'config.json'),
        JSON.stringify({
          format: '1',
          runes: {
            token: {
              run: {
                command: '.crunes/runes/token/index.rune.js',
                permissions: { allow: ['fs.read:.', 'fs.read:**', 'fs.glob:**::*'] },
              },
            },
          },
        }),
        'utf8'
      )
      fs.writeFileSync(path.join(tmp, 'sample.txt'), 'Hello world from crunes token test.\nLine two.\n', 'utf8')
      fs.writeFileSync(path.join(tmp, 'sample2.txt'), 'Another sample file for directory sweep.\n', 'utf8')

      const single = runCrunes(tmp, ['-p', 'run', 'token', 'count', 'sample.txt'])
      assert.match(single, /sample\.txt: ~\d+ tok \(Claude ~\d+\)/)

      const warned = runCrunes(tmp, ['-p', 'run', 'token', 'count', 'sample.txt', '--warn', '1'])
      assert.match(warned, /! sample\.txt exceeds token budget of 1/)

      const dir = runCrunes(tmp, ['-p', 'run', 'token', 'count', '.', '--model', 'claude'])
      assert.match(dir, /Total: ~\d+ tok \(Claude ~\d+\) across 2 files/)

      const piped = runCrunes(tmp, ['-p', 'run', 'token', 'count', '-'], 'Hello from piped stdin test stream\n')
      assert.match(piped, /stdin: ~\d+ tok \(Claude ~\d+\) \| 35 chars \| 2 lines/)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})
