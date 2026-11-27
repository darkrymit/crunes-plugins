import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { DatabaseSync } from 'node:sqlite'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import zlib from 'node:zlib'
import { createSessionReader } from '../src/core.js'

function expandHome(p) {
  const s = String(p || '')
  if (s === '~') return os.homedir()
  if (s.startsWith('~/') || s.startsWith('~\\')) {
    return path.join(os.homedir(), s.slice(2))
  }
  return s
}

async function readHeadLines(absPath, from, to) {
  const rs = fs.createReadStream(absPath, { encoding: 'utf8' })
  const rl = readline.createInterface({ input: rs, crlfDelay: Infinity })
  const out = []
  let lineNo = 0
  try {
    for await (const line of rl) {
      lineNo += 1
      if (lineNo >= from) out.push(line)
      if (lineNo >= to) break
    }
  } finally {
    rl.close()
    rs.destroy()
  }
  return out.join('\n')
}

async function readTailLines(absPath, count) {
  const fh = await fsp.open(absPath, 'r')
  try {
    const { size } = await fh.stat()
    if (size === 0) return ''
    let chunkSize = Math.min(size, 64 * 1024)
    for (;;) {
      const start = Math.max(0, size - chunkSize)
      const len = size - start
      const buf = Buffer.allocUnsafe(len)
      await fh.read(buf, 0, len, start)
      const text = buf.toString('utf8')
      const lines = text.split(/\r?\n/)
      // Drop partial first line when reading from mid-file.
      const complete = start > 0 ? lines.slice(1) : lines
      const nonEmpty = complete.filter(Boolean)
      if (nonEmpty.length >= count || start === 0) {
        return nonEmpty.slice(-count).join('\n')
      }
      chunkSize = Math.min(size, chunkSize * 2)
    }
  } finally {
    await fh.close()
  }
}

