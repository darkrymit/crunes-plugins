import { section } from '@utils'
import { devMcpCall } from './transport.js'

export async function runDevServices(baseUrl) {
  const data = await devMcpCall(baseUrl, 'devui-dev-services_getDevServices')
  const services = Array.isArray(data) ? data : (data?.devServices ?? data?.services ?? [])
  if (services.length === 0) {
    return section.create('qdev-dev-services', { type: 'markdown', content: 'No dev services running.' })
  }
  const lines = services.map(s => {
    const name = s.name ?? s.serviceName ?? '?'
    const type = s.type ?? ''
    const config = s.config ?? s.connectionDetails ?? ''
    return type ? `${name}  [${type}]${config ? `  ${JSON.stringify(config)}` : ''}` : name
  })
  return section.create('qdev-dev-services', { type: 'markdown', content: `**${services.length} dev services**\n\n\`\`\`\n${lines.join('\n')}\n\`\`\`` })
}
