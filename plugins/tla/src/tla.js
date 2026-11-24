export function parseTlaValue(raw) {
  const s = String(raw || '').trim()
  if (s === 'TRUE') return true
  if (s === 'FALSE') return false
  if (/^-?\d+$/.test(s)) return Number(s)
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1)
  if (s.startsWith('{') && s.endsWith('}')) {
    const inner = s.slice(1, -1).trim()
    return inner ? splitTopLevel(inner, ',').map(parseTlaValue) : []
  }
  if (s.startsWith('<<') && s.endsWith('>>')) {
    const inner = s.slice(2, -2).trim()
    return inner ? splitTopLevel(inner, ',').map(parseTlaValue) : []
  }
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim()
    if (!inner) return {}
    const obj = {}
    for (const part of splitTopLevel(inner, ',')) {
      const idx = part.indexOf('|->')
      if (idx !== -1) {
        const k = part.slice(0, idx).trim()
        const v = part.slice(idx + 3).trim()
        obj[k] = parseTlaValue(v)
      }
    }
    return obj
  }
  return s
}

function splitTopLevel(str, sep) {
  const out = []
  let depth = 0
  let inQuote = false
  let start = 0
  for (let i = 0; i < str.length; i++) {
    const ch = str[i]
    if (ch === '"' && str[i - 1] !== '\\') inQuote = !inQuote
    else if (!inQuote) {
      if (ch === '{' || ch === '[' || (ch === '<' && str[i + 1] === '<')) depth++
      else if (ch === '}' || ch === ']' || (ch === '>' && str[i - 1] === '>')) depth = Math.max(0, depth - 1)
      else if (ch === sep && depth === 0) {
        out.push(str.slice(start, i).trim())
        start = i + 1
      }
    }
  }
  const tail = str.slice(start).trim()
  if (tail) out.push(tail)
  return out
}

export function parseStateVars(text) {
  const vars = {}
  const lines = String(text || '')
    .replace(/\\n/g, '\n')
    .replaceAll(String.fromCharCode(59),String.fromCharCode(10)).split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('@!@!'))

  for (const line of lines) {
    const clean = line.replace(/^\/\\\s*/, '')
    const eq = clean.indexOf('=')
    if (eq !== -1) {
      const k = clean.slice(0, eq).trim()
      const v = clean.slice(eq + 1).trim()
      vars[k] = parseTlaValue(v)
    }
  }
  return vars
}

export function parseDot(dotText) {
  const nodes = new Map()
  const edges = []
  const text = String(dotText || '')

  const nodeRe = /^\s*"?(-?\d+)"?\s*\[([^\]]+)\]\s*;?\s*$/gm
  for (const m of text.matchAll(nodeRe)) {
    const id = m[1]
    const attrs = m[2]
    const labelMatch = attrs.match(/label="((?:[^"\\]|\\.)*)"/)
    if (!labelMatch) continue
    const rawLabel = labelMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n')
    const initial = /style=filled/i.test(attrs)
    nodes.set(id, {
      id,
      raw: rawLabel,
      vars: parseStateVars(rawLabel),
      initial,
    })
  }

  const edgeRe = /^\s*"?(-?\d+)"?\s*->\s*"?(-?\d+)"?(?:\s*\[([^\]]*)\])?\s*;?\s*$/gm
  for (const m of text.matchAll(edgeRe)) {
    const attrs = m[3] || ''
    const labelMatch = attrs.match(/label="((?:[^"\\]|\\.)*)"/)
    const action = labelMatch ? labelMatch[1].replace(/\\"/g, '"').trim() : 'Next'
    edges.push({ from: m[1], to: m[2], action })
  }

  return { nodes, edges }
}

export function loadViewCode(code) {
  const transformed = String(code || '')
    .replace(/export\s+const\s+/g, 'const ')
    .replace(/export\s+let\s+/g, 'let ')
    .replace(/export\s+function\s+/g, 'function ')
  const fn = new Function(
    `${transformed}\nreturn { state: typeof state !== 'undefined' ? state : null, step: typeof step !== 'undefined' ? step : null, group: typeof group !== 'undefined' ? group : null, colors: typeof colors !== 'undefined' ? colors : null, title: typeof title !== 'undefined' ? title : null };`
  )
  return fn()
}

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

