export function buildMermaid(trace, violation) {
  if (!trace || trace.length === 0) return null
  const lines = ['stateDiagram-v2']
  const esc = (s) => String(s).replace(/"/g, "'")

  for (let i = 0; i < trace.length; i++) {
    const t = trace[i]
    const id = `S${t.step}`
    const label = t.state ? `${t.step}: ${esc(t.state)}` : `State ${t.step}`
    lines.push(`  ${id}: ${label}`)
    if (i === 0) {
      lines.push(`  [*] --> ${id}: ${esc(t.action)}`)
    } else {
      const prev = `S${trace[i - 1].step}`
      lines.push(`  ${prev} --> ${id}: ${esc(t.action)}`)
    }
  }
  if (violation) {
    const last = `S${trace[trace.length - 1].step}`
    lines.push(`  ${last} --> [*]: ${esc(violation)}`)
  }
  return lines.join('\n')
}

export function parseTlcOutput(output) {
  const text = String(output || '')
  const passed = /Model checking completed\.\s+No error has been found\./i.test(text)
  const invMatch = text.match(/Error:\s+Invariant\s+([^\s]+)\s+is violated\./i)
  const propMatch = text.match(/Error:\s+Temporal properties were violated\./i)
  const deadlock = /Error:\s+Deadlock reached\./i.test(text)

  const statesMatch = text.match(
    /(\d+)\s+states generated,\s+(\d+)\s+distinct states found,\s+(\d+)\s+states left on queue/i
  )

  const trace = []
  const stateRegex =
    /^State\s+(\d+):\s+<([^>]+)>\s*\n([\s\S]*?)(?=^State\s+\d+:|^Finished in|\n\d+\s+states generated|(?![\s\S]))/gm
  for (const m of text.matchAll(stateRegex)) {
    const num = Number(m[1])
    const header = m[2].trim()
    const action = header.split(/\s+line\s+/i)[0].trim()
    const body = m[3]
      .trim()
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('@!@!'))
      .map((l) => l.replace(/^\/\\\s*/, ''))
      .join('; ')
    trace.push({ step: num, action, state: body })
  }

  let status = 'error'
  if (passed) status = 'pass'
  else if (invMatch || propMatch || deadlock) status = 'violated'

  const violation = invMatch
    ? `Invariant ${invMatch[1]} violated`
    : deadlock
      ? 'Deadlock reached'
      : propMatch
        ? 'Temporal property violated'
        : null

  return {
    status,
    violation,
    stats: statesMatch
      ? {
          generated: Number(statesMatch[1]),
          distinct: Number(statesMatch[2]),
          left: Number(statesMatch[3]),
        }
      : null,
    trace,
    mermaid: buildMermaid(trace, violation),
  }
}
