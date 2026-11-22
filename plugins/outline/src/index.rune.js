import { fs, section, stdin } from '@utils'
import { outlineSource } from './outline.js'

export function args(b) {
  return b
    .option('-h, --help', 'Show help')
    .command('show', 'Print structural code outline for files or piped stdin', c => {
      c.positional('[targets...]', 'Files or - for piped stdin')
       .option('-c, --comments', 'Preserve comments and docstrings (default: false)', false)
       .option('-i, --imports', 'Preserve import statements (default: false)', false)
    })
}

export async function run(parsed) {
  const targets = parsed.targets ?? parsed._ ?? []
  const options = {
    comments: Boolean(parsed.comments),
    imports: Boolean(parsed.imports),
  }

  if (targets.length === 0 || (targets.length === 1 && targets[0] === '-')) {
    if (stdin.isTTY && targets.length === 0) {
      throw new Error('no target file provided and stdin is a TTY. Usage: crunes -p run outline show <files...> or cat file | crunes -p run outline show -')
    }
    const content = await stdin.read()
    if (content == null) {
      throw new Error('stdin is a TTY; pipe input or pass target files')
    }
    const outlined = outlineSource(content, '', options)
    return [
      section.create('outline', {
        type: 'markdown',
        content: outlined,
        files: [{ target: 'stdin', lines: outlined ? outlined.split('\n').length : 0 }],
        warnings: [],
      }),
    ]
  }

  const outBlocks = []
  const files = []
  const warnings = []

  for (const target of targets) {
    let st
    try {
      st = await fs.stat(target)
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        warnings.push(`target not found: ${target}`)
        continue
      }
      throw err
    }

    if (st.isDirectory) {
      warnings.push(`skipping directory (specify files): ${target}`)
      continue
    }

    const content = await fs.read(target)
    const outlined = outlineSource(content, target, options)
    files.push({ target, lines: outlined ? outlined.split('\n').length : 0 })
    if (targets.length > 1) {
      outBlocks.push(`// ${target}\n${outlined}`)
    } else {
      outBlocks.push(outlined)
    }
  }

  if (files.length === 0 && warnings.length > 0) {
    throw new Error(warnings.join('\n'))
  }

  const content = [...outBlocks, ...warnings.map(w => `! ${w}`)].join('\n\n')

  return [
    section.create('outline', {
      type: 'markdown',
      content,
      files,
      warnings,
    }),
  ]
}
