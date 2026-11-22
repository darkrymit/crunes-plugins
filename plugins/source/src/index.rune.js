import { crypt, fs, os, rune, section, shell } from '@utils'
import { checkSources, recordSources } from './source.js'

function q(arg) {
  const s = String(arg)
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

async function hasBin(bin) {
  const checkCmd = os.platform === 'win32' ? 'where.exe' : 'which'
  const res = await shell.exec(`${checkCmd} ${bin}`, { throw: false })
  return res.exitCode === 0 && Boolean(res.stdout.trim())
}

async function getYtDlpPrefix() {
  if (await hasBin('yt-dlp')) return 'yt-dlp'
  if (await hasBin('uvx')) return 'uvx yt-dlp'
  if (await hasBin('uv')) return 'uv run yt-dlp'
  return null
}

function createIsolateIo() {
  return {
    exists: p => fs.exists(p),
    stat: p => fs.stat(p),
    readText: p => fs.read(p),
    writeText: (p, content) => fs.write(p, content),
    glob: (pattern, cwd) => fs.glob(pattern, { cwd }),
    hashSha256: text => crypt.hashAsHex('sha256', text),
    run: async (cmd, args, opts = {}) => {
      let prefix = cmd
      if (cmd === 'yt-dlp') {
        prefix = await getYtDlpPrefix()
        if (!prefix) throw new Error('yt-dlp not found on PATH or via uvx. Install yt-dlp or uv.')
      }
      const res = await shell.exec(`${prefix} ${args.map(q).join(' ')}`, { cwd: opts.cwd, throw: false })
      if (res.exitCode !== 0) {
        throw new Error(`${cmd} exited ${res.exitCode}: ${(res.stderr || res.stdout || '').trim()}`)
      }
      return res.stdout
    },
  }
}

export function args(b) {
  return b
    .option('-h, --help', 'Show help')
    .command('check', 'Check each source in a JSON file: same, moved, new, unstable or error', c => {
      c.positional('<file>', 'Sources JSON file')
       .option('--id <id>', 'Check only this source')
       .option('-j, --json', 'Emit structured JSON output', false)
    })
    .command('record', 'Record each source current version into the JSON file', c => {
      c.positional('<file>', 'Sources JSON file')
       .option('--id <id>', 'Record only this source')
       .option('-j, --json', 'Emit structured JSON output', false)
    })
}

export async function run(parsed) {
  const cmd = parsed.$command
  if (parsed.help || !cmd) {
    return rune.helpSection()
  }

  const io = createIsolateIo()
  const rows =
    cmd === 'check'
      ? await checkSources(parsed.file, { io, id: parsed.id })
      : cmd === 'record'
        ? await recordSources(parsed.file, { io, id: parsed.id })
        : null

  if (!rows) {
    return rune.helpSection()
  }

  const content = parsed.json
    ? JSON.stringify(rows, null, 2)
    : rows.map(r => [r.id, r.type, r.status, r.detail].join('\t')).join('\n')

  if (rows.some(r => r.status === 'error' || r.status === 'unstable')) {
    throw new Error(content)
  }

  return [section.create(`source:${cmd}`, { type: 'markdown', content, rows })]
}
