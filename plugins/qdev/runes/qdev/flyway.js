import { section } from '@utils'
import { jsonRpcCall } from './transport.js'

export async function runFlywayStatus(baseUrl) {
  const data = await jsonRpcCall(baseUrl, 'quarkus-flyway_getDatasources', {})
  const sources = Array.isArray(data) ? data : (data ? [data] : [])
  if (sources.length === 0) {
    return section.create('qdev-flyway', { type: 'markdown', content: 'No Flyway datasources found.' })
  }
  const lines = sources.map(ds => {
    const name = ds.name ?? '<default>'
    const hasMigrations = ds.hasMigrations ? 'yes' : 'no'
    return `${name}  hasMigrations=${hasMigrations}`
  })
  return section.create('qdev-flyway', { type: 'markdown', content: '```\n' + lines.join('\n') + '\n```' })
}

export async function runFlywayMigrate(baseUrl) {
  const data = await jsonRpcCall(baseUrl, 'quarkus-flyway_migrate', { ds: '<default>' })
  if (!data) return section.create('qdev-flyway', { type: 'markdown', content: '**[Error]** No response from flyway migrate.' })
  if (data.type === 'error') {
    return section.create('qdev-flyway', { type: 'markdown', content: `**[Error]** Flyway migrate failed: ${data.message ?? '(no message)'}` })
  }
  const applied = data.number ?? 0
  const msg = applied === 0 ? 'Already up to date.' : `Migrations applied: ${applied}`
  const warnings = (data.warnings ?? []).length > 0 ? `\n\nWarnings:\n${data.warnings.join('\n')}` : ''
  return section.create('qdev-flyway', { type: 'markdown', content: `${msg}${warnings}` })
}
