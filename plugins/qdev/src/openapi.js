import { section } from '@utils'
import { devMcpCall } from './transport.js'

export async function runOpenapi(baseUrl) {
  const data = await devMcpCall(baseUrl, 'quarkus-smallrye-openapi_getOpenAPISchema')
  const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
  return section.create('qdev-openapi', { type: 'markdown', content: '```json\n' + content + '\n```' })
}
