import { fs, rune, section, stdin } from '@utils'
import { estimateTokens, formatLine, formatNumber } from './estimate.js'

async function collectFiles(target) {
  let st
  try {
    st = await fs.stat(target)
  } catch (err) {
    if (err && err.code === 'ENOENT') return []
    throw err
  }

  if (st.isFile) return [target]

  if (st.isDirectory) {
    const matched = await fs.glob('**/*', {
      cwd: target,
      ignore: ['node_modules/**', '.git/**'],
    })
    const prefix = target.replace(/[/\\]+$/, '')
    return matched.map(m => (prefix === '.' ? m : `${prefix}/${m}`))
  }

  return []
}

export function args(b) {
  return b
    .option('-h, --help', 'Show help')
    .command('count', 'Count tokens for target files, directories, or piped stdin', c => {
      c.positional('[targets...]', 'Files, directories, or - for piped stdin')
       .option('-m, --model <model>', 'Target model estimation (claude, openai, both)')
       .option('-w, --warn <tokens>', 'Warn if Claude token count exceeds threshold')
    })
}

export async function run(parsed) {
  const stop = typeof rune.guard === 'function' ? rune.guard(parsed) : (parsed.help || !parsed.$command ? rune.helpSection(parsed.$command) : null)
  if (stop) return stop
  const targets = parsed.targets ?? parsed._ ?? []
  const model = parsed.model || 'both'
  const warnLimit = parsed.warn != null ? parseInt(parsed.warn, 10) : null

  if (targets.length === 0 || (targets.length === 1 && targets[0] === '-')) {
    if (stdin.isTTY && targets.length === 0) {
      throw new Error('no target file provided and stdin is a TTY. Usage: crunes -p run token count <files...> or cat file | crunes -p run token count -')
    }
    const content = await stdin.read()
    if (content == null) {
      throw new Error('stdin is a TTY; pipe input or pass target files')
    }
    const stats = estimateTokens(content)
    const overBudget = Boolean(warnLimit && stats.claude > warnLimit)
    const warnings = overBudget
      ? [`stdin exceeds token budget of ${formatNumber(warnLimit)} (Claude: ~${formatNumber(stats.claude)})`]
      : []
    const linesOut = [formatLine('stdin', stats, model), ...warnings.map(w => `! ${w}`)]
    return [
      section.create('token', {
        type: 'markdown',
        content: linesOut.join('\n'),
        files: [{ target: 'stdin', ...stats, overBudget }],
        summary: { count: 1, ...stats },
        warnings,
      }),
    ]
  }

  const allFiles = []
  const warnings = []

  for (const t of targets) {
    const found = await collectFiles(t)
    if (found.length === 0) {
      warnings.push(`target not found or empty: ${t}`)
    } else {
      allFiles.push(...found)
    }
  }

  if (allFiles.length === 0) {
    throw new Error('no matching files found')
  }

  const results = []
  const linesOut = []
  let totalChars = 0
  let totalWords = 0
  let totalLines = 0
  let totalOpenai = 0
  let totalClaude = 0

  for (const file of allFiles) {
    const content = await fs.read(file)
    const stats = estimateTokens(content)
    const overBudget = Boolean(warnLimit && stats.claude > warnLimit)

    results.push({ target: file, ...stats, overBudget })
    linesOut.push(formatLine(file, stats, model))

    if (overBudget) {
      warnings.push(`${file} exceeds token budget of ${formatNumber(warnLimit)} (Claude: ~${formatNumber(stats.claude)})`)
    }

    totalChars += stats.chars
    totalWords += stats.words
    totalLines += stats.lines
    totalOpenai += stats.openai
    totalClaude += stats.claude
  }

  if (results.length > 1) {
    linesOut.push(
      `Total: ~${formatNumber(totalOpenai)} tok (Claude ~${formatNumber(totalClaude)}) across ${results.length} files | ${formatNumber(totalChars)} chars | ${formatNumber(totalLines)} lines`
    )
  }

  if (warnings.length > 0) {
    linesOut.push(...warnings.map(w => `! ${w}`))
  }

  const summary = {
    count: results.length,
    chars: totalChars,
    words: totalWords,
    lines: totalLines,
    openai: totalOpenai,
    claude: totalClaude,
  }

  return [
    section.create('token', {
      type: 'markdown',
      content: linesOut.join('\n'),
      files: results,
      summary,
      warnings,
    }),
  ]
}
