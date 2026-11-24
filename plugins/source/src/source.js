import { crypt, fs, os, shell } from '@utils'

export const TYPES = ['tiktok-channel', 'youtube-channel', 'git-repo', 'site', 'file']
export const SITE_MAX_AGE_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000
const ID_RE = /^[a-z0-9][a-z0-9-]*$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export class SourceUsageError extends Error {}
class UnstableListing extends Error {}

function q(arg) {
  const s = String(arg)
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

async function hasBin(bin) {
  const checkCmd = os.platform === 'win32' ? 'where.exe' : 'which'
  const res = await shell.exec(`${checkCmd} ${bin}`, { throw: false })
  return res.exitCode === 0 && Boolean(res.stdout.trim())
}

async function getYtDlpPrefix() {
  if (await hasBin('yt-dlp')) return 'yt-dlp'
  if (await hasBin('uvx')) return 'uvx yt-dlp'
  if (await hasBin('uv')) return 'uv run yt-dlp'
  return null
}

async function runCmd(cmd, args, opts = {}) {
  let prefix = cmd
  if (cmd === 'yt-dlp') {
    prefix = await getYtDlpPrefix()
    if (!prefix) throw new Error('yt-dlp not found on PATH or via uvx. Install yt-dlp or uv.')
  }
  const res = await shell.exec(`${prefix} ${args.map(q).join(' ')}`, { cwd: opts.cwd, throw: false })
  if (res.exitCode !== 0) {
    throw new Error(`${cmd} exited ${res.exitCode}: ${(res.stderr || res.stdout || '').trim()}`)
  }
  return res.stdout
}

const PROFILE_PLATFORMS = {
  tiktok: {
    match: /^https?:\/\/(www\.|m\.)?tiktok\.com\/@[\w.-]+\/?$/i,
    fromHandle: handle => `https://www.tiktok.com/@${handle}`,
  },
  youtube: {
    match: /^https?:\/\/(www\.|m\.)?youtube\.com\/(@[\w.-]+|channel\/[\w-]+)\/?$/i,
    fromHandle: handle => `https://www.youtube.com/@${handle}`,
  },
}

export function resolveProfile(input, platform) {
  const isUrl = /^https?:\/\//i.test(input)
  if (!isUrl) {
    if (!platform || !PROFILE_PLATFORMS[platform]) {
      return { error: `"${input}" is not a URL; pass a profile URL` }
    }
    const handle = input.replace(/^@/, '')
    return { platform, url: PROFILE_PLATFORMS[platform].fromHandle(handle) }
  }
  const found = Object.keys(PROFILE_PLATFORMS).find(p => PROFILE_PLATFORMS[p].match.test(input))
  if (!found) return { error: `unsupported URL: ${input}` }
  if (platform && platform !== found) return { error: `--platform ${platform} disagrees with URL` }
  return { platform: found, url: input }
}

export function flattenEntries(dump) {
  const rows = []
  for (const e of dump.entries || []) {
    if (!e || typeof e !== 'object') continue
    if (e._type === 'playlist' && Array.isArray(e.entries)) {
      rows.push(...flattenEntries(e))
      continue
    }
    rows.push({ id: e.id || null })
  }
  return rows
}

function today(now) {
  return now.toISOString().slice(0, 10)
}

export function tiktokPostDate(id) {
  return today(new Date(Number(BigInt(id) >> 32n) * 1000))
}

function dirname(p) {
  const clean = String(p || '').replace(/[/\\]+$/, '')
  const idx = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'))
  if (idx === -1) return '.'
  return idx === 0 ? clean.slice(0, 1) : clean.slice(0, idx)
}

function resolveRel(base, loc) {
  if (/^[a-zA-Z]:[/\\]/.test(loc) || loc.startsWith('/') || loc.startsWith('~')) return loc
  const cleanBase = base === '.' ? '' : base.replace(/[/\\]+$/, '')
  const cleanLoc = loc.replace(/^\.[\\/]/, '')
  return cleanBase ? `${cleanBase}/${cleanLoc}` : cleanLoc
}

export function validateSources(data, file) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.sources)) {
    throw new SourceUsageError(`${file} needs a "sources" array`)
  }
  const seen = new Set()
  data.sources.forEach((s, i) => {
    const where = `${file}: sources[${i}]`
    if (!s || typeof s !== 'object') throw new SourceUsageError(`${where} is not an object`)
    if (typeof s.id !== 'string' || !ID_RE.test(s.id)) {
      throw new SourceUsageError(`${where}: "id" must be lowercase letters, digits and dashes`)
    }
    if (seen.has(s.id)) throw new SourceUsageError(`${where}: id "${s.id}" is used twice`)
    seen.add(s.id)
    if (!TYPES.includes(s.type)) {
      throw new SourceUsageError(`${where} (${s.id}): "type" must be one of ${TYPES.join(', ')}`)
    }
    if (typeof s.location !== 'string' || !s.location.trim()) {
      throw new SourceUsageError(`${where} (${s.id}): "location" is required`)
    }
    const r = s.recorded
    if (r === undefined) return
    if (!r || typeof r !== 'object') throw new SourceUsageError(`${where} (${s.id}): "recorded" must be an object`)
    if (r.at !== undefined && (typeof r.at !== 'string' || !DATE_RE.test(r.at))) {
      throw new SourceUsageError(`${where} (${s.id}): "recorded.at" must be a date YYYY-MM-DD`)
    }
    if (r.newest !== undefined && typeof r.newest !== 'string') {
      throw new SourceUsageError(`${where} (${s.id}): "recorded.newest" must be a string id`)
    }
  })
}

