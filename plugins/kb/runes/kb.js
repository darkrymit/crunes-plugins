import { vars, fs, yaml, md, section, rune } from '@utils'

/* ---------- frontmatter ---------- */

const FM = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

/* Returns { data, body, malformed }.
 *   data null + malformed false -> no frontmatter (a directory index)
 *   data null + malformed true  -> a block that would not parse
 * OKF forbids rejecting a document for either, so both stay listable. */
function splitFrontmatter(text) {
  const m = text.match(FM)
  if (!m) return { data: null, body: text, malformed: false }
  const body = text.slice(m[0].length)
  try {
    const data = yaml.parse(m[1])
    if (!data || typeof data !== 'object') {
      return { data: null, body, malformed: true }
    }
    return { data, body, malformed: false }
  } catch {
    return { data: null, body, malformed: true }
  }
}

/* The bundle's own H1 and the prose before its first ## heading. Taken from the
 * bundle rather than from configuration so it cannot drift from what the bundle
 * actually says. */
function headline(body) {
  let title = null
  const intro = []
  for (const line of body.split(/\r?\n/)) {
    if (title === null) {
      if (line.startsWith('# ')) title = line.slice(2).trim()
      continue
    }
    if (line.startsWith('## ')) break
    intro.push(line)
  }
  return { title, intro: intro.join('\n').trim() }
}

/* ---------- discovery ---------- */

/* Frontmatter in this corpus is five to seven lines. Twenty is slack enough to
 * cover a long description without reading whole documents during a scan. */
const HEAD_LINES = 20

function dirOf(path) {
  const i = path.lastIndexOf('/')
  return i === -1 ? '' : path.slice(0, i)
}

/* Documents and indexes are selected from the root's single glob result rather
 * than globbed again per bundle. crunes matches a grant against the literal
 * pattern string, so a pattern built from a discovered directory name would need
 * a grant nobody can write in advance. One pattern per root, one grant per root. */
async function collectDocs(paths, dir, id) {
  const docs = []
  for (const p of paths) {
    if (!p.startsWith(dir + '/')) continue
    if (p.endsWith('/index.md')) continue
    const head = await fs.read(p, { to: HEAD_LINES, throw: false })
    if (head === null) continue
    const { data, malformed } = splitFrontmatter(head)
    const abs = p.slice(dir.length)
    docs.push({
      ref: `${id}${abs}`,
      abs,
      path: p,
      type: data && data.type ? String(data.type) : null,
      title: data && data.title ? String(data.title) : null,
      description: data && data.description ? String(data.description) : null,
      tags: data && Array.isArray(data.tags) ? data.tags : [],
      resource: data && data.resource ? String(data.resource) : null,
      malformed,
    })
  }
  return docs
}

/* Every index.md in the bundle, keyed by the directory it indexes. dirAbs is ''
 * for the bundle root. These are the addresses read accepts as directories. */
function collectIndexes(paths, dir, id) {
  const indexes = []
  for (const p of paths) {
    if (!p.startsWith(dir + '/')) continue
    if (!p.endsWith('/index.md')) continue
    const abs = p.slice(dir.length)
    const dirAbs = dirOf(abs)
    indexes.push({ abs, path: p, dirAbs, ref: dirAbs === '' ? id : `${id}${dirAbs}` })
  }
  return indexes
}

/* A bundle root is an index.md whose frontmatter carries kb_version. Its kb key
 * is the bundle's id. Nothing in configuration names a bundle. */
