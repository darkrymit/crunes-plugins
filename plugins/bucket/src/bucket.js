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

async function readReadmeInfo(io, dir) {
  const candidates = ['README.md', 'readme.md', 'README.markdown', 'README.txt', 'README.rst']
  for (const hit of candidates) {
    const full = joinPath(dir, hit)
    const st = await io.stat(full)
    if (st && st.isFile) {
      const text = await io.readHead(full, 500)
      return { ...parseReadme(text), stamp: { file: hit, mtimeMs: st.mtimeMs, size: st.size } }
    }
  }
  return { title: '', summary: '', stamp: null }
}

function sameStamp(a, b) {
  if (!a || !b) return a === b
  return a.file === b.file && a.mtimeMs === b.mtimeMs && a.size === b.size
}

async function checkBucket(io, reg, b) {
  const st = await io.stat(b.path)
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
  const next = await readReadmeInfo(io, b.path)
  if (!sameStamp(next.stamp, b.readme ? b.readme.stamp : null)) {
    b.readme = next
    reg.dirty = true
  }
  return true
}

async function sweep(io, reg) {
  const all = reg.data.buckets
  const before = all.length
  reg.data.buckets = all.filter(b => !(b.goneSince && reg.now - b.goneSince > GONE_TTL_MS))
  if (reg.data.buckets.length !== before) reg.dirty = true

  const list = reg.data.buckets
  if (!list.length) return
  const start = reg.data.sweep % list.length
  const count = Math.min(SWEEP_BATCH, list.length)
  for (let i = 0; i < count; i++) await checkBucket(io, reg, list[(start + i) % list.length])
  reg.data.sweep = (start + count) % list.length
  reg.dirty = true
}

async function shown(io, reg, buckets) {
  const out = []
  for (let i = 0; i < buckets.length; i++) {
    if (i >= SHOWN_CHECK || (await checkBucket(io, reg, buckets[i]))) {
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

async function requireVisible(io, reg, id) {
  const b = byId(reg, toId(id))
  if (!b || !(await checkBucket(io, reg, b))) throw new Error(`no bucket "${id}"`)
  return b
}

function assertFreeId(reg, id, flag) {
  assertId(id)
  const taken = byId(reg, id)
  if (taken) {
    throw new Error(`id "${id}" is taken (${taken.path}${taken.goneSince ? ', folder gone' : ''}); pass ${flag} <name>`)
  }
}

export async function withRegistry(io, registryFile, fn, now = Date.now()) {
  let data = { sweep: 0, buckets: [] }
  if (await io.exists(registryFile)) {
    data = JSON.parse(await io.readText(registryFile))
    if (!data || !Array.isArray(data.buckets)) {
      throw new Error(`${registryFile} is not a bucket registry`)
    }
    data.sweep = Number.isInteger(data.sweep) ? data.sweep : 0
  }
  const reg = { data, now, dirty: false }
  await sweep(io, reg)
  const result = await fn(reg)
  if (reg.dirty) {
    await io.writeText(registryFile, JSON.stringify(reg.data, null, 2) + '\n')
  }
  return result
}

export async function registerBucket(io, reg, { dir, id, labels = [] }) {
  const abs = normalizePath(await io.resolve(dir))
  const st = await io.stat(abs)
  if (!st || !st.isDirectory) throw new Error(`not a folder: ${abs}`)

  const own = reg.data.buckets.find(b => samePath(b.path, abs, io.isWin))
  if (own) {
    if (!own.goneSince) throw new Error(`already registered as "${own.id}": ${abs}`)
    own.labels = uniqueLabels([...own.labels, ...labels])
    await checkBucket(io, reg, own)
    return own
  }

  const bucketId = id ? toId(id) : toId(basename(abs))
  assertFreeId(reg, bucketId, '--id')
  const entry = {
    id: bucketId,
    path: abs,
    labels: uniqueLabels(labels),
    readme: await readReadmeInfo(io, abs),
  }
  reg.data.buckets.push(entry)
  reg.dirty = true
  return entry
}

export async function createBucket(io, reg, { id, parent, defaultRoot, git, labels = [] }) {
  const bucketId = toId(id)
  assertFreeId(reg, bucketId, 'another id')
  const rootAbs = normalizePath(await io.resolve(parent || defaultRoot))
  const dir = joinPath(rootAbs, bucketId)
  if (await io.exists(dir)) {
    throw new Error(`folder exists, register it with: crunes -p run bucket register ${dir}`)
  }
  await io.mkdir(dir)
  if (git) {
    await io.gitInit(dir)
  }
  return registerBucket(io, reg, { dir, id: bucketId, labels })
}

export function deregisterBucket(reg, id) {
  const key = toId(id)
  const i = reg.data.buckets.findIndex(b => b.id === key)
  if (i < 0) throw new Error(`no bucket "${id}"`)
  reg.dirty = true
  return reg.data.buckets.splice(i, 1)[0]
}

export async function renameBucket(io, reg, id, newId) {
  const b = await requireVisible(io, reg, id)
  const next = toId(newId)
  assertFreeId(reg, next, 'another id')
  b.id = next
  reg.dirty = true
  return b
}

export async function relabelBucket(io, reg, id, { add = [], remove = [] }) {
  const b = await requireVisible(io, reg, id)
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

export async function resolveBucket(io, reg, name, labels = []) {
  const key = toId(name)
  const pool = visible(reg, labels)
  const hit = pool.filter(b => b.id === key)
  if (hit.length) return shown(io, reg, hit)
  return shown(io, reg, pool.filter(b => b.labels.includes(key)))
}

export async function listBuckets(io, reg, labels = []) {
  return shown(io, reg, visible(reg, labels).sort((a, b) => a.id.localeCompare(b.id)))
}

export async function searchBuckets(io, reg, query, limit = 20, labels = []) {
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
  return shown(io, reg, scored.slice(0, limit).map(s => s.b))
}

export async function infoBucket(io, reg, id) {
  const b = await requireVisible(io, reg, id)
  return { ...b, git: await io.gitState(b.path) }
}

export async function deleteBucketPlan(io, reg, id) {
  const b = await requireVisible(io, reg, id)
  const abs = normalizePath(b.path)
  const home = normalizePath(await io.resolve('~'))
  if (abs === '/' || /^[a-zA-Z]:$/.test(abs) || samePath(abs, home, io.isWin)) {
    throw new Error(`refusing to delete ${b.path}: a drive root or the home folder`)
  }
  const g = await io.gitState(b.path)
  if (g && g.dirty) throw new Error(`refusing to delete ${b.id}: ${g.dirty} uncommitted change(s) in ${b.path}`)
  if (g && g.unpushed) throw new Error(`refusing to delete ${b.id}: ${g.unpushed} commit(s) not on any remote in ${b.path}`)
  const stats = await io.preview(b.path)
  return { bucket: b, ...stats }
}

export async function removeBucket(io, reg, id) {
  const { bucket } = await deleteBucketPlan(io, reg, id)
  await io.rmDir(bucket.path)
  return deregisterBucket(reg, bucket.id)
}
