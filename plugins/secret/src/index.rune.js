import { fs, rune, section } from '@utils'
import { maskConfig, parseWantedKeys } from './mask.js'

export function args(b) {
  return b
    .option('-h, --help', 'Show help')
    .command('read', 'Print a config or env file with secret values masked', c => {
      c.positional('<file>', 'Target config or env file')
       .option('-k, --key <name>', 'Only this key')
       .option('--keys <names>', 'Only these comma-separated keys')
    })
}

export async function run(parsed) {
  const stop = typeof rune.guard === 'function' ? rune.guard(parsed) : (parsed.help || !parsed.$command ? rune.helpSection(parsed.$command) : null)
  if (stop) return stop
  const target = parsed.file ?? parsed._?.[0]
  if (!target) {
    throw new Error('file is required. Usage: crunes -p run secret read <file>')
  }

  let content
  try {
    content = await fs.read(target)
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new Error(`no such file: ${target}`)
    }
    throw err
  }

  const wanted = parseWantedKeys(parsed.key, parsed.keys)
  const masked = maskConfig(content, target, wanted)

  return [
    section.create('secret', {
      type: 'markdown',
      content: masked,
      file: target,
    }),
  ]
}