async function discover() {
  const roots = vars.read('roots', ['.'])
  const seen = new Set()
  const bundles = []
  const problems = []
  for (const root of roots) {
    const pattern = root === '.' ? '**/*.md' : `${root}/**/*.md`
    let paths = []
    try {
      paths = await fs.glob(pattern)
    } catch (e) {
      /* Almost always a missing grant. Reported rather than swallowed: a root
       * that silently finds nothing is indistinguishable from a root with no
       * bundles in it, and the fix for the first is one config line. */
      problems.push(`${pattern} — ${e && e.message ? e.message : String(e)}`)
      continue
    }
    paths = paths.sort()
    for (const p of paths) {
      if (!p.endsWith('/index.md')) continue
      const dir = dirOf(p)
      if (seen.has(dir)) continue
      const text = await fs.read(p, { to: HEAD_LINES, throw: false })
      if (text === null) continue
      const { data } = splitFrontmatter(text)
      if (!data || data.kb_version === undefined) continue
      seen.add(dir)
      const id = data.kb ? String(data.kb) : '(unnamed)'
      const full = await fs.read(p, { throw: false })
      const { body } = splitFrontmatter(full === null ? '' : full)
      const { title, intro } = headline(body)
      bundles.push({
        id,
        dir,
        title,
        intro,
        docs: await collectDocs(paths, dir, id),
        indexes: collectIndexes(paths, dir, id),
      })
    }
  }
  return { bundles, problems }
}

function problemBlock(problems) {
  if (!problems.length) return ''
  return '\n\n! could not search:\n' + problems.map(p => `  ${p}`).join('\n')
}

/* ---------- list ---------- */

/* The tree lists every directory carrying an index.md, as the ref read accepts.
 * Indentation shows nesting; the count is the documents directly inside. These
 * are exactly the addresses that expand into a listing. */
function renderTree(bundle) {
  const rows = []
  const sorted = bundle.indexes.slice()
    .sort((a, b) => a.dirAbs.localeCompare(b.dirAbs))
  for (const ix of sorted) {
    const depth = ix.dirAbs === '' ? 0 : ix.dirAbs.split('/').length - 1
    const count = bundle.docs.filter(d => dirOf(d.abs) === ix.dirAbs).length
    const indent = '  ' + '  '.repeat(depth)
    rows.push(`${indent}${ix.ref}${count ? `   ${count}` : ''}`)
  }
  return rows.join('\n')
}

/* No type inventory. The tree already carries the counts, and OKF does not say
 * types map to directories — that is a local convention. Counting by type beside
 * a directory tree would imply the two are the same thing. A document's type is
 * reported where it is load-bearing: the meta line of a full read. */
function renderBundle(bundle, opts) {
  const rows = [`${bundle.id}  ·  ${bundle.dir}`]
  if (!opts.brief) {
    if (bundle.title) rows.push(bundle.title)
    if (bundle.intro) rows.push(bundle.intro.split('\n').map(l => `  ${l}`).join('\n'))
  }
  rows.push('')
  rows.push(renderTree(bundle))
  return rows.join('\n')
}

/* ---------- links and rendering ---------- */

/* Markdown links that address a document: bundle-absolute (/specs/x or /specs/x.md)
 * or cross-bundle (kb:id/specs/x or kb:id/specs/x.md). Anything else — a URL,
 * an anchor-only link — is not a document reference and is ignored. */
function linksIn(body) {
  const out = []
  const re = /\]\((kb:[^)\s]+|\/[^)\s]+)\)/g
  let m
  while ((m = re.exec(body)) !== null) {
    const target = m[1].split('#')[0].replace(/\/+$/, '')
    if (!target) continue
    if (!out.includes(target)) out.push(target)
  }
  return out
}

/* Frontmatter is emitted as one compact line rather than echoed as YAML. Type,
 * tags and resource are the signal — resource especially, since it names the
 * source file the document is about, which is often why the agent is reading. */
function metaLine(doc) {
  const bits = [doc.type || '(untyped)']
  if (doc.tags.length) bits.push(doc.tags.join(', '))
  if (doc.resource) bits.push(doc.resource)
  return bits.join(' · ')
}

async function renderFull(doc) {
  const text = await fs.read(doc.path, { throw: false })
  if (text === null) return `${doc.ref}\n  ! file could not be read`
  const { body, malformed } = splitFrontmatter(text)
  const warn = malformed ? '\n! frontmatter did not parse\n' : ''
  return `${metaLine(doc)}${warn}\n\n${body.trim()}`
}

/* Title, description and the document's ## headings: enough to decide whether a
 * full read is worth it, at roughly fifteen lines rather than two hundred. */
