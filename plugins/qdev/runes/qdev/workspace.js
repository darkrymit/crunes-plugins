import { section } from '@utils'
import { devMcpCall } from './transport.js'

export async function runWorkspaceList(baseUrl) {
  const items = await devMcpCall(baseUrl, 'devui-workspace_getWorkspaceItems') ?? []
  if (!Array.isArray(items) || items.length === 0) {
    return section.create('qdev-workspace', { type: 'markdown', content: 'No workspace items found.' })
  }
  return section.create('qdev-workspace', { type: 'markdown', content: '```\n' + items.join('\n') + '\n```' })
}

export async function runWorkspaceGet(args, baseUrl) {
  const path = args.path
  if (!path) return section.create('qdev-workspace', { type: 'markdown', content: '**[Error]** Path required.' })
  const data = await devMcpCall(baseUrl, 'devui-workspace_getWorkspaceItemContent', { path })
  const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
  return section.create('qdev-workspace', { type: 'markdown', content: '```\n' + content + '\n```' })
}

export async function runWorkspaceSet(args, baseUrl) {
  const path = args.path
  const content = args.content
  if (!path || content == null) return section.create('qdev-workspace', { type: 'markdown', content: '**[Error]** Path and content required.' })
  await devMcpCall(baseUrl, 'devui-workspace_saveWorkspaceItemContent', { path, content })
  return section.create('qdev-workspace', { type: 'markdown', content: `Workspace item \`${path}\` saved.` })
}
