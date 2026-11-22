import { section } from '@utils'
import { devMcpCall, jsonRpcCall } from './transport.js'

export async function runSchedulerList(baseUrl) {
  const data = await devMcpCall(baseUrl, 'quarkus-scheduler_getData')
  const methods = data?.methods ?? []
  const rows = []
  for (const m of methods) {
    for (const s of (m.schedules ?? [])) {
      const expr = s.cron ?? s.cronConfig ?? s.every ?? ''
      const running = s.running ? 'running' : 'idle   '
      rows.push({ identity: s.identity ?? '', expr, running })
    }
  }
  if (rows.length === 0) {
    const state = data?.schedulerRunning ? '(scheduler running, no jobs)' : '(scheduler stopped)'
    return section.create('qdev-scheduler', { type: 'markdown', content: `No scheduled jobs found. ${state}` })
  }
  const maxIdLen = Math.max(...rows.map(r => r.identity.length))
  const maxExprLen = Math.max(...rows.map(r => r.expr.length))
  const lines = rows.map(r => `${r.identity.padEnd(maxIdLen)}  ${r.expr.padEnd(maxExprLen)}  ${r.running}`)
  return section.create('qdev-scheduler', { type: 'markdown', content: '```\n' + lines.join('\n') + '\n```' })
}

export async function runSchedulerRun(args, baseUrl) {
  const identity = args.job
  if (!identity) return section.create('qdev-scheduler', { type: 'markdown', content: '**[Error]** Job identity required.' })
  await devMcpCall(baseUrl, 'quarkus-scheduler_executeJob', { identity })
  return section.create('qdev-scheduler', { type: 'markdown', content: `Job \`${identity}\` triggered.` })
}

export async function runSchedulerPause(args, baseUrl) {
  const identity = args.job
  if (!identity) return section.create('qdev-scheduler', { type: 'markdown', content: '**[Error]** Job identity required.' })
  await devMcpCall(baseUrl, 'quarkus-scheduler_pauseJob', { identity })
  return section.create('qdev-scheduler', { type: 'markdown', content: `Job \`${identity}\` paused.` })
}

export async function runSchedulerResume(args, baseUrl) {
  const identity = args.job
  if (!identity) return section.create('qdev-scheduler', { type: 'markdown', content: '**[Error]** Job identity required.' })
  await devMcpCall(baseUrl, 'quarkus-scheduler_resumeJob', { identity })
  return section.create('qdev-scheduler', { type: 'markdown', content: `Job \`${identity}\` resumed.` })
}

export async function runSchedulerPauseAll(baseUrl) {
  await jsonRpcCall(baseUrl, 'quarkus-scheduler_pauseScheduler', {})
  return section.create('qdev-scheduler', { type: 'markdown', content: 'All scheduled jobs paused.' })
}

export async function runSchedulerResumeAll(baseUrl) {
  await jsonRpcCall(baseUrl, 'quarkus-scheduler_resumeScheduler', {})
  return section.create('qdev-scheduler', { type: 'markdown', content: 'All scheduled jobs resumed.' })
}
