import { section } from '@utils'
import { jsonRpcCall } from './transport.js'

export async function runCacheList(baseUrl) {
  const caches = await jsonRpcCall(baseUrl, 'quarkus-cache_getAll', {})
  if (!Array.isArray(caches) || caches.length === 0) {
    return section.create('qdev-cache', { type: 'markdown', content: 'No caches found.' })
  }
  const maxLen = Math.max(...caches.map(c => (c.name ?? '').length))
  const lines = caches.map(c => `${(c.name ?? '').padEnd(maxLen)}  ${c.size ?? 0} keys`)
  return section.create('qdev-cache', { type: 'markdown', content: '```\n' + lines.join('\n') + '\n```' })
}

export async function runCacheKeys(args, baseUrl) {
  const name = args.name
  if (!name) return section.create('qdev-cache', { type: 'markdown', content: '**[Error]** Cache name required.' })
  const keys = await jsonRpcCall(baseUrl, 'quarkus-cache_getKeys', { name })
  if (!Array.isArray(keys) || keys.length === 0) {
    return section.create('qdev-cache', { type: 'markdown', content: `Cache "${name}" is empty or not found.` })
  }
  return section.create('qdev-cache', { type: 'markdown', content: `**${keys.length} keys** in \`${name}\`\n\n\`\`\`\n${keys.join('\n')}\n\`\`\`` })
}

export async function runCacheClear(args, baseUrl) {
  const name = args.name
  if (!name) return section.create('qdev-cache', { type: 'markdown', content: '**[Error]** Cache name required. Usage: qdev cache clear <name>' })
  await jsonRpcCall(baseUrl, 'quarkus-cache_clear', { name })
  return section.create('qdev-cache', { type: 'markdown', content: `Cache \`${name}\` cleared.` })
}