async function renderBrief(doc) {
  const text = await fs.read(doc.path, { throw: false })
  const headings = []
  if (text !== null) {
    const { body } = splitFrontmatter(text)
    for (const line of body.split(/\r?\n/)) {
      if (line.startsWith('## ')) headings.push(line.slice(3).trim())
    }
  }
  const rows = [`--- ${doc.ref} · brief`]
  if (doc.title) rows.push(doc.title)
  if (doc.description) rows.push(doc.description)
  if (headings.length) rows.push('  ' + headings.map(h => `## ${h}`).join('  '))
  return rows.join('\n')
}

/* ---------- refs ---------- */

/* Accepted forms, in the order tried:
 *   kb:<id>/<abs>   what documents contain (with or without .md)
 *   <id>/<abs>      what list prints — canonical (with or without .md)
 *   <id>            the bundle root
 *   /<abs>          bundle-absolute; ambiguous unless one bundle has it
 *   <path>          a plain filesystem path, e.g. from grep
 * Each may name a document or a directory carrying an index.md. */
/* Normalises what a search tool hands back so its output can be pasted straight
 * in: ripgrep prints Windows separators and a :line suffix, and neither is part
 * of the address. There is deliberately no grep command here — the rune has no
 * shell grant, and the only thing plain grep lacks is knowing where the bundles
 * are, which list already prints. */
function normaliseRef(ref) {
  return ref.replace(/\\/g, '/').replace(/:\d+(:.*)?$/, '')
}

function resolveRef(ref, bundles, kbFilter) {
  const cleaned = normaliseRef(ref)
  const bare = (cleaned.startsWith('kb:') ? cleaned.slice(3) : cleaned).replace(/\/+$/, '')
  const pool = kbFilter ? bundles.filter(b => b.id === kbFilter) : bundles

  if (kbFilter && pool.length === 0) {
    return { error: `No bundle with id ${kbFilter}. Known: ${bundles.map(b => b.id).join(', ')}` }
  }

  const inBundle = (b, abs) => {
    const absWithMd = abs.endsWith('.md') ? abs : `${abs}.md`
    const docWithMd = b.docs.find(d => d.abs === absWithMd)
    if (docWithMd) return { doc: docWithMd, bundle: b }

    const docDirect = b.docs.find(d => d.abs === abs)
    if (docDirect) return { doc: docDirect, bundle: b }

    const ix = b.indexes.find(i => i.dirAbs === abs || i.abs === abs)
    if (ix) return { index: ix, bundle: b }

    return null
  }

  if (!bare.startsWith('/')) {
    const slash = bare.indexOf('/')
    const id = slash === -1 ? bare : bare.slice(0, slash)
    const bundle = pool.find(b => b.id === id)
    if (bundle) {
      const abs = slash === -1 ? '' : bare.slice(slash)
      const hit = inBundle(bundle, abs)
      if (hit) return hit
      return { error: `${ref} — bundle ${id} has no ${abs || '/'}. Try: kb read ${id}`, fatal: true }
    }
    for (const b of pool) {
      const bareWithMd = bare.endsWith('.md') ? bare : `${bare}.md`
      const doc = b.docs.find(d => d.path === bareWithMd || d.path === bare)
      if (doc) return { doc, bundle: b }
      const ix = b.indexes.find(i => i.path === bare || dirOf(i.path) === bare)
      if (ix) return { index: ix, bundle: b }
    }
    return { error: `${ref} — not found. Known bundles: ${bundles.map(b => b.id).join(', ')}`, fatal: false }
  }

  const hits = []
  for (const b of pool) {
    const hit = inBundle(b, bare)
    if (hit) hits.push(hit)
  }
  if (hits.length === 1) return hits[0]
  if (hits.length === 0) {
    const isExplicitMd = cleaned.endsWith('.md')
    return {
      error: `${ref} — no bundle has that path. Try: kb list`,
      fatal: isExplicitMd,
    }
  }
  /* Hand back the refs rather than naming the bundles: the answer to an
   * ambiguous path is a full ref, and these can be pasted straight back. */
  const full = hits.map(h => (h.doc ? h.doc.ref : h.index.ref))
  return { error: `${ref} — in ${hits.length} bundles. Use one of: ${full.join('  ')}`, fatal: false }
}

