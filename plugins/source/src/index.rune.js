import { rune, section } from '@utils'
import { checkSources, recordSources } from './source.js'

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

  const rows =
    cmd === 'check'
      ? await checkSources(parsed.file, { id: parsed.id })
      : cmd === 'record'
        ? await recordSources(parsed.file, { id: parsed.id })
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