async function walkMatching(rootDir, pattern) {
  if (pattern === '**/transcript.jsonl') {
    let entries
    try {
      entries = await fsp.readdir(rootDir, { withFileTypes: true })
    } catch {
      return []
    }
    const out = []
    const dirs = entries.filter(e => e.isDirectory())
    const conc = 32
    let next = 0
    await Promise.all(Array.from({ length: Math.min(conc, dirs.length) }, async () => {
      while (next < dirs.length) {
        const ent = dirs[next++]
        const rel = `${ent.name}/.system_generated/logs/transcript.jsonl`
        try {
          await fsp.access(path.join(rootDir, ent.name, '.system_generated', 'logs', 'transcript.jsonl'))
          out.push(rel)
        } catch {}
      }
    }))
    return out
  }

  const out = []
  const suffix = pattern.replace(/^\*\*\//, '')

  async function visit(absDir, relDir) {
    let entries
    try {
      entries = await fsp.readdir(absDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      const rel = relDir ? `${relDir}/${ent.name}` : ent.name
      const abs = path.join(absDir, ent.name)
      if (ent.isDirectory()) {
        if (ent.name === 'tool-results' || ent.name === '.system_generated') continue
        await visit(abs, rel)
      } else if (ent.isFile()) {
        if (ent.name.endsWith(suffix.slice(1))) {
          out.push(rel)
        }
      }
    }
  }

  await visit(rootDir, '')
  return out
}

const nodeFs = {
  async exists(p) {
    try {
      await fsp.access(expandHome(p))
      return true
    } catch {
      return false
    }
  },
  async stat(p) {
    const s = await fsp.stat(expandHome(p))
    return {
      size: s.size,
      mtime: s.mtime.toISOString(),
      birthtime: s.birthtime.toISOString(),
      isDirectory: s.isDirectory(),
      isFile: s.isFile(),
    }
  },
  async glob(pattern, opts = {}) {
    const cwd = expandHome(opts.cwd || '.')
    return walkMatching(cwd, pattern)
  },
  async read(p, opts = {}) {
    const abs = expandHome(p)
    try {
      if (Number.isInteger(opts.from) && opts.from < 0 && opts.to == null) {
        return await readTailLines(abs, Math.abs(opts.from))
      }
      if (Number.isInteger(opts.from) && Number.isInteger(opts.to) && opts.from > 0) {
        return await readHeadLines(abs, opts.from, opts.to)
      }
      return await fsp.readFile(abs, 'utf8')
    } catch (err) {
      if (opts.throw === false && err.code === 'ENOENT') return null
      throw err
    }
  },
  async write(p, content) {
    const abs = expandHome(p)
    await fsp.mkdir(path.dirname(abs), { recursive: true })
    await fsp.writeFile(abs, content, 'utf8')
  },
  async *readLinesStream(p, opts = {}) {
    const abs = expandHome(p)
    const fileStream = fs.createReadStream(abs, { highWaterMark: 256 * 1024 })
    const input = opts.decompress === 'zstd'
      ? fileStream.pipe(zlib.createZstdDecompress())
      : fileStream
    if (opts.decompress === 'zstd') {
      fileStream.on('error', err => input.destroy(err))
    }
    const needles = Array.isArray(opts.contains) && opts.contains.length > 0
      ? opts.contains.map(c => Buffer.from(c, 'utf8'))
      : null
    let carry = Buffer.alloc(0)
    try {
      for await (const chunk of input) {
        const buf = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk
        let start = 0
        let nl
        while ((nl = buf.indexOf(0x0a, start)) !== -1) {
          let end = nl
          if (end > start && buf[end - 1] === 0x0d) end -= 1
          const lineBuf = buf.subarray(start, end)
          if (!needles || needles.some(n => lineBuf.includes(n))) {
            yield lineBuf.toString('utf8')
          }
          start = nl + 1
        }
        carry = start < buf.length ? Buffer.from(buf.subarray(start)) : Buffer.alloc(0)
      }
      if (carry.length > 0) {
        const end = carry[carry.length - 1] === 0x0d ? carry.length - 1 : carry.length
        const lineBuf = carry.subarray(0, end)
        if (!needles || needles.some(n => lineBuf.includes(n))) {
          yield lineBuf.toString('utf8')
        }
      }
    } finally {
      fileStream.destroy()
    }
  },
}

const nodeSqlite = {
  async open(dir, file) {
    const db = new DatabaseSync(path.join(expandHome(dir), file), { readOnly: true })
    return {
      async query(sql, params = []) {
        return db.prepare(sql).all(...params)
      },
      async close() {
        db.close()
      },
    }
  },
}

const reader = createSessionReader({ fs: nodeFs, sqlite: nodeSqlite })
const { listSessions, searchSessions, hydrateStub } = reader

async function hydrateShard(stubs, fast) {
  const out = []
  const errSkips = []
  const conc = 4
  let next = 0
  await Promise.all(Array.from({ length: Math.min(conc, stubs.length) }, async () => {
    while (next < stubs.length) {
      const stub = stubs[next++]
      try {
        const summary = await hydrateStub(stub, null, { fast })
        out.push({ stub, summary })
      } catch (err) {
        errSkips.push(`${stub.path}: ${err.message}`)
      }
    }
  }))
  return { out, skipped: errSkips }
}

if (!isMainThread) {
  const { stubs, fast } = workerData
  const res = await hydrateShard(stubs, fast)
  parentPort.postMessage(res)
} else {
  const cmd = process.argv[2]
  const rawOpts = process.env.SESSION_SCAN_OPTS
    || (process.argv[3] ? Buffer.from(process.argv[3], 'base64').toString('utf8') : '')
  const opts = rawOpts ? JSON.parse(rawOpts) : {}
  const skipped = []

  const hydrateBatch = async (uncached, { fast }) => {
    if (uncached.length < 16) {
      const res = await hydrateShard(uncached, fast)
      skipped.push(...res.skipped)
      return res.out
    }
    const workerCount = Math.min(8, Math.max(2, os.availableParallelism ? os.availableParallelism() : os.cpus().length), uncached.length)
    const shards = Array.from({ length: workerCount }, () => [])
    for (let i = 0; i < uncached.length; i++) {
      shards[i % workerCount].push(uncached[i])
    }
    const selfUrl = new URL(import.meta.url)
    const shardResults = await Promise.all(shards.map(shard => new Promise((resolve, reject) => {
      const w = new Worker(selfUrl, { workerData: { stubs: shard, fast } })
      w.once('message', resolve)
      w.once('error', reject)
      w.once('exit', code => {
        if (code !== 0) reject(new Error(`Worker exited with code ${code}`))
      })
    })))
    const out = []
    for (const r of shardResults) {
      if (r.skipped?.length) skipped.push(...r.skipped)
      out.push(...r.out)
    }
    return out
  }

  const callOpts = {
    ...opts,
    concurrency: Number(opts.concurrency) > 0 ? Number(opts.concurrency) : 16,
    hydrateBatch: cmd === 'list' ? hydrateBatch : undefined,
    onSkip: (stub, err) => skipped.push(`${stub.path}: ${err.message}`),
  }

  if (cmd === 'list') {
    const items = await listSessions(callOpts)
    process.stdout.write(JSON.stringify({ ok: true, items, skipped }))
  } else if (cmd === 'search') {
    const hits = await searchSessions(opts.query, callOpts)
    process.stdout.write(JSON.stringify({ ok: true, hits, skipped }))
  } else {
    process.stderr.write(`Unknown scan command: ${cmd}\n`)
    process.exit(1)
  }
}
