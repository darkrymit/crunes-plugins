import { http, section } from '@utils'
import { devMcpCall } from './transport.js'

export async function runGraphqlSchema(baseUrl) {
  const data = await devMcpCall(baseUrl, 'quarkus-smallrye-graphql_getGraphQLSchema')
  const schema = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
  return section.create('qdev-graphql-schema', { type: 'markdown', content: '```graphql\n' + schema + '\n```' })
}

export async function runGraphqlQuery(args, baseUrl) {
  const query = args.query
  if (!query) return section.create('qdev-graphql', { type: 'markdown', content: '**[Error]** Query string required.' })
  const endpoint = args.url ?? `${baseUrl}/graphql`
  const resp = await http.fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query }),
    timeout: 15000,
  })
  if (!resp.ok) throw new Error(`GraphQL endpoint returned HTTP ${resp.status}`)
  const json = await resp.json()
  if (json.errors?.length > 0) {
    const msgs = json.errors.map(e => e.message).join('\n')
    return section.create('qdev-graphql', { type: 'markdown', content: `**[GraphQL Errors]**\n\`\`\`\n${msgs}\n\`\`\`` })
  }
  return section.create('qdev-graphql', { type: 'markdown', content: '```json\n' + JSON.stringify(json.data, null, 2) + '\n```' })
}