const isRemoteUrl = loc => /^[a-z][a-z0-9+.-]*:\/\//i.test(loc) || /^[\w.-]+@[\w.-]+:/.test(loc)
const shortSha = sha => String(sha).slice(0, 7)

async function sha256Target(target) {
  const st = await fs.stat(target)
  if (st.isFile) return crypt.hashAsHex('sha256', await fs.read(target))
  const files = (await fs.glob('**/*', { cwd: target })).sort()
  const parts = []
  for (const rel of files) {
    const content = await fs.read(`${target.replace(/[/\\]+$/, '')}/${rel}`)
    parts.push(`${rel}\0${content}`)
  }
  return crypt.hashAsHex('sha256', parts.join(''))
}

async function lsRemoteHead(url, cwd) {
  const out = await runCmd('git', ['ls-remote', url, 'HEAD'], cwd ? { cwd } : {})
  const sha = (out.split(/\s+/)[0] || '').trim()
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`no HEAD at ${url}`)
  return sha
}

async function readNow(source, { base, now, recorded }) {
  if (source.type === 'tiktok-channel' || source.type === 'youtube-channel') {
    const platform = source.type === 'tiktok-channel' ? 'tiktok' : 'youtube'
    const resolved = resolveProfile(source.location, platform)
    if (resolved.error) throw new SourceUsageError(`${source.id}: ${resolved.error}`)
    const listOnce = async () => {
      const dump = JSON.parse(await runCmd('yt-dlp', ['--flat-playlist', '--no-warnings', '-J', resolved.url]))
      const ids = flattenEntries(dump).map(r => r.id).filter(Boolean)
      let newest = ids[0] || null
      if (platform === 'tiktok') {
        for (const id of ids) if (BigInt(id) > BigInt(newest)) newest = id
      }
      const idsSha256 = crypt.hashAsHex('sha256', [...ids].sort().join('\n'))
      return { count: ids.length, newest, ids_sha256: idsSha256 }
    }
    let best = await listOnce()
    if (recorded && best.newest === recorded.newest && best.count < recorded.count) {
      const seen = [best.count]
      for (let i = 0; i < 2 && best.count < recorded.count; i++) {
        const next = await listOnce()
        seen.push(next.count)
        if (next.count > best.count) best = next
      }
      if (best.count < recorded.count && new Set(seen).size > 1) {
        throw new UnstableListing(
          `listings disagree (${seen.join(', ')} videos; recorded ${recorded.count}): the platform returned partial lists`
        )
      }
    }
    return best
  }

  if (source.type === 'git-repo') {
    if (isRemoteUrl(source.location)) {
      return { commit: await lsRemoteHead(source.location), against: 'upstream' }
    }
    const repo = resolveRel(base, source.location)
    if (!(await fs.exists(repo))) throw new Error(`${source.location} not found`)
    const remotes = (await runCmd('git', ['-C', repo, 'remote'])).split(/\r?\n/).filter(Boolean)
    if (remotes.length) {
      const remote = remotes.includes('origin') ? 'origin' : remotes[0]
      const url = (await runCmd('git', ['-C', repo, 'remote', 'get-url', remote])).trim()
      return { commit: await lsRemoteHead(url, repo), against: 'upstream' }
    }
    return { commit: (await runCmd('git', ['-C', repo, 'rev-parse', 'HEAD'])).trim(), against: 'local' }
  }

  if (source.type === 'site') {
    return { at: today(now) }
  }

  if (source.type === 'file') {
    const target = resolveRel(base, source.location)
    if (!(await fs.exists(target))) throw new Error(`${source.location} not found`)
    return { sha256: await sha256Target(target) }
  }

  throw new SourceUsageError(`unknown type ${source.type}`)
}

function describeChannel(source, v) {
  const when = source.type === 'tiktok-channel' && v.newest ? tiktokPostDate(v.newest) : v.newest || 'none'
  return `${v.count} videos, newest ${when}`
}

