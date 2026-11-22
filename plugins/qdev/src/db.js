import { section } from '@utils'
import { devMcpCall } from './transport.js'

async function resolveDataSource(args, baseUrl) {
  if (args.datasource) return args.datasource
  const sources = await devMcpCall(baseUrl, 'quarkus-agroal_getDataSources') ?? []
  if (sources.length === 1) return sources[0].name ?? sources[0]
  if (sources.length === 0) throw new Error('No datasources found.')
  const names = sources.map(s => s.name ?? s).join(', ')
  throw new Error(`Multiple datasources found: ${names}. Specify one with --datasource.`)
}

export async function runDbSources(baseUrl) {
  const sources = await devMcpCall(baseUrl, 'quarkus-agroal_getDataSources') ?? []
  if (sources.length === 0) return section.create('qdev-db', { type: 'markdown', content: 'No datasources found.' })
  const lines = sources.map(s => s.name ?? JSON.stringify(s))
  return section.create('qdev-db', { type: 'markdown', content: '```\n' + lines.join('\n') + '\n```' })
}

export async function runDbTables(args, baseUrl) {
  const datasource = await resolveDataSource(args, baseUrl)
  const tables = await devMcpCall(baseUrl, 'quarkus-agroal_getTables', { datasource }) ?? []
  if (tables.length === 0) return section.create('qdev-db', { type: 'markdown', content: `No tables found in \`${datasource}\`.` })
  return section.create('qdev-db', { type: 'markdown', content: `**${tables.length} tables** in \`${datasource}\`\n\n\`\`\`\n${tables.join('\n')}\n\`\`\`` })
}

export async function runDbSql(args, baseUrl) {
  const sql = args.query
  if (!sql) return section.create('qdev-db', { type: 'markdown', content: '**[Error]** SQL query required.' })
  const datasource = await resolveDataSource(args, baseUrl)
  const pageNumber = parseInt(args.page ?? '0', 10)
  const pageSize = parseInt(args.size ?? '20', 10)
  const data = await devMcpCall(baseUrl, 'quarkus-agroal_executeSQL', { datasource, sql, pageNumber, pageSize })
  const rows = data?.results ?? data?.rows ?? data ?? []
  if (!Array.isArray(rows) || rows.length === 0) {
    return section.create('qdev-db', { type: 'markdown', content: 'Query returned no rows.' })
  }
  return section.create('qdev-db', { type: 'markdown', content: '```json\n' + JSON.stringify(rows, null, 2) + '\n```' })
}
