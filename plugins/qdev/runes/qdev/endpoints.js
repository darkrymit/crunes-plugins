import { section } from '@utils'
import { devMcpCall } from './transport.js'

export async function runEndpoints(baseUrl) {
  const data = await devMcpCall(baseUrl, 'devui-endpoints_getAllEndpoints')
  const endpoints = Array.isArray(data) ? data : (data?.endpoints ?? data?.value ?? [])
  if (endpoints.length === 0) {
    return section.create('qdev-endpoints', { type: 'markdown', content: 'No endpoints found.' })
  }
  const lines = endpoints.map(e => {
    const method = (e.httpMethod ?? e.method ?? '').padEnd(7)
    const path = e.uri ?? e.path ?? e.url ?? ''
    const handler = e.className ?? e.handler ?? ''
    return handler ? `${method}  ${path}  (${handler})` : `${method}  ${path}`
  })
  return section.create('qdev-endpoints', { type: 'markdown', content: `**${endpoints.length} endpoints**\n\n\`\`\`\n${lines.join('\n')}\n\`\`\`` })
}
