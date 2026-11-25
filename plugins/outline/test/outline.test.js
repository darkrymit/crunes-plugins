import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { outlineBrace, outlinePython, outlineSource } from '../src/outline.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const srcDir = path.resolve(__dirname, '../src')
const localCrunesCli = path.resolve(__dirname, '../../../../crunes-cli/dist/cli.js')

function runCrunes(cwd, args, input) {
  const useLocal = fs.existsSync(localCrunesCli)
  const cmd = process.execPath
  const cli = useLocal ? localCrunesCli : fileURLToPath(import.meta.resolve('@darkrymit/crunes-cli'))
  const fullArgs = [cli, ...args]
  return execFileSync(cmd, fullArgs, { cwd, input, encoding: 'utf8' })
}

describe('outlineSource (pure unit)', () => {
  it('collapses brace function/method bodies and strips imports & comments by default', () => {
    const js = [
      "import { x } from 'y'",
      '// top comment',
      'export class Greeter {',
      '  /* doc */',
      '  greet(name) {',
      '    const msg = "hello " + name',
      '    return msg',
      '  }',
      '}',
    ].join('\n')

    const out = outlineSource(js, 'greeter.js')
    assert.ok(!out.includes("import { x }"))
    assert.ok(!out.includes('// top comment'))
    assert.ok(!out.includes('/* doc */'))
    assert.ok(out.includes('export class Greeter {'))
    assert.ok(out.includes('greet(name) { /* ... */ }'))
    assert.ok(!out.includes('const msg'))
  })

  it('preserves comments and imports when requested', () => {
    const js = [
      "import { x } from 'y'",
      '// top comment',
      'function add(a, b) {',
      '  return a + b',
      '}',
    ].join('\n')

    const out = outlineBrace(js, { comments: true, imports: true })
    assert.ok(out.includes("import { x } from 'y'"))
    assert.ok(out.includes('// top comment'))
    assert.ok(out.includes('function add(a, b) { /* ... */ }'))
    assert.ok(!out.includes('return a + b'))
  })

  it('collapses Python function bodies into ellipsis', () => {
    const py = [
      'import os',
      '# helper comment',
      'class Service:',
      '    def run(self, x):',
      '        """Run it."""',
      '        y = x + 1',
      '        return y',
    ].join('\n')

    const out = outlineSource(py, 'service.py')
    assert.ok(!out.includes('import os'))
    assert.ok(!out.includes('# helper comment'))
    assert.ok(out.includes('class Service:'))
    assert.ok(out.includes('    def run(self, x):'))
    assert.ok(out.includes('        ...'))
    assert.ok(!out.includes('y = x + 1'))
  })
})

describe('outline.rune.js (E2E isolate)', () => {
  it('outlines files with flags and reads piped stdin', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crunes-outline-test-'))
    try {
      fs.mkdirSync(path.join(tmp, '.crunes', 'runes'), { recursive: true })
      fs.cpSync(srcDir, path.join(tmp, '.crunes', 'runes', 'outline'), { recursive: true })
      fs.writeFileSync(
        path.join(tmp, '.crunes', 'config.json'),
        JSON.stringify({
          format: '1',
          runes: {
            outline: {
              run: {
                command: '.crunes/runes/outline/index.rune.js',
                permissions: { allow: ['fs.read:.', 'fs.read:**'] },
              },
            },
          },
        }),
        'utf8'
      )
      fs.writeFileSync(
        path.join(tmp, 'app.js'),
        "import { foo } from './foo.js'\n// note\nfunction main() {\n  return foo()\n}\n",
        'utf8'
      )
      fs.writeFileSync(
        path.join(tmp, 'worker.py'),
        'def work():\n    return 42\n',
        'utf8'
      )

      const jsOut = runCrunes(tmp, ['-p', 'run', 'outline', 'show', 'app.js'])
      assert.match(jsOut, /function main\(\) \{ \/\* \.\.\. \*\/ \}/)
      assert.doesNotMatch(jsOut, /import \{ foo \}/)
      assert.doesNotMatch(jsOut, /return foo\(\)/)

      const withFlags = runCrunes(tmp, ['-p', 'run', 'outline', 'show', 'app.js', '-c', '-i'])
      assert.match(withFlags, /import \{ foo \}/)
      assert.match(withFlags, /\/\/ note/)

      const pyOut = runCrunes(tmp, ['-p', 'run', 'outline', 'show', 'worker.py'])
      assert.match(pyOut, /def work\(\):/)
      assert.match(pyOut, /\.\.\./)

      const piped = runCrunes(tmp, ['-p', 'run', 'outline', 'show', '-'], 'function hi() {\n  return 1\n}\n')
      assert.match(piped, /function hi\(\) \{ \/\* \.\.\. \*\/ \}/)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})
