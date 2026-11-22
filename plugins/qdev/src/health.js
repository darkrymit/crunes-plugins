import { section } from '@utils'
import { devMcpCall } from './transport.js'

export async function runHealth(baseUrl) {
  const data = await devMcpCall(baseUrl, 'quarkus-smallrye-health_getHealth')
  const overall = data?.status ?? 'UNKNOWN'
  const checks = data?.payload?.checks ?? []
  const checkLines = checks.map(c => {
    const status = (c.status?.string ?? c.status ?? 'UNKNOWN').padEnd(4)
    const name = c.name?.string ?? c.name ?? ''
    return `${status}  ${name}`
  })
  const degraded = (overall === 'DOWN' || overall === 'OUT_OF_SERVICE') ? '**[DEGRADED]** ' : ''
  const body = checkLines.length > 0 ? `\n\n${checkLines.join('\n')}` : ''
  return section.create('qdev-health', { type: 'markdown', content: `${degraded}Status: ${overall}${body}` })
}
