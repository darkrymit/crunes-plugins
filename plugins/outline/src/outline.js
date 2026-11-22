/**
 * Supported language extensions.
 */
export const EXT_MAP = {
  '.java': 'brace',
  '.kt': 'brace',
  '.scala': 'brace',
  '.ts': 'brace',
  '.tsx': 'brace',
  '.js': 'brace',
  '.jsx': 'brace',
  '.mjs': 'brace',
  '.cjs': 'brace',
  '.go': 'brace',
  '.rs': 'brace',
  '.c': 'brace',
  '.cpp': 'brace',
  '.h': 'brace',
  '.cs': 'brace',
  '.py': 'python',
}

function extname(filename) {
  if (!filename) return ''
  const base = filename.split(/[/\\]/).pop() || ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot).toLowerCase() : ''
}

export function cleanEmptyLines(text) {
  return text.replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * Collapse brace-enclosed method/function bodies into `{ /* ... *\/ }`.
 * Preserves annotations, decorators, signatures, interfaces, and class bodies.
 * Supports stripping comments and imports by default (opt-in via options).
 */
export function outlineBrace(source, options = {}) {
  const keepComments = !!options.comments
  const keepImports = !!options.imports

  const lines = source.split(/\r?\n/)
  const result = []

  let braceDepth = 0
  let inBlockComment = false
  let inString = false
  let stringChar = ''
  let skippingBody = false
  let skipUntilDepth = 0

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]
    const trimmed = rawLine.trim()

    if (skippingBody) {
      for (let j = 0; j < rawLine.length; j++) {
        const c = rawLine[j]
        const prev = j > 0 ? rawLine[j - 1] : ''

        if (inBlockComment) {
          if (prev === '*' && c === '/') inBlockComment = false
          continue
        }
        if (inString) {
          if (c === stringChar && prev !== '\\') inString = false
          continue
        }

        if (c === '"' || c === "'" || c === '`') {
          inString = true
          stringChar = c
        } else if (c === '/' && rawLine[j + 1] === '*') {
          inBlockComment = true
          j++
        } else if (c === '/' && rawLine[j + 1] === '/') {
          break
        } else if (c === '{') {
          braceDepth++
        } else if (c === '}') {
          braceDepth--
          if (braceDepth <= skipUntilDepth) {
            skippingBody = false
            break
          }
        }
      }
      continue
    }

    if (!keepImports) {
      if (
        trimmed.startsWith('import ') ||
        trimmed.startsWith('export * from') ||
        (trimmed.startsWith('package ') === false && /^import\s*\(/.test(trimmed)) ||
        trimmed.startsWith('use ') ||
        /^const\s+.*=\s*require\(/.test(trimmed) ||
        /^let\s+.*=\s*require\(/.test(trimmed) ||
        /^var\s+.*=\s*require\(/.test(trimmed)
      ) {
        continue
      }
    }

    if (!keepComments) {
      if (inBlockComment) {
        if (trimmed.includes('*/')) {
          inBlockComment = false
        }
        continue
      }
      if (trimmed.startsWith('/*')) {
        if (!trimmed.includes('*/')) {
          inBlockComment = true
        }
        continue
      }
      if (trimmed.startsWith('*') || trimmed.startsWith('//')) {
        continue
      }
    }

    let opensBody = false
    let openBraceIdx = -1

    for (let j = 0; j < rawLine.length; j++) {
      const c = rawLine[j]
      const prev = j > 0 ? rawLine[j - 1] : ''

      if (inBlockComment) {
        if (prev === '*' && c === '/') inBlockComment = false
        continue
      }
      if (inString) {
        if (c === stringChar && prev !== '\\') inString = false
        continue
      }

      if (c === '"' || c === "'" || c === '`') {
        inString = true
        stringChar = c
      } else if (c === '/' && rawLine[j + 1] === '*') {
        inBlockComment = true
        j++
      } else if (c === '/' && rawLine[j + 1] === '/') {
        break
      } else if (c === '{') {
        braceDepth++
        const prefix = rawLine.slice(0, j).trim()
        const isTypeDecl = /\b(class|interface|enum|record|struct|trait|impl|namespace|module)\b/.test(prefix)
        const isControlFlow = /\b(if|else|switch|try|catch|finally|for|while|do)\b/.test(prefix)

        if (
          !isTypeDecl &&
          !isControlFlow &&
          (braceDepth >= 2 ||
            /\b(function|fn|func|def|void|int|bool|string|public|private|protected|async|static)\b/.test(prefix) ||
            prefix.includes(')'))
        ) {
          opensBody = true
          openBraceIdx = j
          skipUntilDepth = braceDepth - 1
          break
        }
      } else if (c === '}') {
        braceDepth--
      }
    }

    if (opensBody && openBraceIdx !== -1) {
      const rest = rawLine.slice(openBraceIdx + 1)
      const prefix = rawLine.slice(0, openBraceIdx)
      result.push(`${prefix}{ /* ... */ }`)
      if (!rest.includes('}')) {
        skippingBody = true
      }
    } else {
      result.push(rawLine)
    }
  }

  return cleanEmptyLines(result.join('\n'))
}

/**
 * Collapse Python function and method bodies into `...`.
 * Preserves classes, `@decorators`, function signatures, return types.
 * Supports stripping docstrings/comments and imports by default.
 */
export function outlinePython(source, options = {}) {
  const keepComments = !!options.comments
  const keepImports = !!options.imports

  const lines = source.split(/\r?\n/)
  const result = []

  let inDocstring = false
  let docstringQuote = ''
  let skippingIndent = -1

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]
    const trimmed = rawLine.trim()

    if (trimmed.length === 0) {
      if (skippingIndent === -1) result.push('')
      continue
    }

    const indent = rawLine.search(/\S/)

    if (skippingIndent !== -1) {
      if (indent > skippingIndent) {
        continue
      } else {
        skippingIndent = -1
      }
    }

    if (!keepImports) {
      if (trimmed.startsWith('import ') || trimmed.startsWith('from ')) {
        continue
      }
    }

    if (!keepComments && trimmed.startsWith('#')) {
      continue
    }

    if (trimmed.startsWith('"""') || trimmed.startsWith("'''")) {
      const quote = trimmed.slice(0, 3)
      if (inDocstring) {
        if (trimmed.endsWith(quote)) inDocstring = false
      } else {
        if (trimmed.length > 3 && trimmed.slice(3).includes(quote)) {
          // One-line docstring
        } else {
          inDocstring = true
          docstringQuote = quote
        }
      }
      if (keepComments) result.push(rawLine)
      continue
    }

    if (inDocstring) {
      if (trimmed.includes(docstringQuote)) inDocstring = false
      if (keepComments) result.push(rawLine)
      continue
    }

    if (/^def\s+/.test(trimmed) || /^\s+def\s+/.test(rawLine)) {
      result.push(rawLine)
      if (trimmed.endsWith(':')) {
        const nextIndent = indent + 4
        const indentStr = ' '.repeat(nextIndent)
        result.push(`${indentStr}...`)
        skippingIndent = indent
      }
      continue
    }

    result.push(rawLine)
  }

  return cleanEmptyLines(result.join('\n'))
}

/**
 * Outline content based on language or filename with options.
 */
export function outlineSource(content, filename, options = {}) {
  const ext = extname(filename)
  const langMode = EXT_MAP[ext] || 'brace'

  if (langMode === 'python') {
    return outlinePython(content, options)
  }
  return outlineBrace(content, options)
}
