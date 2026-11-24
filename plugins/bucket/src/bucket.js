import { fs, os, shell } from '@utils'

const isWin = () => os.platform === 'win32'

async function safeStat(p) {
  try {
    return await fs.stat(p)
  } catch {
    return null
  }
}

async function readHead(p, lines) {
  return (await fs.read(p, { from: 1, to: lines, throw: false })) || ''
}

async function previewDir(dir) {
  const files = await fs.glob('**/*', { cwd: dir })
  let bytes = 0
  for (const f of files.slice(0, 1000)) {
    try {
      const st = await fs.stat(`${dir}/${f}`)
      if (st && st.isFile) bytes += st.size
    } catch {}
  }
  return { files: files.length, bytes, capped: false }
}

async function gitExec(dir, args) {
  const res = await shell.exec(`git -C "${dir}" ${args.join(' ')}`, { throw: false })
  return res.exitCode === 0 ? res.stdout.trim() : null
}

async function gitInit(dir) {
  const res = await shell.exec(`git -C "${dir}" init -q`, { throw: false })
  if (res.exitCode !== 0) throw new Error(`git init failed in ${dir}`)
}

async function gitState(dir) {
  if (!(await fs.exists(`${dir}/.git`))) return null
  const porcelain = await gitExec(dir, ['status', '--porcelain'])
  const unpushed = await gitExec(dir, ['rev-list', '--count', '--branches', '--not', '--remotes'])
  return {
    branch: await gitExec(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
    remote: await gitExec(dir, ['remote', 'get-url', 'origin']),
    dirty: porcelain ? porcelain.split('\n').length : 0,
    unpushed: Number(unpushed) || 0,
  }
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/
const SUMMARY_MAX = 300
const SWEEP_BATCH = 50
const SHOWN_CHECK = 100
export const GONE_TTL_MS = 30 * 24 * 60 * 60 * 1000

export function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '') || '/'
}

function basename(p) {
  const clean = normalizePath(p)
  const idx = clean.lastIndexOf('/')
  return idx === -1 ? clean : clean.slice(idx + 1)
}

function joinPath(a, b) {
  return `${normalizePath(a)}/${String(b || '').replace(/^\/+/, '')}`
}

function samePath(a, b, isWin) {
  return isWin ? a.toLowerCase() === b.toLowerCase() : a === b
}

export function toId(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-._]+|-+$/g, '')
}

function assertId(id) {
  if (!ID_PATTERN.test(id)) {
    throw new Error(`invalid bucket id "${id}": use lowercase letters, digits, ".", "_" or "-"`)
  }
}

function uniqueLabels(labels = []) {
  return [...new Set(labels.map(toId).filter(Boolean))]
}