/* ---------- rune ---------- */

export function args(b) {
  return b
    .option('-h, --help', 'Show help')
    .command('list', 'Knowledge bases available, each with its directory tree', c => {
      c.option('--brief', 'Drop descriptions, keep ids, paths, counts and tree', false)
    })
    .command('read', 'Full text of documents or of a directory index, with links in brief', c => {
      c.positional('<refs...>', 'Documents or directories. A directory reads its index.')
    })
    .command('broken', 'Find broken or unresolvable links in documents', c => {
      c.positional('[refs...]', 'Documents, directories, or bundles to check from (default: requires refs or --all)')
      c.option('--all', 'Check all documents across all bundles', false)
      c.option('-r, --recursive', 'Traverse outbound links recursively until all reachable documents are verified', false)
      c.option('-d, --depth <n>', 'Maximum link hop depth from seed references')
      c.option('-l, --limit <n>', 'Maximum documents visited during traversal (default: 500)')
      c.option('--brief', 'Output only summary and broken links', false)
    })
    .command('dead', 'Find unreferenced (orphaned) documents or directories in knowledge bundles', c => {
      c.positional('[refs...]', 'Bundle(s) or directories to check within (default: requires refs or --all)')
      c.option('--all', 'Check across all bundles', false)
    })
}

export async function run(args) {
  /* An unmatched command is the most specific thing known about the call, so it
   * is reported before anything else — including --help, which cannot sensibly
   * answer a question about a command that does not exist. */
  if (args.$command === '' && args.$rest.length > 0) {
    return section.create('kb', {
      type: 'markdown',
      content:
        `Unknown command: ${args.$rest[0]}\n` +
        'Available: list, read, broken, dead\n' +
        'Try: kb list',
    }, { title: 'kb' })
  }

  /* Help is scoped to the matched command: kb read --help renders read's own
   * help, not the whole index. Bare kb prints the index, as every other rune
   * does. Discovery is skipped entirely on both paths — there is no reason to
   * scan a corpus to print a command list. */
  if (args.help) return rune.helpSection(args.$command)
  if (!args.$command) return rune.helpSection()

  const { bundles, problems } = await discover()

  switch (args.$command) {
    case 'list': {
      if (bundles.length === 0) {
        const roots = vars.read('roots', ['.'])
        return section.create('kb', {
          type: 'markdown',
          content:
            `No bundles found. Looked under: ${roots.join(', ')}\n` +
            'A bundle root is an index.md whose frontmatter carries kb_version.' +
            problemBlock(problems),
        }, { title: 'Knowledge bases' })
      }
      /* One section per bundle, which is also how a caller selects a single
       * knowledge base: kb[-s <id>] list. That is why there is no --kb flag. */
      const out = bundles.map(b => section.create(b.id, {
        type: 'markdown',
        content: renderBundle(b, { brief: !!args.brief }),
      }, { title: b.title || b.id }))
      if (problems.length) {
        out.push(section.create('kb:problems', {
          type: 'markdown',
          content: problemBlock(problems).trim(),
        }, { title: 'Problems' }))
      }
      return out
    }

    case 'read': {
      const refs = Array.isArray(args.refs) ? args.refs : []
      if (refs.length === 0) {
        return section.create('kb', {
          type: 'markdown',
          content:
            'read needs at least one ref.\n' +
            'Find them with: kb list',
        }, { title: 'read' })
      }

      const out = []
      const emitted = new Set()
      const primaries = []

      /* Primaries are resolved before anything is emitted, so a document named
       * explicitly is always full even if another ref also links to it. */
      for (const ref of refs) {
        const hit = resolveRef(ref, bundles, null)
        if (hit.error) {
          out.push(section.create(`unresolved:${ref}`, {
            type: 'markdown',
            content: hit.error,
          }, { title: ref }))
          continue
        }
        primaries.push(hit)
        emitted.add(hit.doc ? hit.doc.ref : hit.index.ref)
      }

      for (const hit of primaries) {
        if (hit.doc) {
          out.push(section.create(hit.doc.ref, {
            type: 'markdown',
            content: await renderFull(hit.doc),
          }, { title: hit.doc.title || hit.doc.ref }))
          continue
        }
        const text = await fs.read(hit.index.path, { throw: false })
        const { body } = splitFrontmatter(text === null ? '' : text)
        out.push(section.create(hit.index.ref, {
          type: 'markdown',
          content: body.trim() || `${hit.index.ref}\n  ! index is empty`,
        }, { title: hit.index.ref }))
      }

      /* One hop, and links are always brief. A document wanted in full is passed
       * as a ref of its own — which is also why there is no promotion syntax. */
      for (const hit of primaries) {
        const source = hit.doc ? hit.doc : hit.index
        const text = await fs.read(source.path, { throw: false })
        if (text === null) continue
        const { body } = splitFrontmatter(text)

        for (const target of linksIn(body)) {
          /* A bundle-absolute link resolves inside the linking document's own
           * bundle, which is what bundle-absolute means. A kb: link carries its
           * own id and resolves globally. */
          const link = resolveRef(target, bundles, target.startsWith('/') ? hit.bundle.id : null)
          if (link.error) {
            const name = `unresolved:${target}`
            if (emitted.has(name)) continue
            emitted.add(name)
            out.push(section.create(name, {
              type: 'markdown',
              content: `${target} — unresolvable from ${source.ref}`,
            }, { title: target }))
            continue
          }
          if (!link.doc) continue
          if (emitted.has(link.doc.ref)) continue
          emitted.add(link.doc.ref)
          out.push(section.create(link.doc.ref, {
            type: 'markdown',
            content: md.codeBlock(await renderBrief(link.doc)),
          }, { title: link.doc.title || link.doc.ref }))
        }
      }

      return out
    }

    case 'broken': {
      const refs = Array.isArray(args.refs) ? args.refs : []
      const isRecursive = !!args.recursive
      const rawLimit = args.limit !== undefined ? Number(args.limit) : 500
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 500
      const rawDepth = args.depth !== undefined ? Number(args.depth) : undefined
      const maxDepth = Number.isFinite(rawDepth)
        ? rawDepth
        : (isRecursive ? Infinity : (refs.length > 0 ? 1 : 0))

      if (refs.length === 0 && !args.all) {
        return section.create('kb', {
          type: 'markdown',
          content:
            'broken needs at least one ref or --all.\n' +
            'To audit all bundles: kb broken --all\n' +
            'Find refs with: kb list',
        }, { title: 'broken' })
      }

      if (bundles.length === 0) {
        const roots = vars.read('roots', ['.'])
        return section.create('kb:broken', {
          type: 'markdown',
          content:
            `No bundles found to check under: ${roots.join(', ')}\n` +
            'A bundle root is an index.md whose frontmatter carries kb_version.' +
            problemBlock(problems),
        }, { title: 'kb broken' })
      }

      // Determine seeds
      const seeds = []
      const unresolvedSeeds = []

      if (refs.length > 0) {
        for (const ref of refs) {
          const hit = resolveRef(ref, bundles, null)
          if (hit.error) {
            unresolvedSeeds.push({ ref, error: hit.error })
          } else if (hit.doc) {
            seeds.push({ doc: hit.doc, bundle: hit.bundle })
          } else if (hit.index) {
            seeds.push({ index: hit.index, bundle: hit.bundle })
            const subDocs = hit.bundle.docs.filter(d => hit.index.dirAbs === '' || d.abs.startsWith(hit.index.dirAbs + '/'))
            for (const sd of subDocs) seeds.push({ doc: sd, bundle: hit.bundle })
          }
        }
      } else {
        for (const b of bundles) {
          for (const d of b.docs) seeds.push({ doc: d, bundle: b })
          for (const i of b.indexes) seeds.push({ index: i, bundle: b })
        }
      }

      const queue = seeds.map(s => ({ ...s, depth: 0 }))
      const visited = new Set()
      const bundleStats = new Map()
      const brokenByBundle = new Map()

      for (const b of bundles) {
        bundleStats.set(b.id, { visitedCount: 0, linksCount: 0, bundle: b })
        brokenByBundle.set(b.id, [])
      }

      while (queue.length > 0 && visited.size < limit) {
        const item = queue.shift()
        const source = item.doc || item.index
        const sourceKey = source.ref || source.path
        if (visited.has(sourceKey)) continue
        visited.add(sourceKey)

        const bundleId = item.bundle.id
        const stats = bundleStats.get(bundleId)
        if (stats) stats.visitedCount++

        const text = await fs.read(source.path, { throw: false })
        if (text === null) {
          if (brokenByBundle.has(bundleId)) {
            brokenByBundle.get(bundleId).push({ source: sourceKey, target: source.path, error: 'Could not read file from disk', fatal: true })
          }
          continue
        }

        const { body } = splitFrontmatter(text)
        const links = linksIn(body)
        if (stats) stats.linksCount += links.length

        for (const target of links) {
          const link = resolveRef(target, bundles, target.startsWith('/') ? bundleId : null)

          if (link.error) {
            if (brokenByBundle.has(bundleId)) {
              brokenByBundle.get(bundleId).push({ source: sourceKey, target, error: link.error, fatal: link.fatal !== false })
            }
          } else if (link.doc && item.depth + 1 <= maxDepth && !visited.has(link.doc.ref)) {
            queue.push({ doc: link.doc, bundle: link.bundle, depth: item.depth + 1 })
          }
        }
      }

      const out = []

      if (unresolvedSeeds.length > 0) {
        const seedLines = unresolvedSeeds.map(s => `  ✗ ${s.error}`).join('\n')
        out.push(section.create('kb:unresolved', {
          type: 'markdown',
          content: `Unresolved seed references:\n${seedLines}`,
        }, { title: 'Unresolved seeds' }))
      }

      for (const [bId, stats] of bundleStats.entries()) {
        if (stats.visitedCount === 0 && refs.length > 0) continue
        const broken = brokenByBundle.get(bId) || []

        if (broken.length === 0) {
          out.push(section.create(bId, {
            type: 'markdown',
            content: `✓ Verified ${stats.visitedCount} document(s), ${stats.linksCount} link(s). All links valid.`,
          }, { title: stats.bundle.title || bId }))
        } else {
          const fatalCount = broken.filter(b => b.fatal).length
          const warnCount = broken.filter(b => !b.fatal).length

          let summaryLine = ''
          if (fatalCount > 0 && warnCount > 0) {
            summaryLine = `✗ Found ${fatalCount} broken link(s) and ${warnCount} warning(s) across ${stats.visitedCount} document(s) checked (${stats.linksCount} total links verified).\n`
          } else if (fatalCount > 0) {
            summaryLine = `✗ Found ${fatalCount} broken link(s) across ${stats.visitedCount} document(s) checked (${stats.linksCount} total links verified).\n`
          } else {
            summaryLine = `! Found ${warnCount} warning(s) across ${stats.visitedCount} document(s) checked (${stats.linksCount} total links verified).\n`
          }

          const rows = [summaryLine]
          const bySource = new Map()
          for (const b of broken) {
            if (!bySource.has(b.source)) bySource.set(b.source, [])
            bySource.get(b.source).push(b)
          }
          for (const [src, items] of bySource.entries()) {
            rows.push(src)
            for (const it of items) {
              const sym = it.fatal ? '✗' : '!'
              rows.push(`  ${sym} ${it.error}`)
            }
            rows.push('')
          }

          out.push(section.create(bId, {
            type: 'markdown',
            content: rows.join('\n').trim(),
          }, { title: stats.bundle.title || bId }))
        }
      }

      if (problems.length) {
        out.push(section.create('kb:problems', {
          type: 'markdown',
          content: problemBlock(problems).trim(),
        }, { title: 'Problems' }))
      }

      return out
    }

    case 'dead': {
      const refs = Array.isArray(args.refs) ? args.refs : []

      if (refs.length === 0 && !args.all) {
        return section.create('kb', {
          type: 'markdown',
          content:
            'dead needs at least one ref or --all.\n' +
            'To check all bundles: kb dead --all\n' +
            'Find refs with: kb list',
        }, { title: 'dead' })
      }

      if (bundles.length === 0) {
        const roots = vars.read('roots', ['.'])
        return section.create('kb:dead', {
          type: 'markdown',
          content:
            `No bundles found to check under: ${roots.join(', ')}\n` +
            'A bundle root is an index.md whose frontmatter carries kb_version.' +
            problemBlock(problems),
        }, { title: 'kb dead' })
      }

      // 1. Collect all incoming links across the entire corpus
      const referenced = new Set()
      for (const b of bundles) {
        for (const item of [...b.docs, ...b.indexes]) {
          const text = await fs.read(item.path, { throw: false })
          if (text === null) continue
          const { body } = splitFrontmatter(text)
          for (const target of linksIn(body)) {
            const hit = resolveRef(target, bundles, target.startsWith('/') ? b.id : null)
            if (hit.doc) referenced.add(hit.doc.ref)
            if (hit.index) referenced.add(hit.index.ref)
          }
        }
      }

      // 2. Determine target items to audit per bundle
      const targetsByBundle = new Map()
      const unresolvedSeeds = []

      for (const b of bundles) {
        targetsByBundle.set(b.id, { bundle: b, items: [], isRoot: true })
      }

      if (refs.length > 0) {
        for (const b of bundles) targetsByBundle.get(b.id).items = []

        for (const ref of refs) {
          const hit = resolveRef(ref, bundles, null)
          if (hit.error) {
            unresolvedSeeds.push({ ref, error: hit.error })
            continue
          }
          const bData = targetsByBundle.get(hit.bundle.id)
          if (hit.doc) {
            bData.items.push(hit.doc)
            bData.isRoot = false
          } else if (hit.index) {
            if (hit.index.dirAbs === '') {
              // Bundle root
              bData.items.push(...hit.bundle.docs)
              for (const ix of hit.bundle.indexes) {
                if (ix.dirAbs !== '') bData.items.push(ix)
              }
              bData.isRoot = true
            } else {
              // Subdirectory
              const subDocs = hit.bundle.docs.filter(d => d.abs.startsWith(hit.index.dirAbs + '/'))
              bData.items.push(...subDocs)
              for (const ix of hit.bundle.indexes) {
                if (ix.dirAbs !== '' && ix.dirAbs.startsWith(hit.index.dirAbs + '/')) bData.items.push(ix)
              }
              bData.isRoot = false
            }
          }
        }
      } else {
        for (const b of bundles) {
          const bData = targetsByBundle.get(b.id)
          bData.items.push(...b.docs)
          for (const ix of b.indexes) {
            if (ix.dirAbs !== '') bData.items.push(ix)
          }
          bData.isRoot = true
        }
      }

      const out = []

      if (unresolvedSeeds.length > 0) {
        const seedLines = unresolvedSeeds.map(s => `  ✗ ${s.error}`).join('\n')
        out.push(section.create('kb:unresolved', {
          type: 'markdown',
          content: `Unresolved seed references:\n${seedLines}`,
        }, { title: 'Unresolved seeds' }))
      }

      for (const [bId, data] of targetsByBundle.entries()) {
        if (data.items.length === 0 && refs.length > 0) continue

        const unreferenced = data.items.filter(item => !referenced.has(item.ref))

        if (unreferenced.length === 0) {
          out.push(section.create(bId, {
            type: 'markdown',
            content: `✓ All ${data.items.length} document(s) are referenced.`,
          }, { title: data.bundle.title || bId }))
        } else {
          const rows = [
            `! Found ${unreferenced.length} unreferenced item(s) across ${data.items.length} checked:\n`,
            ...unreferenced.map(item => `  ! ${item.ref}`),
          ]
          out.push(section.create(bId, {
            type: 'markdown',
            content: rows.join('\n').trim(),
          }, { title: data.bundle.title || bId }))
        }
      }

      if (problems.length) {
        out.push(section.create('kb:problems', {
          type: 'markdown',
          content: problemBlock(problems).trim(),
        }, { title: 'Problems' }))
      }

      return out
    }

    default:
      return rune.helpSection()
  }
}

