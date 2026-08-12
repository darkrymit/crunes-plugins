import { section } from '@utils'
import { devMcpCall } from './transport.js'

export async function runLogLevel(args, baseUrl) {
  const loggerName = args.logger
  const levelToSet = args.level
  if (!loggerName || !levelToSet) {
    return section.create('qdev-log-level', { type: 'markdown', content: '**[Error]** Usage: qdev log-level <logger> <level>' })
  }
  await devMcpCall(baseUrl, 'devui-logstream_updateLogLevel', { loggerName, levelToSet })
  return section.create('qdev-log-level', { type: 'markdown', content: `Log level for \`${loggerName}\` set to \`${levelToSet}\`.` })
}