function defaultStateLabel(vars, raw) {
  const keys = Object.keys(vars || {})
  if (keys.length === 0) return String(raw || '').replace(/\n+/g, '; ')
  return keys.map((k) => `${k}=${JSON.stringify(vars[k])}`).join(', ')
}

export function renderStatechart({ dot, tlcResult, view }) {
  if (!dot || dot.nodes.size === 0) {
    return buildMermaid(tlcResult?.trace || [], tlcResult?.violation || null)
  }

  const esc = (s) => String(s).replace(/"/g, "'")
  const badStateKey =
    tlcResult?.status === 'violated' && tlcResult.trace?.length
      ? JSON.stringify(parseStateVars(tlcResult.trace[tlcResult.trace.length - 1].state))
      : null

  const labelToId = new Map()
  const chartStates = new Map()
  const nodeToChartId = new Map()

  const getChartId = (label) => {
    if (!labelToId.has(label)) {
      const id = `S${labelToId.size + 1}`
      labelToId.set(label, id)
      chartStates.set(id, { id, label, groups: new Set(), badCount: 0, totalCount: 0, initial: false })
    }
    return labelToId.get(label)
  }

  for (const [nodeId, node] of dot.nodes.entries()) {
    const rawLabel = view?.state ? view.state(node.vars) : defaultStateLabel(node.vars, node.raw)
    const label = Array.isArray(rawLabel)
      ? rawLabel.join(' / ')
      : typeof rawLabel === 'object' && rawLabel !== null
        ? Object.entries(rawLabel).map(([k, v]) => `${k}: ${v}`).join(' | ')
        : String(rawLabel)

    const cid = getChartId(label)
    nodeToChartId.set(nodeId, cid)
    const entry = chartStates.get(cid)
    entry.totalCount++
    if (node.initial) entry.initial = true
    if (badStateKey && JSON.stringify(node.vars) === badStateKey) entry.badCount++
    if (view?.group) {
      const g = view.group(node.vars)
      if (g) entry.groups.add(String(g))
    }
  }

  const lines = []
  if (view?.title) {
    lines.push('---', `title: ${esc(view.title)}`, '---')
  }
  lines.push('stateDiagram-v2')

  for (const st of chartStates.values()) {
    lines.push(`  ${st.id}: ${esc(st.label)}`)
    if (st.initial) lines.push(`  [*] --> ${st.id}`)
  }

  const seenEdges = new Set()
  for (const e of dot.edges) {
    const fromNode = dot.nodes.get(e.from)
    const toNode = dot.nodes.get(e.to)
    const fromCid = nodeToChartId.get(e.from)
    const toCid = nodeToChartId.get(e.to)
    if (!fromCid || !toCid || fromCid === toCid) continue

    const stepLabel = view?.step
      ? view.step(e.action, fromNode?.vars || {}, toNode?.vars || {})
      : e.action
    if (stepLabel === null || stepLabel === undefined) continue

    const key = `${fromCid}|${toCid}|${stepLabel}`
    if (seenEdges.has(key)) continue
    seenEdges.add(key)
    lines.push(`  ${fromCid} --> ${toCid}: ${esc(stepLabel)}`)
  }

  let hasBreaks = false
  let hasMayBreak = false
  for (const st of chartStates.values()) {
    if (st.badCount > 0 && st.badCount === st.totalCount) {
      lines.push(`  class ${st.id} breaks`)
      hasBreaks = true
    } else if (st.badCount > 0) {
      lines.push(`  class ${st.id} mayBreak`)
      hasMayBreak = true
    } else if (st.groups.size === 1) {
      const g = [...st.groups][0]
      lines.push(`  class ${st.id} ${g}`)
    }
  }

  if (view?.colors) {
    for (const [g, style] of Object.entries(view.colors)) {
      lines.push(`  classDef ${g} ${style}`)
    }
  }
  if (hasBreaks) lines.push('  classDef breaks fill:#fee2e2,stroke:#dc2626,color:#7f1d1d')
  if (hasMayBreak) lines.push('  classDef mayBreak fill:#fef3c7,stroke:#d97706,color:#78350f')

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