export function compareSource(source, recorded, now, clock) {
  switch (source.type) {
    case 'tiktok-channel':
    case 'youtube-channel': {
      if (recorded.count !== now.count || recorded.newest !== now.newest) {
        return { moved: true, detail: `${describeChannel(source, recorded)} → ${describeChannel(source, now)}` }
      }
      if (recorded.ids_sha256 !== now.ids_sha256) {
        return { moved: true, detail: `${describeChannel(source, now)}; set changed (a video hidden or added back)` }
      }
      return { moved: false, detail: describeChannel(source, now) }
    }
    case 'git-repo': {
      if (recorded.commit !== now.commit) {
        return { moved: true, detail: `${shortSha(recorded.commit)} → ${shortSha(now.commit)} (${now.against})` }
      }
      return { moved: false, detail: `${shortSha(now.commit)} (${now.against})` }
    }
    case 'site': {
      const ageDays = Math.floor((clock.getTime() - Date.parse(`${recorded.at}T00:00:00Z`)) / DAY_MS)
      if (ageDays > SITE_MAX_AGE_DAYS) {
        return { moved: true, detail: `last checked ${recorded.at} (${ageDays}d ago, >${SITE_MAX_AGE_DAYS}d)` }
      }
      return { moved: false, detail: `checked ${recorded.at} (${ageDays}d ago)` }
    }
    case 'file': {
      if (recorded.sha256 !== now.sha256) {
        return { moved: true, detail: `${recorded.sha256.slice(0, 12)} → ${now.sha256.slice(0, 12)}` }
      }
      return { moved: false, detail: now.sha256.slice(0, 12) }
    }
    default:
      throw new SourceUsageError(`unknown type ${source.type}`)
  }
}

function describeNow(source, now) {
  switch (source.type) {
    case 'tiktok-channel':
    case 'youtube-channel':
      return describeChannel(source, now)
    case 'git-repo':
      return `${shortSha(now.commit)} (${now.against})`
    case 'site':
      return 'first check: fetch and save'
    default:
      return now.sha256.slice(0, 12)
  }
}

function pick(data, id) {
  if (!id) return data.sources
  const found = data.sources.filter(s => s.id === id)
  if (!found.length) throw new SourceUsageError(`no source with id "${id}"`)
  return found
}

async function loadSourcesFile(file) {
  if (!(await fs.exists(file))) throw new Error(`sources file not found: ${file}`)
  let data
  try {
    data = JSON.parse(await fs.read(file))
  } catch (err) {
    throw new SourceUsageError(`${file} is not valid JSON: ${err.message}`)
  }
  validateSources(data, file)
  return data
}

export async function checkSources(file, { id, now = new Date() } = {}) {
  const data = await loadSourcesFile(file)
  const base = dirname(file)
  const rows = []
  for (const source of pick(data, id)) {
    const recorded = source.recorded || null
    const row = { id: source.id, type: source.type, recorded, now: null }
    try {
      if (source.type === 'site') {
        if (!recorded || !recorded.at) {
          rows.push({ ...row, status: 'new', detail: describeNow(source) })
          continue
        }
        row.now = { at: recorded.at }
        const c = compareSource(source, recorded, row.now, now)
        rows.push({ ...row, status: c.moved ? 'moved' : 'same', detail: c.detail })
        continue
      }
      row.now = await readNow(source, { base, now, recorded })
      if (!recorded) {
        rows.push({ ...row, status: 'new', detail: describeNow(source, row.now) })
        continue
      }
      const c = compareSource(source, recorded, row.now, now)
      rows.push({ ...row, status: c.moved ? 'moved' : 'same', detail: c.detail })
    } catch (err) {
      if (err instanceof SourceUsageError) throw err
      rows.push({ ...row, status: err instanceof UnstableListing ? 'unstable' : 'error', detail: err.message })
    }
  }
  return rows
}

export async function recordSources(file, { id, now = new Date() } = {}) {
  const data = await loadSourcesFile(file)
  const base = dirname(file)
  const rows = []
  for (const source of pick(data, id)) {
    try {
      const current = source.type === 'site' ? {} : await readNow(source, { base, now, recorded: source.recorded })
      source.recorded = { at: today(now), ...current }
      rows.push({
        id: source.id,
        type: source.type,
        status: 'recorded',
        recorded: source.recorded,
        now: current,
        detail: describeNow(source, source.recorded),
      })
    } catch (err) {
      if (err instanceof SourceUsageError) throw err
      const status = err instanceof UnstableListing ? 'unstable' : 'error'
      rows.push({ id: source.id, type: source.type, status, recorded: source.recorded || null, now: null, detail: err.message })
    }
  }
  await fs.write(file, `${JSON.stringify(data, null, 2)}\n`)
  return rows
}
