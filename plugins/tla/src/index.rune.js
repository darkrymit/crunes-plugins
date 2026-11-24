import { fs, os, rune, section, shell } from '@utils'
import { loadViewCode, parseDot, parseTlcOutput, renderStatechart } from './tla.js'

const TLA2TOOLS_URL =
  'https://github.com/tlaplus/tlaplus/releases/latest/download/tla2tools.jar'
const DEFAULT_JAR = '~/.tla/tla2tools.jar'

function q(arg) {
  const s = String(arg)
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

async function hasBin(bin) {
  const checkCmd = os.platform === 'win32' ? 'where.exe' : 'which'
  const res = await shell.exec(`${checkCmd} ${bin}`, { throw: false })
  return res.exitCode === 0 && Boolean(res.stdout.trim())
}

async function resolveRunner() {
  const candidates = [DEFAULT_JAR, '~/.local/share/tla/tla2tools.jar']
  for (const jar of candidates) {
    if (await fs.exists(jar)) {
      return { kind: 'jar', path: await fs.resolve(jar) }
    }
  }
  if (await hasBin('tlc')) {
    return { kind: 'bin', path: 'tlc' }
  }
  return null
}

export function args(b) {
  return b
    .option('-h, --help', 'Show help')
    .command('doctor', 'Check Java and TLC / tla2tools.jar availability')
    .command('install', 'Download tla2tools.jar into ~/.tla/tla2tools.jar')
    .command('check', 'Run TLC on a TLA+ spec and emit a Mermaid statechart', c => {
      c.positional('<spec>', 'Path to .tla specification file')
       .option('--config <file>', 'Optional .cfg model configuration file')
       .option('--view <file>', 'Optional JS view module (state, step, group, colors, title)')
    })
}

export async function run(parsed) {
  const cmd = parsed.$command

  if (cmd === 'doctor') {
    const hasJava = await hasBin('java')
    const runner = await resolveRunner()
    const lines = [
      `java: ${hasJava ? 'ok' : 'missing (install JDK 17+)'}`,
      `tlc: ${runner ? `${runner.kind} (${runner.path})` : 'missing (run `crunes -p run tla install`)'}`,
    ]
    return [section.create('tla:doctor', { type: 'markdown', content: lines.join('\n'), hasJava, runner })]
  }

  if (cmd === 'install') {
    if (!(await hasBin('curl'))) {
      throw new Error('curl not found on PATH. Download tla2tools.jar manually to ~/.tla/tla2tools.jar.')
    }
    await fs.mkdir('~/.tla')
    const target = await fs.resolve(DEFAULT_JAR)
    const res = await shell.exec(`curl -fsSL ${q(TLA2TOOLS_URL)} -o ${q(target)}`, { throw: false })
    if (res.exitCode !== 0) {
      throw new Error(`curl exited with code ${res.exitCode}: ${(res.stderr || res.stdout || '').trim()}`)
    }
    return [section.create('tla:install', { type: 'markdown', content: `Installed ${target}` })]
  }

  if (cmd === 'check') {
    if (!(await fs.exists(parsed.spec))) {
      throw new Error(`Spec file not found: ${parsed.spec}`)
    }
    const runner = await resolveRunner()
    if (!runner) {
      throw new Error('TLC not found. Run `crunes -p run tla install` first.')
    }
    if (!(await hasBin('java'))) {
      throw new Error('java not found on PATH. Install JDK 17+ to run TLC.')
    }

    let view = null
    if (parsed.view) {
      if (!(await fs.exists(parsed.view))) {
        throw new Error(`View file not found: ${parsed.view}`)
      }
      view = loadViewCode(await fs.read(parsed.view))
    }

    const specAbs = await fs.resolve(parsed.spec)
    const dumpPrefix = `${specAbs}.statechart`
    const dotPath = `${dumpPrefix}.dot`

    const parts = runner.kind === 'jar'
      ? ['java', '-XX:+UseParallelGC', '-cp', runner.path, 'tlc2.TLC']
      : [runner.path]
    parts.push('-workers', 'auto', '-cleanup', '-dump', 'dot', dumpPrefix)
    if (parsed.config) {
      if (!(await fs.exists(parsed.config))) {
        throw new Error(`Config file not found: ${parsed.config}`)
      }
      parts.push('-config', await fs.resolve(parsed.config))
    }
    parts.push(specAbs)

    const cmdStr = parts.map((a, i) => (i === 0 ? a : q(a))).join(' ')
    const res = await shell.exec(cmdStr, { throw: false })
    const combined = `${res.stdout || ''}\n${res.stderr || ''}`
    const result = parseTlcOutput(combined)

    let dot = null
    if (await fs.exists(dotPath)) {
      dot = parseDot(await fs.read(dotPath))
    }

    const chart = renderStatechart({ dot, tlcResult: result, view }) || result.mermaid
    const out = [`Status: ${result.status.toUpperCase()}`]
    if (result.violation) out.push(`Violation: ${result.violation}`)
    if (result.stats) {
      out.push(`States: ${result.stats.generated} generated, ${result.stats.distinct} distinct`)
    }
    if (chart) {
      out.push('', '```mermaid', chart, '```')
    }
    if (result.status === 'error') {
      out.push('', '--- Raw TLC output ---', combined.trim())
    }

    return [section.create('tla:check', { type: 'markdown', content: out.join('\n'), ...result, mermaid: chart })]
  }

  if (parsed.help || !cmd) {
    return rune.helpSection()
  }
  throw new Error('use one of: doctor, install, check')
}
