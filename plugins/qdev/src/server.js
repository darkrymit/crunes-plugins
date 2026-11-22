import { shell, cache, http, vars, section } from '@utils'

const CACHE_LOCATION = '@local-cache'
const CACHE_NAME = 'qdev-server'

function buildMvnwCommand(profile) {
  return `mvnw quarkus:dev -Dquarkus.console.basic=true -Dquarkus.profile=$${profile}`
}

async function getCache() {
  return cache.open(CACHE_LOCATION, CACHE_NAME)
}

async function resolveServerState(baseUrl) {
  const c = await getCache()
  const jobId = await c.get('jobId')
  const startedAt = await c.get('startedAt')

  if (jobId) {
    const alive = await shell.job.exists(jobId)
    if (alive) return { state: 'alive', jobId, startedAt }
    return { state: 'crashed', jobId, startedAt }
  }

  try {
    const res = await http.fetch(`${baseUrl}/q/health`, { method: 'GET' })
    if (res.ok) return { state: 'external' }
  } catch (_) {}

  return { state: 'stopped' }
}

function uptime(startedAt) {
  if (!startedAt) return 'unknown'
  const ms = Date.now() - startedAt
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  if (h > 0) return `${h}h ${m % 60}m`
  if (m > 0) return `${m}m ${s % 60}s`
  return `${s}s`
}

function formatLogs(stdout, stderr, limit = 20) {
  const out = stdout.trim().split('\n').filter(Boolean).slice(-limit).join('\n')
  const err = stderr ? stderr.trim().split('\n').filter(Boolean).slice(-10).join('\n') : ''
  return out + (err ? `\n\n**stderr:**\n\`\`\`\n${err}\n\`\`\`` : '')
}

async function startJob(profile) {
  const c = await getCache()
  await c.delete('jobId')
  await c.delete('startedAt')
  const { id } = await shell.job.start(buildMvnwCommand(profile), { repl: true })
  await c.set('jobId', id)
  await c.set('startedAt', Date.now())
  return id
}

async function clearCache() {
  const c = await getCache()
  await c.delete('jobId')
  await c.delete('startedAt')
}

export async function runServerStatus(baseUrl) {
  const { state, jobId, startedAt } = await resolveServerState(baseUrl)

  let content
  if (state === 'alive') {
    const stdout = await shell.job.stdout(jobId)
    const lines = stdout.trim().split('\n').filter(Boolean).slice(-20).join('\n')
    content = `**status:** running (managed)\n**uptime:** ${uptime(startedAt)}\n\n\`\`\`\n${lines}\n\`\`\``
  } else if (state === 'external') {
    content = '**status:** running externally (not managed by qdev)'
  } else if (state === 'crashed') {
    const stdout = await shell.job.stdout(jobId)
    const stderr = await shell.job.stderr(jobId)
    content = `**status:** crashed — was managed but process is gone\n\n\`\`\`\n${formatLogs(stdout, stderr)}\n\`\`\``
  } else {
    content = '**status:** stopped'
  }

  return section.create('qdev-server-status', { type: 'markdown', content })
}

export async function runServerStart(baseUrl) {
  const { state } = await resolveServerState(baseUrl)

  if (state === 'alive') {
    return section.create('qdev-server', { type: 'markdown', content: '**[Error]** Server is already running (managed by qdev).' })
  }
  if (state === 'external') {
    return section.create('qdev-server', { type: 'markdown', content: '**[Error]** Server is running externally — not managed by qdev. Stop it manually first.' })
  }

  const profile = vars.read('qdev.server.profile', 'dev,ollama')
  const id = await startJob(profile)

  return section.create('qdev-server', { type: 'markdown', content: `**Server starting** (job: ${id})\nProfile: \`${profile}\`\n\nUse \`qdev server status\` to check progress.` })
}

export async function runServerStop(baseUrl) {
  const { state, jobId } = await resolveServerState(baseUrl)

  if (state === 'external') {
    return section.create('qdev-server', { type: 'markdown', content: '**[Warn]** Server appears to be running externally — cannot stop it via qdev.' })
  }
  if (state === 'stopped' || state === 'crashed') {
    await clearCache()
    return section.create('qdev-server', { type: 'markdown', content: '**[Error]** Server is not running.' })
  }

  await shell.job.kill(jobId)
  await clearCache()

  return section.create('qdev-server', { type: 'markdown', content: '**Server stopped.**' })
}

export async function runServerRestart(baseUrl) {
  const { state, jobId } = await resolveServerState(baseUrl)

  if (state === 'external') {
    return section.create('qdev-server', { type: 'markdown', content: '**[Error]** Server is running externally — cannot restart via qdev.' })
  }

  if (state === 'alive') {
    await shell.job.kill(jobId)
  }

  const profile = vars.read('qdev.server.profile', 'dev,ollama')
  const id = await startJob(profile)

  return section.create('qdev-server', { type: 'markdown', content: `**Server restarting** (job: ${id})\nProfile: \`${profile}\`` })
}

export async function runServerReload(baseUrl) {
  const { state, jobId } = await resolveServerState(baseUrl)

  if (state !== 'alive') {
    return section.create('qdev-server', { type: 'markdown', content: '**[Error]** Server is not running (managed).' })
  }

  await shell.job.write(jobId, 's\n')

  return section.create('qdev-server', { type: 'markdown', content: '**Reload triggered.** Hot reload will activate on next request.' })
}