export function parseReadme(text) {
  let title = ''
  const para = []
  let inFence = false
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('```')) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const heading = line.match(/^#{1,6}\s+(.*)$/)
    if (heading) {
      if (!title) title = heading[1].replace(/[#*_`]/g, '').trim()
      if (para.length) break
      continue
    }
    if (!line) {
      if (para.length) break
      continue
    }
    if (/^(<|!\[|\[!\[|---|===|>\s*\[!)/.test(line)) continue
    para.push(line.replace(/^>\s*/, ''))
  }
  let summary = para.join(' ').replace(/\s+/g, ' ').trim()
  if (summary.length > SUMMARY_MAX) summary = summary.slice(0, SUMMARY_MAX - 1).trimEnd() + '…'
  return { title, summary }
}

async function readReadmeInfo(dir) {
  const candidates = ['README.md', 'readme.md', 'README.markdown', 'README.txt', 'README.rst']
  for (const hit of candidates) {
    const full = joinPath(dir, hit)
    const st = await safeStat(full)
    if (st && st.isFile) {
      const text = await readHead(full, 500)
      return { ...parseReadme(text), stamp: { file: hit, mtimeMs: st.mtimeMs, size: st.size } }
    }
  }
  return { title: '', summary: '', stamp: null }
}

function sameStamp(a, b) {
  if (!a || !b) return a === b
  return a.file === b.file && a.mtimeMs === b.mtimeMs && a.size === b.size
}

async function checkBucket(reg, b) {
  const st = await safeStat(b.path)
  if (!st || !st.isDirectory) {
    if (!b.goneSince) {
      b.goneSince = reg.now
      reg.dirty = true
    }
    return false
  }
  if (b.goneSince) {
    delete b.goneSince
    reg.dirty = true
  }
  const next = await readReadmeInfo(b.path)
  if (!sameStamp(next.stamp, b.readme ? b.readme.stamp : null)) {
    b.readme = next
    reg.dirty = true
  }
  return true
}

async function sweep(reg) {
  const all = reg.data.buckets
  const before = all.length
  reg.data.buckets = all.filter(b => !(b.goneSince && reg.now - b.goneSince > GONE_TTL_MS))
  if (reg.data.buckets.length !== before) reg.dirty = true

  const list = reg.data.buckets
  if (!list.length) return
  const start = reg.data.sweep % list.length
  const count = Math.min(SWEEP_BATCH, list.length)
  for (let i = 0; i < count; i++) await checkBucket(reg, list[(start + i) % list.length])
  reg.data.sweep = (start + count) % list.length
  reg.dirty = true
}

async function shown(reg, buckets) {
  const out = []
  for (let i = 0; i < buckets.length; i++) {
    if (i >= SHOWN_CHECK || (await checkBucket(reg, buckets[i]))) {
      out.push(buckets[i])
    }
  }
  return out
}

function visible(reg, labels = []) {
  const need = uniqueLabels(labels)
  return reg.data.buckets.filter(b => !b.goneSince && need.every(l => b.labels.includes(l)))
}

function byId(reg, id) {
  return reg.data.buckets.find(b => b.id === id)
}

async function requireVisible(reg, id) {
  const b = byId(reg, toId(id))
  if (!b || !(await checkBucket(reg, b))) throw new Error(`no bucket "${id}"`)
  return b
}

function assertFreeId(reg, id, flag) {
  assertId(id)
  const taken = byId(reg, id)
  if (taken) {
    throw new Error(`id "${id}" is taken (${taken.path}${taken.goneSince ? ', folder gone' : ''}); pass ${flag} <name>`)
  }
}

export async function withRegistry(registryFile, fn, now = Date.now()) {
  let data = { sweep: 0, buckets: [] }
  if (await fs.exists(registryFile)) {
    data = JSON.parse(await fs.read(registryFile))
    if (!data || !Array.isArray(data.buckets)) {
      throw new Error(`${registryFile} is not a bucket registry`)
    }
    data.sweep = Number.isInteger(data.sweep) ? data.sweep : 0
  }
  const reg = { data, now, dirty: false }
  await sweep(reg)
  const result = await fn(reg)
  if (reg.dirty) {
    await fs.write(registryFile, JSON.stringify(reg.data, null, 2) + '\n')
  }
  return result
}

export async function registerBucket(reg, { dir, id, labels = [] }) {
  const abs = normalizePath(await fs.resolve(dir))
  const st = await safeStat(abs)
  if (!st || !st.isDirectory) throw new Error(`not a folder: ${abs}`)

  const own = reg.data.buckets.find(b => samePath(b.path, abs, isWin()))
  if (own) {
    if (!own.goneSince) throw new Error(`already registered as "${own.id}": ${abs}`)
    own.labels = uniqueLabels([...own.labels, ...labels])
    await checkBucket(reg, own)
    return own
  }

  const bucketId = id ? toId(id) : toId(basename(abs))
  assertFreeId(reg, bucketId, '--id')
  const entry = {
    id: bucketId,
    path: abs,
    labels: uniqueLabels(labels),
    readme: await readReadmeInfo(abs),
  }
  reg.data.buckets.push(entry)
  reg.dirty = true
  return entry
}

export async function createBucket(reg, { id, parent, defaultRoot, git, labels = [] }) {
  const bucketId = toId(id)
  assertFreeId(reg, bucketId, 'another id')
  const rootAbs = normalizePath(await fs.resolve(parent || defaultRoot))
  const dir = joinPath(rootAbs, bucketId)
  if (await fs.exists(dir)) {
    throw new Error(`folder exists, register it with: crunes -p run bucket register ${dir}`)
  }
  await fs.mkdir(dir)
  if (git) {
    await gitInit(dir)
  }
  return registerBucket(reg, { dir, id: bucketId, labels })
}

export function deregisterBucket(reg, id) {
  const key = toId(id)
  const i = reg.data.buckets.findIndex(b => b.id === key)
  if (i < 0) throw new Error(`no bucket "${id}"`)
  reg.dirty = true
  return reg.data.buckets.splice(i, 1)[0]
}

export async function renameBucket(reg, id, newId) {
  const b = await requireVisible(reg, id)
  const next = toId(newId)
  assertFreeId(reg, next, 'another id')
  b.id = next
  reg.dirty = true
  return b
}

export async function relabelBucket(reg, id, { add = [], remove = [] }) {
  const b = await requireVisible(reg, id)
  const drop = new Set(uniqueLabels(remove))
  b.labels = uniqueLabels([...b.labels, ...add]).filter(l => !drop.has(l))
  reg.dirty = true
  return b
}

export function labelCounts(reg) {
  const counts = new Map()
  for (const b of visible(reg)) for (const l of b.labels) counts.set(l, (counts.get(l) || 0) + 1)
  return [...counts].map(([label, count]) => ({ label, count })).sort((a, b) => a.label.localeCompare(b.label))
}

export async function resolveBucket(reg, name, labels = []) {
  const key = toId(name)
  const pool = visible(reg, labels)
  const hit = pool.filter(b => b.id === key)
  if (hit.length) return shown(reg, hit)
  return shown(reg, pool.filter(b => b.labels.includes(key)))
}

export async function listBuckets(reg, labels = []) {
  return shown(reg, visible(reg, labels).sort((a, b) => a.id.localeCompare(b.id)))
}

export async function searchBuckets(reg, query, limit = 20, labels = []) {
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  const scored = []
  for (const b of visible(reg, labels)) {
    const title = ((b.readme && b.readme.title) || '').toLowerCase()
    const summary = ((b.readme && b.readme.summary) || '').toLowerCase()
    let score = 0
    let all = true
    for (const w of words) {
      let s = 0
      if (b.id === w) s = 100
      else if (b.labels.includes(w)) s = 60
      else if (b.id.includes(w)) s = 40
      else if (title.includes(w)) s = 20
      else if (summary.includes(w)) s = 5
      if (!s) {
        all = false
        break
      }
      score += s
    }
    if (all) scored.push({ b, score })
  }
  scored.sort((x, y) => y.score - x.score || x.b.id.localeCompare(y.b.id))
  return shown(reg, scored.slice(0, limit).map(s => s.b))
}

export async function infoBucket(reg, id) {
  const b = await requireVisible(reg, id)
  return { ...b, git: await gitState(b.path) }
}

export async function deleteBucketPlan(reg, id) {
  const b = await requireVisible(reg, id)
  const abs = normalizePath(b.path)
  const home = normalizePath(await fs.resolve('~'))
  if (abs === '/' || /^[a-zA-Z]:$/.test(abs) || samePath(abs, home, isWin())) {
    throw new Error(`refusing to delete ${b.path}: a drive root or the home folder`)
  }
  const g = await gitState(b.path)
  if (g && g.dirty) throw new Error(`refusing to delete ${b.id}: ${g.dirty} uncommitted change(s) in ${b.path}`)
  if (g && g.unpushed) throw new Error(`refusing to delete ${b.id}: ${g.unpushed} commit(s) not on any remote in ${b.path}`)
  const stats = await previewDir(b.path)
  return { bucket: b, ...stats }
}

export async function removeBucket(reg, id) {
  const { bucket } = await deleteBucketPlan(reg, id)
  await fs.remove(bucket.path, { recursive: true })
  return deregisterBucket(reg, bucket.id)
}
