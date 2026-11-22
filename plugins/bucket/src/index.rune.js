import { fs, os, rune, section, shell } from '@utils'
import {
  createBucket,
  deleteBucketPlan,
  deregisterBucket,
  infoBucket,
  labelCounts,
  listBuckets,
  registerBucket,
  relabelBucket,
  removeBucket,
  renameBucket,
  resolveBucket,
  searchBuckets,
  withRegistry,
} from './bucket.js'

const REGISTRY_LOCATION = '~/.crunes/buckets.json'
const DEFAULT_ROOT = '~/buckets'

function row(b) {
  const title = b.readme && b.readme.title ? `  ${b.readme.title}` : ''
  return `${b.id}  ${b.labels.join(',') || '-'}  ${b.path}${title}`
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

function asArray(val) {
  if (!val) return []
  return Array.isArray(val) ? val : [val]
}

function createIsolateIo() {
  async function gitExec(dir, args) {
    const res = await shell.exec(`git -C "${dir}" ${args.join(' ')}`, { throw: false })
    return res.exitCode === 0 ? res.stdout.trim() : null
  }

  return {
    isWin: os.platform === 'win32',
    resolve: p => fs.resolve(p),
    exists: p => fs.exists(p),
    stat: async p => {
      try {
        return await fs.stat(p)
      } catch {
        return null
      }
    },
    readText: p => fs.read(p),
    readHead: async (p, lines) => (await fs.read(p, { from: 1, to: lines, throw: false })) || '',
    writeText: (p, content) => fs.write(p, content),
    mkdir: p => fs.mkdir(p),
    rmDir: p => fs.remove(p, { recursive: true }),
    listTop: p => fs.glob('*', { cwd: p }),
    preview: async dir => {
      const files = await fs.glob('**/*', { cwd: dir })
      let bytes = 0
      for (const f of files.slice(0, 1000)) {
        try {
          const st = await fs.stat(`${dir}/${f}`)
          if (st && st.isFile) bytes += st.size
        } catch {}
      }
      return { files: files.length, bytes, capped: false }
    },
    gitInit: async dir => {
      const res = await shell.exec(`git -C "${dir}" init -q`, { throw: false })
      if (res.exitCode !== 0) throw new Error(`git init failed in ${dir}`)
    },
    gitState: async dir => {
      if (!(await fs.exists(`${dir}/.git`))) return null
      const porcelain = await gitExec(dir, ['status', '--porcelain'])
      const unpushed = await gitExec(dir, ['rev-list', '--count', '--branches', '--not', '--remotes'])
      return {
        branch: await gitExec(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
        remote: await gitExec(dir, ['remote', 'get-url', 'origin']),
        dirty: porcelain ? porcelain.split('\n').length : 0,
        unpushed: Number(unpushed) || 0,
      }
    },
  }
}

export function args(b) {
  return b
    .option('-h, --help', 'Show help')
    .command('new', 'Create a folder for a new bucket and register it', c => {
      c.positional('<id>', 'Bucket id')
       .option('--in <dir>', 'Parent folder (default: ~/buckets)')
       .option('--git', 'Run git init in the new folder', false)
       .option('-l, --label <name>', 'Label to attach (repeatable)')
    })
    .command('register', 'Index an existing folder; nothing is moved', c => {
      c.positional('<dir>', 'Folder path')
       .option('--id <id>', 'Bucket id (default: folder name)')
       .option('-l, --label <name>', 'Label to attach (repeatable)')
    })
    .command('deregister', 'Drop a bucket from the index; its folder is untouched', c => {
      c.positional('<id>', 'Bucket id')
    })
    .command('delete', 'Delete the folder and deregister; refuses dirty git work', c => {
      c.positional('<id>', 'Bucket id')
       .option('--dry-run', 'Show what would be deleted, delete nothing', false)
       .option('-y, --yes', 'Confirm deletion', false)
    })
    .command('rename', 'Change a bucket id (folder is not renamed)', c => {
      c.positional('<id>', 'Current bucket id')
       .positional('<newId>', 'New bucket id')
    })
    .command('info', 'Path, labels, README title and summary, git state', c => {
      c.positional('<id>', 'Bucket id')
       .option('--json', 'Print JSON', false)
    })
    .command('where', 'Print the path of the bucket whose id or label matches', c => {
      c.positional('<name>', 'Bucket id or label')
       .option('-l, --label <name>', 'Filter by label')
    })
    .command('find', 'Search ids, labels, and README titles/summaries', c => {
      c.positional('<words...>', 'Search terms')
       .option('-n, --limit <number>', 'Maximum results', '20')
       .option('-l, --label <name>', 'Filter by label')
       .option('--json', 'Print JSON', false)
    })
    .command('list', 'List registered buckets', c => {
      c.option('-l, --label <name>', 'Filter by label')
       .option('--json', 'Print JSON', false)
    })
    .command('label', 'Add, remove, and list labels', c => {
      c.command('add', 'Attach labels to a bucket', s => {
        s.positional('<id>', 'Bucket id').positional('<labels...>', 'Labels to add')
      })
       .command('rm', 'Remove labels from a bucket', s => {
         s.positional('<id>', 'Bucket id').positional('<labels...>', 'Labels to remove')
       })
       .command('list', 'Every label with its bucket count', s => {
         s.option('--json', 'Print JSON', false)
       })
    })
}

export async function run(parsed) {
  const cmd = parsed.$command
  if (parsed.help || !cmd) return rune.helpSection()

  const io = createIsolateIo()
  return withRegistry(io, REGISTRY_LOCATION, async reg => {
    const labels = asArray(parsed.label)

    if (cmd === 'new') {
      const b = await createBucket(io, reg, {
        id: parsed.id,
        parent: parsed.in,
        defaultRoot: DEFAULT_ROOT,
        git: Boolean(parsed.git),
        labels,
      })
      return [section.create('bucket:new', { type: 'markdown', content: b.path, bucket: b })]
    }

    if (cmd === 'register') {
      const b = await registerBucket(io, reg, { dir: parsed.dir, id: parsed.id, labels })
      return [section.create('bucket:register', { type: 'markdown', content: `${b.id} -> ${b.path}`, bucket: b })]
    }

    if (cmd === 'deregister') {
      const b = deregisterBucket(reg, parsed.id)
      return [section.create('bucket:deregister', { type: 'markdown', content: `deregistered ${b.id} (folder kept: ${b.path})` })]
    }

    if (cmd === 'delete') {
      const plan = await deleteBucketPlan(io, reg, parsed.id)
      const size = `${plan.files} files, ${fmtBytes(plan.bytes)}`
      if (parsed['dry-run'] || parsed.dryRun) {
        return [section.create('bucket:delete', { type: 'markdown', content: `would delete ${plan.bucket.path} (${size})` })]
      }
      if (!parsed.yes) {
        throw new Error('pass --yes to delete (or --dry-run to preview)')
      }
      await removeBucket(io, reg, parsed.id)
      return [section.create('bucket:delete', { type: 'markdown', content: `deleted ${plan.bucket.path}` })]
    }

    if (cmd === 'rename') {
      const b = await renameBucket(io, reg, parsed.id, parsed.newId)
      return [section.create('bucket:rename', { type: 'markdown', content: `${parsed.id} -> ${b.id}`, bucket: b })]
    }

    if (cmd === 'info') {
      const b = await infoBucket(io, reg, parsed.id)
      if (parsed.json) {
        return [section.create('bucket:info', { type: 'markdown', content: JSON.stringify(b, null, 2), bucket: b })]
      }
      const lines = [row(b)]
      if (b.readme && b.readme.summary) lines.push(`  ${b.readme.summary}`)
      if (b.git) {
        lines.push(`  git: ${b.git.branch || '-'} · ${b.git.dirty} uncommitted · ${b.git.unpushed} unpushed · ${b.git.remote || 'no remote'}`)
      }
      return [section.create('bucket:info', { type: 'markdown', content: lines.join('\n'), bucket: b })]
    }

    if (cmd === 'where') {
      const hits = await resolveBucket(io, reg, parsed.name, labels)
      if (hits.length === 1) {
        return [section.create('bucket:where', { type: 'markdown', content: hits[0].path, bucket: hits[0] })]
      }
      if (!hits.length) {
        throw new Error(`no bucket with id or label "${parsed.name}"`)
      }
      throw new Error(`"${parsed.name}" matches ${hits.length} buckets; use an id`)
    }

    if (cmd === 'find') {
      const query = Array.isArray(parsed.words) ? parsed.words.join(' ') : String(parsed.words || '')
      const hits = await searchBuckets(io, reg, query, Number(parsed.limit) || 20, labels)
      if (parsed.json) {
        return [section.create('bucket:find', { type: 'markdown', content: JSON.stringify(hits, null, 2), buckets: hits })]
      }
      if (!hits.length) throw new Error('no matching buckets')
      const lines = []
      for (const b of hits) {
        lines.push(row(b))
        if (b.readme && b.readme.summary) lines.push(`    ${b.readme.summary}`)
      }
      return [section.create('bucket:find', { type: 'markdown', content: lines.join('\n'), buckets: hits })]
    }

    if (cmd === 'list') {
      const rows = await listBuckets(io, reg, labels)
      if (parsed.json) {
        return [section.create('bucket:list', { type: 'markdown', content: JSON.stringify(rows, null, 2), buckets: rows })]
      }
      return [section.create('bucket:list', { type: 'markdown', content: rows.map(row).join('\n') || 'no buckets', buckets: rows })]
    }

    if (cmd === 'label add') {
      const b = await relabelBucket(io, reg, parsed.id, { add: asArray(parsed.labels) })
      return [section.create('bucket:label', { type: 'markdown', content: `${b.id}: ${b.labels.join(',')}`, bucket: b })]
    }

    if (cmd === 'label rm') {
      const b = await relabelBucket(io, reg, parsed.id, { remove: asArray(parsed.labels) })
      return [section.create('bucket:label', { type: 'markdown', content: `${b.id}: ${b.labels.join(',') || '(no labels)'}`, bucket: b })]
    }

    if (cmd === 'label list') {
      const counts = labelCounts(reg)
      const content = parsed.json
        ? JSON.stringify(counts, null, 2)
        : counts.map(c => `${c.label}  ${c.count}`).join('\n') || 'no labels'
      return [section.create('bucket:label', { type: 'markdown', content, counts })]
    }

    return rune.helpSection()
  })
}
