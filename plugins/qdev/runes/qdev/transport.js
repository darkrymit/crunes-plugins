import { http, vars, ws } from '@utils'

export function resolveBaseUrl() {
  return vars.read('qdev.baseUrl', 'http://localhost:8080')
}

export async function devMcpCall(baseUrl, toolName, toolArgs = {}) {
  const url = `${baseUrl}/q/dev-mcp`
  const body = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: toolName, arguments: toolArgs },
  })
  const resp = await http.fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body, timeout: 10000,
  })
  if (!resp.ok) throw new Error(`Dev MCP returned HTTP ${resp.status}`)
  const json = await resp.json()
  if (json.error) {
    const code = json.error.code
    const msg = json.error.message ?? '(no message)'
    // -32601 = method not found: the tool is either absent or registered but not
    // enabled-by-default over Dev MCP (needs @DevMCPEnableByDefault). Try the WS transport instead.
    const hint = code === -32601 ? ' -- not an enabled Dev MCP tool; use jsonRpcCall (WebSocket) instead' : ''
    throw new Error(`Dev MCP error for ${toolName} (${code}): ${msg}${hint}`)
  }
  if (json.result?.isError) {
    const text = json.result?.content?.[0]?.text ?? '(no message)'
    throw new Error(`Dev MCP tool error: ${text}`)
  }
  const text = json.result?.content?.[0]?.text
  if (text == null) throw new Error(`Dev MCP returned no content for ${toolName}`)
  try { return JSON.parse(text) } catch (_) { return text }
}

export async function jsonRpcCall(baseUrl, method, params = {}) {
  const wsUrl = `${baseUrl.replace(/^http/, 'ws')}/q/dev-ui/json-rpc-ws`
  const socket = ws.client(wsUrl)
  const id = 1

  let resolveDone, rejectDone
  const done = new Promise((res, rej) => { resolveDone = res; rejectDone = rej })
  let opened = false
  const tryClose = () => { if (opened) socket.close() }

  const timeoutHandle = setTimeout(() => {
    rejectDone(new Error(`Timeout waiting for response. Is the dev server running at ${baseUrl}?`))
    tryClose()
  }, 30000)

  socket.on('error', (err) => {
    clearTimeout(timeoutHandle)
    rejectDone(new Error(`Dev server not reachable at ${baseUrl}. Is it running? (${err})`))
    tryClose()
  })

  let result
  socket.on('message', (data) => {
    let msg
    try { msg = JSON.parse(data) } catch (_) { return }
    if (msg.id === id && msg.result !== undefined) {
      result = msg.result?.object ?? msg.result
      clearTimeout(timeoutHandle)
      resolveDone()
      tryClose()
    }
  })

  try {
    await socket.open()
    opened = true
  } catch (err) {
    clearTimeout(timeoutHandle)
    throw new Error(`Dev server not reachable at ${baseUrl}. Is it running? (${err})`)
  }

  socket.sendText(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
  await done
  return result
}
