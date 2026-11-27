import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { zstdCompressSync } from 'node:zlib'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const srcDir = path.resolve(__dirname, '../src')
const localCrunesCli = path.resolve(__dirname, '../../../../crunes-cli/dist/cli.js')
const localTestShim = path.resolve(__dirname, '../../../../crunes-cli/src/test/index.js')

const { setupCrunesTest } = await import(
  fs.existsSync(localTestShim) ? pathToFileURL(localTestShim).href : '@darkrymit/crunes-cli/test'
)
const {
  fmtDuration,
  fmtTok,
  formatDigestMarkdown,
  formatInspectMarkdown,
  formatStatMarkdown,
  listSessions,
  normalizeFormat,
  parseSession,
  parseStepRangeSpec,
  keepForDigest,
  keepForInspect,
  resolveSession,
  searchSessions,
} = await import('../src/session.js')


function makeAgyFixture(tmp, app = 'antigravity', convId = '11111111-2222-3333-4444-555555555555') {
  const logsDir = path.join(tmp, '.gemini', app, 'brain', convId, '.system_generated', 'logs')
  fs.mkdirSync(logsDir, { recursive: true })
  const lines = [
    JSON.stringify({
      step_index: 1,
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-11-22T10:00:00Z',
      content: 'Check the status of the demo workspace',
    }),
    JSON.stringify({
      step_index: 2,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-22T10:00:05Z',
      content: 'Everything in the demo workspace is clean.',
      tool_calls: [
        {
          name: 'read_file',
          arguments: { Path: path.join(tmp, 'demo', 'README.md') },
          output: 'Demo README contents',
        },
      ],
    }),
  ]
  fs.writeFileSync(path.join(logsDir, 'transcript.jsonl'), lines.join('\n') + '\n', 'utf8')
  return convId
}

const protoVarint = n => { const out = []; while (n > 127) { out.push((n % 128) | 128); n = Math.floor(n / 128) } return Buffer.from([...out, n]) }
const proto = fields => Buffer.concat(fields.map(([n, v]) => typeof v === 'number'
  ? Buffer.concat([protoVarint(n * 8), protoVarint(v)])
  : Buffer.concat([protoVarint(n * 8 + 2), protoVarint(Buffer.from(v).length), Buffer.from(v)])))

// Three responses; the second repeats as its own retry, the last one is written twice.
function makeAgyDatabase(tmp, app, convId) {
  const dir = path.join(tmp, '.gemini', app, 'conversations')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${convId}.db`)
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = DELETE; CREATE TABLE gen_metadata (idx INTEGER, data BLOB, size INTEGER)')
  const usage = (id, input, cached) => proto([[2, input], [3, 50], [5, cached], [9, 10], [10, 40], [11, id]])
  const row = (u, retry) => proto([[1, proto([[4, u], ...(retry ? [[17, proto([[2, retry]])]] : [])])]])
  const a = usage('r1', 1000, 70000), b = usage('r2', 200, 0), c = usage('r3', 5, 0)
  const insert = db.prepare('INSERT INTO gen_metadata VALUES (?, ?, 0)')
  ;[row(a), row(b, b), row(c), row(c), Buffer.from([255])].forEach((data, i) => insert.run(i, data))
  for (let i = 5; i < 45; i++) insert.run(i, row(usage(`p${i}`, 1, 0)))
  db.close()
  return file
}
// 1000+200+5+40 input, 70000 cached, 43 responses of 50 output
const AGY_DB_TOTAL = 1245 + 70000 + 43 * 50

function runCrunes(cwd, args, env) {
  const useLocal = fs.existsSync(localCrunesCli)
  const cmd = process.execPath
  const cli = useLocal ? localCrunesCli : fileURLToPath(import.meta.resolve('@darkrymit/crunes-cli'))
  const fullArgs = [cli, ...args]
  return execFileSync(cmd, fullArgs, { cwd, env, encoding: 'utf8' })
}

describe('session.js (unit + fixture)', () => {
  it('parses step ranges and normalizes format names', () => {
    assert.deepEqual(parseStepRangeSpec('1,3..5', 10), [1, 3, 4, 5])
    assert.equal(normalizeFormat('compact'), 'compact')
    assert.equal(normalizeFormat('FULL'), 'full')
  })

  it('lists, parses, digests, and inspects an Antigravity transcript fixture', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crunes-session-test-'))
    const env = setupCrunesTest({ cwd: tmp })
    try {
      makeAgyFixture(tmp)
      const sessions = await listSessions({ homeDir: tmp, all: true, harness: 'agy' })
      assert.equal(sessions.length, 1)
      assert.equal(sessions[0].shortId, '11111111')

      const parsed = await parseSession('11111111', { homeDir: tmp, harness: 'agy' })
      const digest = formatDigestMarkdown(parsed, { format: 'compact' })
      assert.match(digest, /Check the status of the demo workspace/)
      assert.match(digest, /Everything in the demo workspace is clean/)

      const inspected = await formatInspectMarkdown(parsed, '1..2', { format: 'extended' })
      assert.match(inspected, /Step #1/)
      assert.match(inspected, /Step #2/)
    } finally {
      await env.cleanup()
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('orders by transcript endedAt even when mtimeMs is reversed and formats fmtTok', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crunes-session-order-'))
    const env = setupCrunesTest({ cwd: tmp })
    return (async () => {
      try {
        const p1 = path.join(tmp, '.claude', 'projects', 'c--Users-test-Work-org-bubuu-backend')
        fs.mkdirSync(p1, { recursive: true })
        const fOld = path.join(p1, 'aaaaaaaa-1111-1111-1111-111111111111.jsonl')
        const fNew = path.join(p1, 'bbbbbbbb-2222-2222-2222-222222222222.jsonl')

        fs.writeFileSync(fOld, [
          JSON.stringify({ type: 'user', timestamp: '2026-11-24T10:00:00Z', message: { content: 'Old session' } }),
          JSON.stringify({
            type: 'assistant',
            timestamp: '2026-11-24T10:05:00Z',
            requestId: 'r1',
            message: { id: 'm1', model: 'claude-opus-5-5', usage: { input_tokens: 100, cache_creation_input_tokens: 1000, cache_read_input_tokens: 9000, output_tokens: 200 }, content: [{ type: 'text', text: 'Done old' }] },
          }),
          JSON.stringify({
            type: 'assistant',
            timestamp: '2026-11-24T10:05:01Z',
            requestId: 'r1',
            message: { id: 'm1', model: 'claude-opus-5-5', usage: { input_tokens: 100, cache_creation_input_tokens: 1000, cache_read_input_tokens: 9000, output_tokens: 200 }, content: [{ type: 'text', text: 'Done old' }] },
          }),
        ].join('\n') + '\n')

        fs.writeFileSync(fNew, [
          JSON.stringify({ type: 'user', timestamp: '2026-11-24T12:00:00Z', message: { content: 'New session' } }),
          JSON.stringify({
            type: 'assistant',
            timestamp: '2026-11-24T12:15:00Z',
            requestId: 'r2',
            message: { id: 'm2', model: 'claude-sonnet-5-5', usage: { input_tokens: 50, cache_creation_input_tokens: 500, cache_read_input_tokens: 2000, output_tokens: 100 }, content: [{ type: 'text', text: 'Done new' }] },
          }),
        ].join('\n') + '\n')

        // Reverse filesystem mtime so fOld looks newer on disk
        const tNew = new Date('2026-11-20T00:00:00Z')
        const tOld = new Date('2026-11-25T00:00:00Z')
        fs.utimesSync(fNew, tNew, tNew)
        fs.utimesSync(fOld, tOld, tOld)

        const recent = await listSessions({ homeDir: tmp, all: true, sort: 'recent' })
        assert.equal(recent[0].shortId, 'bbbbbbbb')
        assert.equal(recent[0].project, 'bubuu-backend')

        const byTok = await listSessions({ homeDir: tmp, all: true, sort: 'tokens' })
        assert.equal(byTok[0].shortId, 'aaaaaaaa')
        assert.equal(byTok[0].usage.total, 10300) // deduped r1:m1!
        assert.equal(fmtTok(byTok[0].usage), '10.3k/1.1k/200 (89% cr)')
        assert.equal(fmtDuration(recent[0].durationMs), '15m')

        const parsed = await parseSession('aaaaaaaa', { homeDir: tmp, harness: 'claude' })
        const statMd = formatStatMarkdown(parsed)
        assert.match(statMd, /# Stat aaaaaaaa/)
        assert.match(statMd, /10\.3k\/1\.1k\/200 \(89% cr\)/)
        assert.match(statMd, /Hot turns/)
      } finally {
        await env.cleanup()
        fs.rmSync(tmp, { recursive: true, force: true })
      }
    })()
  })

  it('pairs Antigravity GENERIC tool results across interleaved EPHEMERAL_MESSAGE and aggregates tokens', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crunes-session-agy-eph-'))
    const env = setupCrunesTest({ cwd: tmp })
    try {
      const convId = '22222222-3333-4444-5555-666666666666'
      const logsDir = path.join(tmp, '.gemini', 'antigravity', 'brain', convId, '.system_generated', 'logs')
      fs.mkdirSync(logsDir, { recursive: true })
      fs.writeFileSync(path.join(logsDir, 'transcript.jsonl'), [
        JSON.stringify({ step_index: 0, type: 'USER_INPUT', created_at: '2026-11-24T10:00:00Z', content: 'Run check' }),
        JSON.stringify({
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          created_at: '2026-11-24T10:00:10Z',
          input_tokens: 1000,
          cache_read_tokens: 9000,
          output_tokens: 200,
          thinking: 'Checking...',
          content: 'Running bash',
          tool_calls: [{ name: 'run_command', args: { CommandLine: 'npm test' } }],
        }),
        JSON.stringify({ step_index: 2, source: 'SYSTEM_SDK', type: 'EPHEMERAL_MESSAGE', created_at: '2026-11-24T10:00:11Z', content: 'Dexter anchor (abc1234)' }),
        JSON.stringify({ step_index: 3, type: 'GENERIC', status: 'ERROR', created_at: '2026-11-24T10:00:15Z', content: 'Command exited with code 1\nTest failed' }),
      ].join('\n') + '\n')

      const parsed = await parseSession('22222222', { homeDir: tmp, harness: 'agy' })
      assert.equal(parsed.meta.errors.length, 1)
      assert.equal(parsed.meta.usage.total, 10200)
      const statMd = formatStatMarkdown(parsed)
      assert.match(statMd, /10\.2k\/1k\/200 \(90% cr\)/)
      assert.match(statMd, /1 thinking turns/)
    } finally {
      await env.cleanup()
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('lists, parses, stats, digests, and inspects a Codex rollout transcript fixture', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crunes-session-codex-'))
    const env = setupCrunesTest({ cwd: tmp })
    try {
      const sessDir = path.join(tmp, '.codex', 'sessions', '2026', '11', '25')
      fs.mkdirSync(sessDir, { recursive: true })
      const sessId = '33333333-4444-5555-6666-777777777777'
      const rolloutFile = path.join(sessDir, `rollout-2026-11-25T10-00-00-${sessId}.jsonl`)
      fs.writeFileSync(rolloutFile, [
        JSON.stringify({
          timestamp: '2026-11-25T10:00:00.000Z',
          type: 'session_meta',
          payload: {
            id: sessId,
            cwd: '/home/user/demo-app',
            git: { branch: 'feat/codex' },
          },
        }),
        JSON.stringify({
          timestamp: '2026-11-25T10:00:01.000Z',
          type: 'turn_context',
          payload: { cwd: '/home/user/demo-app', model: 'gpt-6.1-sol' },
        }),
        JSON.stringify({
          timestamp: '2026-11-25T10:00:02.000Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: 'Check failing tests in demo-app' },
        }),
        JSON.stringify({
          timestamp: '2026-11-25T10:00:03.000Z',
          type: 'response_item',
          payload: {
            type: 'custom_tool_call',
            call_id: 'call_1',
            name: 'exec',
            input: 'text(await tools.exec_command({cmd:"npm test"}));',
          },
        }),
        JSON.stringify({
          timestamp: '2026-11-25T10:00:05.000Z',
          type: 'response_item',
          payload: {
            type: 'custom_tool_call_output',
            call_id: 'call_1',
            output: [{ type: 'input_text', text: '{"exit_code":1,"output":"1 test failed"}' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-11-25T10:00:06.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Found 1 failing test in demo-app.' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-11-25T10:00:07.000Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: { input_tokens: 10000, cached_input_tokens: 9000, cache_write_input_tokens: 0, output_tokens: 200, total_tokens: 10200 },
              last_token_usage: { input_tokens: 10000, cached_input_tokens: 9000, cache_write_input_tokens: 0, output_tokens: 200, total_tokens: 10200 },
            },
          },
        }),
      ].join('\n') + '\n')

      const sessions = await listSessions({ homeDir: tmp, all: true, harness: 'codex' })
      assert.equal(sessions.length, 1)
      assert.equal(sessions[0].shortId, '33333333')
      assert.equal(sessions[0].project, 'demo-app')
      assert.equal(sessions[0].branch, 'feat/codex')
      assert.equal(sessions[0].usage.total, 10200)

      const parsed = await parseSession('33333333', { homeDir: tmp, harness: 'codex' })
      assert.equal(parsed.meta.errors.length, 1)
      assert.equal(parsed.meta.toolCounts.bash, 1)

      const statMd = formatStatMarkdown(parsed)
      assert.match(statMd, /10\.2k\/1k\/200 \(90% cr\)/)

      const digestMd = formatDigestMarkdown(parsed, { format: 'standard' })
      assert.match(digestMd, /Check failing tests in demo-app/)
      assert.match(digestMd, /Found 1 failing test in demo-app/)
      assert.match(digestMd, /exit 1/)

      const inspectMd = await formatInspectMarkdown(parsed, '0..2', { format: 'extended' })
      assert.match(inspectMd, /1 test failed/)

      const hits = await searchSessions('failing tests', { homeDir: tmp, all: true, harness: 'codex' })
      assert.equal(hits.length, 1)
      assert.equal(hits[0].shortId, '33333333')
      assert.equal(hits[0].kind, 'user')
    } finally {
      await env.cleanup()
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

})

describe('session.js (Antigravity folders)', () => {
  it('lists desktop, CLI and IDE sessions and skips folders that do not exist', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crunes-session-agy-apps-'))
    const env = setupCrunesTest({ cwd: tmp })
    const opts = { homeDir: tmp, all: true, noCache: true }
    try {
      makeAgyFixture(tmp, 'antigravity-cli', 'cccccccc-2222-3333-4444-555555555555')
      assert.deepEqual((await listSessions(opts)).map(s => s.shortId), ['cccccccc'])
      makeAgyFixture(tmp, 'antigravity', 'aaaaaaaa-2222-3333-4444-555555555555')
      makeAgyFixture(tmp, 'antigravity-ide', 'bbbbbbbb-2222-3333-4444-555555555555')
      const list = await listSessions({ ...opts, harness: 'agy' })
      assert.deepEqual(list.map(s => s.shortId).sort(), ['aaaaaaaa', 'bbbbbbbb', 'cccccccc'])
      assert.deepEqual([...new Set(list.map(s => s.harness))], ['agy'])
      assert.equal((await listSessions({ ...opts, agyDir: path.join(tmp, '.gemini', 'antigravity-cli', 'brain') })).length, 1)
    } finally {
      await env.cleanup()
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('lists an id present in two folders once, using the newest copy', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crunes-session-agy-dup-'))
    const env = setupCrunesTest({ cwd: tmp })
    try {
      const id = makeAgyFixture(tmp, 'antigravity')
      makeAgyFixture(tmp, 'antigravity-cli')
      const old = new Date('2026-11-20T00:00:00Z')
      fs.utimesSync(path.join(tmp, '.gemini', 'antigravity', 'brain', id, '.system_generated', 'logs', 'transcript.jsonl'), old, old)
      const list = await listSessions({ homeDir: tmp, all: true, noCache: true })
      assert.equal(list.length, 1)
      assert.match(list[0].path, /antigravity-cli/)
    } finally {
      await env.cleanup()
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('session.js (token sources and compressed files)', () => {
  it('takes Antigravity tokens from the database only when the transcript has none', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crunes-session-agydb-'))
    const env = setupCrunesTest({ cwd: tmp })
    try {
      const bare = makeAgyFixture(tmp, 'antigravity-ide', 'aaaaaaaa-2222-3333-4444-555555555555')
      makeAgyDatabase(tmp, 'antigravity-ide', bare)
      const counted = makeAgyFixture(tmp, 'antigravity', 'bbbbbbbb-2222-3333-4444-555555555555')
      makeAgyDatabase(tmp, 'antigravity', counted)
      fs.appendFileSync(path.join(tmp, '.gemini/antigravity/brain', counted, '.system_generated/logs/transcript.jsonl'), JSON.stringify({ step_index: 3, type: 'PLANNER_RESPONSE', created_at: '2026-11-22T10:01:00Z', input_tokens: 7, output_tokens: 1, content: 'x' }) + '\n')
      const noDb = makeAgyFixture(tmp, 'antigravity-cli', 'cccccccc-2222-3333-4444-555555555555')
      const list = await listSessions({ homeDir: tmp, all: true, noCache: true })
      const total = id => list.find(s => s.id === id).usage.total
      assert.deepEqual([total(bare), total(counted), total(noDb)], [AGY_DB_TOTAL, 8, 0])
      assert.equal(fs.existsSync(path.join(tmp, '.gemini/antigravity-cli/conversations')), false)
      const parsed = await parseSession('aaaaaaaa', { homeDir: tmp })
      assert.equal(parsed.meta.usage.total, AGY_DB_TOTAL)
      assert.match(formatStatMarkdown(parsed), /43 turns/)
    } finally {
      await env.cleanup()
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('counts a Codex session by its own records, in list and stat alike', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crunes-session-fork-'))
    const env = setupCrunesTest({ cwd: tmp })
    const C = '20000000-0000-4000-8000-000000000000', PARENT = '10000000-0000-4000-8000-000000000000'
    const at = i => `2026-11-24T10:00:${String(i).padStart(2, '0')}Z`
    const meta = from => ({ timestamp: at(0), type: 'session_meta', payload: { id: C, cwd: '/w/d', ...(from && { forked_from_id: from }) } })
    const rec = (i, thread, n, id = `r${i}`) => ({ timestamp: at(i), type: 'token_usage_record', payload: { thread_id: thread, response_id: id, usage: { input_tokens: n }, turn_token_usage: { input_tokens: 99999 } } })
    const tok = (i, last, total) => ({ timestamp: at(i), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: last, total_tokens: last }, total_token_usage: { input_tokens: total, total_tokens: total } } } })
    const both = (i, thread, n, total) => [rec(i, thread, n), tok(i, n, total)]
    const cases = {
      'fork with copied parent history': [[meta(PARENT), ...both(1, PARENT, 100, 100), ...both(2, PARENT, 200, 300), ...both(3, C, 400, 700), ...both(4, C, 500, 1200)], 900],
      'fork with records only': [[meta(PARENT), rec(1, PARENT, 300), rec(3, C, 400), rec(4, C, 500)], 900],
      'copied history without a fork marker': [[meta(), ...both(1, PARENT, 300, 300), ...both(3, C, 900, 1200)], 900],
      'running total that lost usage': [[meta(), ...both(1, C, 400, 400), ...both(2, C, 500, 500)], 900],
      'a response recorded twice': [[meta(), rec(1, C, 400, 'same'), rec(2, C, 400, 'same'), rec(3, C, 500)], 900],
      'older Codex wrote the first part': [[meta(), tok(1, 400, 400), ...both(2, C, 500, 900)], 900],
      'no records at all': [[meta(), tok(1, 400, 400), tok(2, 500, 900)], 900],
    }
    try {
      const file = path.join(tmp, '.codex', 'sessions', `rollout-${C}.jsonl`)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      for (const [name, [rows, want]] of Object.entries(cases)) {
        fs.writeFileSync(file, rows.map(o => JSON.stringify(o)).join('\n') + '\n')
        const [s] = await listSessions({ homeDir: tmp, all: true, subagents: true, noCache: true })
        assert.equal(s.usage.total, want, `list: ${name}`)
        assert.equal((await parseSession(s)).meta.usage.total, want, `stat: ${name}`)
      }
    } finally {
      await env.cleanup()
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('lists, reads and searches compressed Codex sessions, preferring the plain copy', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crunes-session-zst-'))
    const env = setupCrunesTest({ cwd: tmp })
    const rows = n => [
      { timestamp: '2026-11-24T10:00:00Z', type: 'session_meta', payload: { cwd: '/w/demo' } },
      { timestamp: '2026-11-24T10:00:01Z', type: 'event_msg', payload: { type: 'user_message', message: `Запит ${n}` } },
      ...Array.from({ length: 200 }, () => ({ type: 'x', payload: {} })),
      { timestamp: '2026-11-24T10:00:02Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 5 } } } },
      ...Array.from({ length: 10 }, () => ({ type: 'x', payload: {} })),
    ].map(o => JSON.stringify(o)).join('\n')
    const at = (dir, n, ext) => path.join(tmp, '.codex', dir, `rollout-${n}0000000-0000-4000-8000-000000000000.jsonl${ext}`)
    try {
      for (const d of ['sessions', 'archived_sessions']) fs.mkdirSync(path.join(tmp, '.codex', d), { recursive: true })
      fs.writeFileSync(at('sessions', 1, ''), rows(1))
      fs.writeFileSync(at('sessions', 1, '.zst'), zstdCompressSync(Buffer.from(rows(1))))
      fs.writeFileSync(at('archived_sessions', 2, '.zst'), zstdCompressSync(Buffer.from(rows(2))))
      fs.writeFileSync(at('archived_sessions', 3, '.zst'), 'not zstd')
      const skipped = []
      const opts = { homeDir: tmp, all: true, cacheFile: path.join(tmp, 'cache.json') }
      const list = await listSessions({ ...opts, onSkip: s => skipped.push(s.id.slice(0, 1)) })
      assert.deepEqual(list.map(s => [s.shortId, s.path.endsWith('.zst')]).sort(), [['10000000', false], ['20000000', true]])
      assert.deepEqual(skipped, ['3'])
      const z = list.find(s => s.shortId === '20000000')
      assert.deepEqual([z.firstPrompt, z.usage.total, z.endedAt], ['Запит 2', 5, '2026-11-24T10:00:02Z'])
      assert.match(formatDigestMarkdown(await parseSession('20000000', opts)), /Запит 2/)
      assert.deepEqual((await searchSessions('Запит 2', opts)).map(h => h.shortId), ['20000000'])
      assert.equal((await resolveSession(z.path, opts)).harness, 'codex')
    } finally {
      await env.cleanup()
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('session.js (large and broken transcripts)', () => {
  const writeCodex = (tmp, n, lines) => {
    const dir = path.join(tmp, '.codex', 'sessions')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `rollout-00000000-0000-4000-8000-${String(n).padStart(12, '0')}.jsonl`)
    fs.writeFileSync(file, lines.join('\n') + '\n')
    return file
  }
  const meta = { timestamp: '2026-11-24T10:00:00Z', type: 'session_meta', payload: { cwd: '/w/demo' } }
  const prompt = { timestamp: '2026-11-24T10:00:01Z', type: 'event_msg', payload: { type: 'user_message', message: 'Привіт' } }
  const small = [JSON.stringify(meta), JSON.stringify(prompt)]

  it('summarizes a transcript without reading it whole, in discovery and by path', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crunes-session-stream-'))
    const reads = []
    const env = setupCrunesTest({ cwd: tmp })
    const realRead = env.utils.fs.read
    env.utils.fs.read = (p, o) => { if (!o || (o.from == null && o.to == null)) reads.push(p); return realRead(p, o) }
    try {
      const file = writeCodex(tmp, 1, [...small, ...Array(500).fill(JSON.stringify({ timestamp: '2026-11-24T11:00:00Z', type: 'x', payload: { pad: 'x'.repeat(3000) } }))])
      const [s] = await listSessions({ homeDir: tmp, all: true, harness: 'codex', noCache: true })
      assert.equal(s.firstPrompt, 'Привіт')
      assert.equal(s.project, 'demo')
      assert.equal(s.endedAt, '2026-11-24T11:00:00Z')
      const byPath = await resolveSession(file, { homeDir: tmp })
      assert.equal(byPath.harness, 'codex')
      assert.deepEqual(reads, [])
    } finally {
      await env.cleanup()
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('takes the end time past a run of undated last lines, and lists a file whose last lines are huge', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crunes-session-tail-'))
    const env = setupCrunesTest({ cwd: tmp })
    const realRead = env.utils.fs.read
    const ranges = []
    env.utils.fs.read = (p, o) => { if (o && o.from < 0) ranges.push(o.from); return realRead(p, o) }
    const dated = i => JSON.stringify({ timestamp: `2026-11-24T11:00:${String(i % 60).padStart(2, '0')}Z`, type: 'x', payload: { pad: 'я'.repeat(20_000) } })
    const undated = JSON.stringify({ type: 'x', payload: {} })
    try {
      writeCodex(tmp, 1, [...small, dated(7), ...Array(90).fill(undated)])
      const large = writeCodex(tmp, 2, [...small, ...Array(60).fill(dated(1)), dated(9), ...Array(5).fill(undated)])
      assert.ok(fs.statSync(large).size > 1024 * 1024)
      const list = await listSessions({ homeDir: tmp, all: true, noCache: true, harness: 'codex' })
      const end = n => list.find(s => s.path.endsWith(`${n}.jsonl`)).endedAt
      assert.equal(end(1), '2026-11-24T11:00:07Z')
      assert.equal(end(2), '2026-11-24T11:00:09Z')
      assert.deepEqual(ranges, [-1, -2, -4, -8])
    } finally {
      await env.cleanup()
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('finds a Claude title written late in a large transcript', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crunes-session-title-'))
    const env = setupCrunesTest({ cwd: tmp })
    try {
      const dir = path.join(tmp, '.claude', 'projects', 'c--w-demo')
      fs.mkdirSync(dir, { recursive: true })
      const row = i => ({ type: 'user', timestamp: '2026-11-24T10:00:00Z', message: { content: i === 0 ? 'Запит' : [{ type: 'tool_result', tool_use_id: 't', content: 'вивід'.repeat(600) }] } })
      const rows = [...Array.from({ length: 300 }, (_, i) => row(i)), { type: 'ai-title', aiTitle: 'Пізня назва' }, ...Array.from({ length: 50 }, (_, i) => row(i + 1))]
      fs.writeFileSync(path.join(dir, 'aaaaaaaa-1111-1111-1111-111111111111.jsonl'), rows.map(o => JSON.stringify(o)).join('\n') + '\n')
      const [s] = await listSessions({ homeDir: tmp, all: true, noCache: true, harness: 'claude' })
      assert.deepEqual([s.title, s.firstPrompt], ['Пізня назва', 'Запит'])
    } finally {
      await env.cleanup()
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('lists archived Codex sessions, preferring the active copy', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crunes-session-archived-'))
    const env = setupCrunesTest({ cwd: tmp })
    const opts = { homeDir: tmp, all: true, noCache: true }
    try {
      const active = writeCodex(tmp, 1, small)
      const archive = path.join(tmp, '.codex', 'archived_sessions')
      fs.mkdirSync(archive)
      fs.copyFileSync(active, path.join(archive, path.basename(active)))
      fs.copyFileSync(active, path.join(archive, path.basename(active).replace('000000000001', '000000000002')))
      const list = await listSessions({ ...opts, harness: 'codex' })
      assert.deepEqual(list.map(s => [s.path.includes('archived_sessions'), s.path.slice(-7, -6)]).sort(), [[false, '1'], [true, '2']])
      fs.rmSync(path.join(tmp, '.codex', 'sessions'), { recursive: true })
      assert.equal((await listSessions(opts)).length, 2)
    } finally {
      await env.cleanup()
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  // Transcripts under 1 MB are read once, larger ones by parts; both must agree.
  for (const [label, pad] of [['small', 1], ['large', 600]]) it(`counts records from the middle of a ${label} transcript and takes the end time from its tail`, async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crunes-session-middle-'))
    const env = setupCrunesTest({ cwd: tmp })
    const at = i => new Date(Date.UTC(2026, 10, 24, 10, 0, i)).toISOString()
    const bulk = i => ({ timestamp: at(i), type: 'response_item', payload: { type: 'function_call_output', call_id: 'c', output: 'вивід "token_count"'.repeat(pad) } })
    try {
      const codex = Array.from({ length: 400 }, (_, i) => bulk(i))
      codex[0] = { timestamp: at(0), type: 'session_meta', payload: { cwd: '/w/demo' } }
      codex[150] = { timestamp: at(150), type: 'event_msg', payload: { type: 'user_message', message: 'Пізній запит' } }
      codex[200] = { timestamp: at(200), type: 'turn_context', payload: { model: 'late-model' } }
      codex[250] = { timestamp: at(250), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 40, output_tokens: 2 } } } }
      // One record written with spaces after its colons.
      writeCodex(tmp, 1, codex.map((o, i) => i === 250 ? JSON.stringify(o, null, 1).replace(/\n\s*/g, ' ') : JSON.stringify(o)))
      const [c] = await listSessions({ homeDir: tmp, all: true, noCache: true, harness: 'codex' })
      assert.deepEqual([c.firstPrompt, c.model, c.usage.total, c.startedAt, c.endedAt], ['Пізній запит', 'late-model', 42, at(0), at(399)])

      const dir = path.join(tmp, '.claude', 'projects', 'c--w-demo')
      fs.mkdirSync(dir, { recursive: true })
      const claude = Array.from({ length: 400 }, (_, i) => i === 200
        ? { type: 'assistant', timestamp: at(i), cwd: '/w/demo', requestId: 'r', message: { id: 'm', usage: { input_tokens: 5, output_tokens: 1 }, content: [] } }
        : { type: 'user', timestamp: at(i), message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'вивід'.repeat(pad) }] } })
      fs.writeFileSync(path.join(dir, 'aaaaaaaa-1111-1111-1111-111111111111.jsonl'), claude.map(o => JSON.stringify(o)).join('\n') + '\n')
      const [a] = await listSessions({ homeDir: tmp, all: true, noCache: true, harness: 'claude' })
      assert.deepEqual([a.cwd, a.usage.total, a.startedAt, a.endedAt], ['/w/demo', 6, at(0), at(399)])
    } finally {
      await env.cleanup()
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('falls back to file dates for a transcript without timestamps', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crunes-session-notime-'))
    const env = setupCrunesTest({ cwd: tmp })
    try {
      const file = writeCodex(tmp, 1, [JSON.stringify({ type: 'session_meta', payload: { cwd: '/w/demo' } })])
      const when = new Date('2026-11-20T00:00:00Z')
      fs.utimesSync(file, when, when)
      const [s] = await listSessions({ homeDir: tmp, all: true, noCache: true })
      assert.equal(s.endedAt, when.toISOString())
      assert.equal(s.mtimeMs, when.getTime())
    } finally {
      await env.cleanup()
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('rescans a cached transcript edited without changing its size', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crunes-session-samesize-'))
    const env = setupCrunesTest({ cwd: tmp })
    const opts = { homeDir: tmp, all: true, cacheFile: path.join(tmp, 'cache.json') }
    const withPrompt = message => [small[0], JSON.stringify({ ...prompt, payload: { type: 'user_message', message } })]
    try {
      const file = writeCodex(tmp, 1, withPrompt('first'))
      fs.utimesSync(file, new Date('2026-11-20T00:00:00Z'), new Date('2026-11-20T00:00:00Z'))
      assert.equal((await listSessions(opts))[0].firstPrompt, 'first')
      writeCodex(tmp, 1, withPrompt('other'))
      fs.utimesSync(file, new Date('2026-11-21T00:00:00Z'), new Date('2026-11-21T00:00:00Z'))
      assert.equal((await listSessions(opts))[0].firstPrompt, 'other')
    } finally {
      await env.cleanup()
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('reports an unreadable transcript and still lists the rest', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crunes-session-skip-'))
    const env = setupCrunesTest({ cwd: tmp })
    const realRead = env.utils.fs.read
    env.utils.fs.read = (p, o) => {
      if (p.endsWith('000000000001.jsonl')) throw new Error('unreadable')
      return realRead(p, o)
    }
    try {
      writeCodex(tmp, 1, small)
      writeCodex(tmp, 2, small)
      const skipped = []
      const list = await listSessions({ homeDir: tmp, all: true, noCache: true, onSkip: (stub, err) => skipped.push(err.message) })
      assert.equal(list.length, 1)
      assert.deepEqual(skipped, ['unreadable'])
    } finally {
      await env.cleanup()
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  const call = (id, n) => JSON.stringify({ timestamp: '2026-11-24T10:00:02Z', type: 'response_item', payload: { type: 'function_call', call_id: id, name: 'shell', arguments: JSON.stringify({ command: `run ${n}` }) } })
  const result = (id, output) => JSON.stringify({ timestamp: '2026-11-24T10:00:03Z', type: 'response_item', payload: { type: 'function_call_output', call_id: id, output } })
  const big = 'вивід '.repeat(2000)

  it('drops tool output a command does not show, and keeps it for inspected steps', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crunes-session-keep-'))
    const env = setupCrunesTest({ cwd: tmp })
    try {
      const file = writeCodex(tmp, 1, [...small, call('a', 1), result('a', `first ${big}`), call('b', 2), result('b', `second ${big}`)])
      const load = keep => parseSession(file, { homeDir: tmp, keep })
      const held = p => JSON.stringify(p).length
      assert.ok(held(await load()) > 20_000)
      assert.ok(held(await load(keepForDigest('compact'))) < 10_000)
      const full = formatDigestMarkdown(await load(), { format: 'extended' })
      assert.equal(formatDigestMarkdown(await load(keepForDigest('extended')), { format: 'extended' }), full)
      const inspected = await formatInspectMarkdown(await load(keepForInspect('2')), '2', { format: 'full' })
      assert.equal(inspected, await formatInspectMarkdown(await load(), '2', { format: 'full' }))
      assert.match(inspected, /second/)
    } finally {
      await env.cleanup()
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('pairs a repeated call and a result written before its call', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crunes-session-repeat-'))
    const env = setupCrunesTest({ cwd: tmp })
    try {
      const file = writeCodex(tmp, 1, [...small, call('a', 1), result('a', 'repeated output'), result('z', 'early output'), call('z', 2), call('a', 1)])
      const show = async step => formatInspectMarkdown(await parseSession(file, { homeDir: tmp, keep: keepForInspect(step) }), step, { format: 'full' })
      assert.match(await show('1'), /repeated output/)
      assert.match(await show('2'), /early output/)
      assert.match(await show('3'), /repeated output/)
    } finally {
      await env.cleanup()
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('searches inside dropped tool output and reports a session it cannot read', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crunes-session-search-'))
    const env = setupCrunesTest({ cwd: tmp })
    const realStream = env.utils.fs.readLinesStream
    try {
      writeCodex(tmp, 1, [...small, call('a', 1), result('a', `${big} needle-here`)])
      writeCodex(tmp, 2, small)
      const opts = { homeDir: tmp, all: true, cacheFile: path.join(tmp, 'cache.json') }
      await listSessions(opts)
      env.utils.fs.readLinesStream = (p, o) => {
        if (p.endsWith('000000000002.jsonl')) throw new Error('unreadable')
        return realStream(p, o)
      }
      const skipped = []
      const hits = await searchSessions('needle-here', { ...opts, onSkip: (_, err) => skipped.push(err.message) })
      assert.deepEqual(hits.map(h => h.kind.startsWith('tool:')), [true])
      assert.deepEqual(skipped, ['unreadable'])
    } finally {
      await env.cleanup()
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('keeps finished summaries when a long first scan is interrupted', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crunes-session-resume-'))
    const env = setupCrunesTest({ cwd: tmp })
    const realRead = env.utils.fs.read
    let scans = 0
    let failAfter = 120
    env.utils.fs.read = (p, o) => {
      if (!p.endsWith('.jsonl')) return realRead(p, o)
      if (scans >= failAfter) throw new Error('stop')
      scans += 1
      return realRead(p, o)
    }
    try {
      for (let i = 0; i < 150; i++) writeCodex(tmp, i, small)
      const opts = { homeDir: tmp, all: true, limit: 200, cacheFile: path.join(tmp, 'cache.json') }
      await assert.rejects(listSessions({ ...opts, onSkip: (_, err) => { throw err } }), /stop/)
      scans = 0
      failAfter = Infinity
      assert.equal((await listSessions(opts)).length, 150)
      assert.equal(scans, 50)
    } finally {
      await env.cleanup()
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('session.rune.js (E2E isolate)', () => {
  it('reads Antigravity databases and compressed Codex files with only their own grants, leaving the databases unchanged', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crunes-session-foreign-'))
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(srcDir, '../.crunes-plugin/plugin.json'), 'utf8'))
      const apps = { antigravity: 'aaaaaaaa', 'antigravity-cli': 'cccccccc', 'antigravity-ide': 'bbbbbbbb' }
      const dbs = Object.entries(apps).map(([app, id]) => makeAgyDatabase(tmp, app, makeAgyFixture(tmp, app, `${id}-2222-3333-4444-555555555555`)))
      const before = dbs.map(f => fs.readFileSync(f).toString('base64'))
      for (const [dir, id] of [['sessions', '10000000'], ['archived_sessions', '20000000']]) {
        fs.mkdirSync(path.join(tmp, '.codex', dir), { recursive: true })
        fs.writeFileSync(path.join(tmp, '.codex', dir, `rollout-${id}-0000-4000-8000-000000000000.jsonl.zst`), zstdCompressSync(Buffer.from(JSON.stringify({ timestamp: '2026-11-24T10:00:00Z', type: 'event_msg', payload: { type: 'user_message', message: `ask ${id}` } }) + '\n')))
      }
      const allow = manifest.runes.session.run.permissions.allow.filter(p => p.includes('~/.codex/') || p.includes('.gemini/antigravity'))
      fs.mkdirSync(path.join(tmp, '.crunes', 'runes'), { recursive: true })
      fs.cpSync(srcDir, path.join(tmp, '.crunes', 'runes', 'session'), { recursive: true })
      fs.writeFileSync(path.join(tmp, '.crunes', 'config.json'), JSON.stringify({
        runes: { session: { run: { command: '.crunes/runes/session/index.rune.js', permissions: { allow: [...allow, 'fs.read:./.crunes/runes/session/**', ...Object.values(apps).map(id => `fs.read:${id}`)] } } } },
      }))
      const env = { ...process.env, HOME: tmp, USERPROFILE: tmp }
      const agy = runCrunes(tmp, ['-p', 'run', 'session', 'list', '--all', '--harness', 'agy'], env)
      assert.equal(agy.match(/73\.4k\//g)?.length, 3)
      for (const id of Object.values(apps)) assert.match(runCrunes(tmp, ['-p', 'run', 'session', 'stat', id, '--harness', 'agy'], env), /73\.4k\//)
      const codex = runCrunes(tmp, ['-p', 'run', 'session', 'list', '--all', '--harness', 'codex'], env)
      assert.match(codex, /ask 10000000/)
      assert.match(codex, /ask 20000000/)
      assert.deepEqual(dbs.map(f => fs.readFileSync(f).toString('base64')), before)
      assert.deepEqual(fs.readdirSync(path.dirname(dbs[0])), [path.basename(dbs[0])])
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('reads both Codex folders with only the grants plugin.json declares for them', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crunes-session-codexgrants-'))
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(srcDir, '../.crunes-plugin/plugin.json'), 'utf8'))
      const ids = { sessions: '10000000', archived_sessions: '20000000' }
      for (const [dir, id] of Object.entries(ids)) {
        fs.mkdirSync(path.join(tmp, '.codex', dir), { recursive: true })
        fs.writeFileSync(path.join(tmp, '.codex', dir, `rollout-${id}-0000-4000-8000-000000000000.jsonl`), JSON.stringify({ timestamp: '2026-11-24T10:00:00Z', type: 'event_msg', payload: { type: 'user_message', message: `ask ${id}` } }) + '\n')
      }
      const allow = manifest.runes.session.run.permissions.allow.filter(p => p.includes('~/.codex/'))
      fs.mkdirSync(path.join(tmp, '.crunes', 'runes'), { recursive: true })
      fs.cpSync(srcDir, path.join(tmp, '.crunes', 'runes', 'session'), { recursive: true })
      fs.writeFileSync(path.join(tmp, '.crunes', 'config.json'), JSON.stringify({
        runes: { session: { run: { command: '.crunes/runes/session/index.rune.js', permissions: { allow: [...allow, 'fs.read:./.crunes/runes/session/**', ...Object.values(ids).map(id => `fs.read:${id}`)] } } } },
      }))
      const env = { ...process.env, HOME: tmp, USERPROFILE: tmp }
      const listOut = runCrunes(tmp, ['-p', 'run', 'session', 'list', '--all', '--harness', 'codex'], env)
      for (const id of Object.values(ids)) {
        assert.match(listOut, new RegExp(`ask ${id}`))
        assert.match(runCrunes(tmp, ['-p', 'run', 'session', 'digest', id, '--harness', 'codex'], env), new RegExp(`ask ${id}`))
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('reads every Antigravity folder with only the grants plugin.json declares for it', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crunes-session-grants-'))
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(srcDir, '../.crunes-plugin/plugin.json'), 'utf8'))
      const ids = { antigravity: 'aaaaaaaa', 'antigravity-cli': 'cccccccc', 'antigravity-ide': 'bbbbbbbb' }
      for (const [app, id] of Object.entries(ids)) makeAgyFixture(tmp, app, `${id}-2222-3333-4444-555555555555`)
      // The broad fs.read:** grant is left out on purpose: it would hide a missing folder grant.
      const allow = manifest.runes.session.run.permissions.allow.filter(p => p.includes('.gemini/antigravity'))
      fs.mkdirSync(path.join(tmp, '.crunes', 'runes'), { recursive: true })
      fs.cpSync(srcDir, path.join(tmp, '.crunes', 'runes', 'session'), { recursive: true })
      fs.writeFileSync(path.join(tmp, '.crunes', 'config.json'), JSON.stringify({
        runes: { session: { run: { command: '.crunes/runes/session/index.rune.js', permissions: { allow: [...allow, 'fs.read:./.crunes/runes/session/**', ...Object.values(ids).map(id => `fs.read:${id}`)] } } } },
      }))
      const env = { ...process.env, HOME: tmp, USERPROFILE: tmp }
      const helpOut = runCrunes(tmp, ['-p', 'run', 'session', 'list', '--help'], env)
      assert.match(helpOut, /List recent sessions/)
      assert.doesNotMatch(helpOut, /11111111/)

      const listOut = runCrunes(tmp, ['-p', 'run', 'session', 'list', '--all', '--harness', 'agy'], env)
      for (const id of Object.values(ids)) {
        assert.match(listOut, new RegExp(id))
        assert.match(runCrunes(tmp, ['-p', 'run', 'session', 'digest', id, '--harness', 'agy'], env), /Everything in the demo workspace is clean/)
        assert.match(runCrunes(tmp, ['-p', 'run', 'session', 'inspect', id, '1..2', '--harness', 'agy'], env), /Step #2/)
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('runs list, digest, and inspect inside isolated-vm using ~/ grants', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crunes-session-iso-'))
    try {
      makeAgyFixture(tmp)
      fs.mkdirSync(path.join(tmp, '.crunes', 'runes'), { recursive: true })
      fs.cpSync(srcDir, path.join(tmp, '.crunes', 'runes', 'session'), { recursive: true })
      fs.writeFileSync(
        path.join(tmp, '.crunes', 'config.json'),
        JSON.stringify({
          format: '1',
          runes: {
            session: {
              run: {
                command: '.crunes/runes/session/index.rune.js',
                permissions: {
                  allow: [
                    'fs.glob:~/.claude/projects::**/*.jsonl',
                    'fs.glob:~/.gemini/antigravity/brain::**/transcript.jsonl',
                    'fs.read:~/.claude/projects/**',
                    'fs.read:~/.gemini/antigravity/brain/**',
                    'fs.read:**',
                  ],
                },
              },
            },
          },
        }),
        'utf8'
      )

      const env = { ...process.env, HOME: tmp, USERPROFILE: tmp }
      const helpOut = runCrunes(tmp, ['-p', 'run', 'session', 'list', '--help'], env)
      assert.match(helpOut, /List recent sessions/)
      assert.doesNotMatch(helpOut, /11111111/)

      const listOut = runCrunes(tmp, ['-p', 'run', 'session', 'list', '--all', '--harness', 'agy'], env)
      assert.match(listOut, /11111111/)
      assert.match(listOut, /agy/)

      const digestOut = runCrunes(tmp, ['-p', 'run', 'session', 'digest', '11111111', '--harness', 'agy'], env)
      assert.match(digestOut, /Everything in the demo workspace is clean/)

      const inspectOut = runCrunes(tmp, ['-p', 'run', 'session', 'inspect', '11111111', '1..2', '--harness', 'agy'], env)
      assert.match(inspectOut, /Step #2/)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('session.js (hybrid host scan & fast mode)', () => {
  const scanScript = path.resolve(__dirname, '../scripts/scan.mjs')

  it('fast mode skips middle token scans, preserves endedAt order, and does not poison cache', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crunes-session-fast-'))
    try {
      setupCrunesTest({ cwd: tmp })
      const claudeProj = path.join(tmp, '.claude', 'projects', 'demo-proj')
      fs.mkdirSync(claudeProj, { recursive: true })
      const bigClaude = path.join(claudeProj, 'aaaaaaaa-1111-2222-3333-444444444444.jsonl')
      const head = JSON.stringify({
        type: 'user',
        timestamp: '2026-11-20T10:00:00Z',
        cwd: '/work/demo-proj',
        message: { role: 'user', content: 'Fast mode test prompt' },
      })
      const midPad = 'x'.repeat(12000)
      const midRows = Array.from({ length: 100 }, (_, i) =>
        JSON.stringify({
          type: 'assistant',
          requestId: `req-${i}`,
          timestamp: '2026-11-20T10:01:00Z',
          message: {
            id: `msg-${i}`,
            role: 'assistant',
            content: [{ type: 'text', text: midPad }],
            usage: { input_tokens: 100, output_tokens: 50 },
          },
        })
      )
      const tail = JSON.stringify({
        type: 'assistant',
        timestamp: '2026-11-20T10:05:00Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }] },
      })
      fs.writeFileSync(bigClaude, [head, ...midRows, tail].join('\n') + '\n', 'utf8')
      assert.ok(fs.statSync(bigClaude).size > 1024 * 1024)

      const cacheFile = path.join(tmp, '.crunes', 'cache', 'session-index.json')
      const fastList = await listSessions({ homeDir: tmp, all: true, fast: true, cacheFile })
      assert.equal(fastList.length, 1)
      assert.equal(fastList[0].shortId, 'aaaaaaaa')
      assert.equal(fastList[0].endedAt, '2026-11-20T10:05:00Z')
      assert.equal(fastList[0].usage.total, 0)
      assert.equal(fs.existsSync(cacheFile), false)

      // Full scan populates cache, and subsequent fast scan reuses cached tokens.
      const fullList = await listSessions({ homeDir: tmp, all: true, cacheFile })
      assert.equal(fullList[0].usage.total, 15000)
      assert.equal(fs.existsSync(cacheFile), true)

      const fastCached = await listSessions({ homeDir: tmp, all: true, fast: true, cacheFile })
      assert.equal(fastCached[0].usage.total, 15000)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('scripts/scan.mjs matches listSessions and searchSessions across Claude, Codex (.zst), and Agy (.db)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crunes-session-host-'))
    try {
      makeAgyFixture(tmp, 'antigravity', '11111111-2222-3333-4444-555555555555')

      const codexDir = path.join(tmp, '.codex', 'archived_sessions')
      fs.mkdirSync(codexDir, { recursive: true })
      const codexId = '99999999-8888-7777-6666-555555555555'
      const codexLines = [
        JSON.stringify({
          type: 'session_meta',
          timestamp: '2026-11-22T11:00:00Z',
          payload: { id: codexId, cwd: '/work/demo', timestamp: '2026-11-22T11:00:00Z' },
        }),
        JSON.stringify({
          type: 'event_msg',
          timestamp: '2026-11-22T11:00:01Z',
          payload: { type: 'user_message', message: 'Find the needle-in-zst-codex token' },
        }),
        JSON.stringify({
          type: 'token_usage_record',
          timestamp: '2026-11-22T11:00:02Z',
          payload: {
            thread_id: codexId,
            response_id: 'r1',
            usage: { input_tokens: 400, cached_input_tokens: 100, output_tokens: 50, total_tokens: 450 },
          },
        }),
      ].join('\n') + '\n'
      fs.writeFileSync(
        path.join(codexDir, `rollout-2026-11-22T11-00-00-${codexId}.jsonl.zst`),
        zstdCompressSync(Buffer.from(codexLines, 'utf8'))
      )

      const listRaw = execFileSync('node', [scanScript, 'list'], {
        env: { ...process.env, SESSION_SCAN_OPTS: JSON.stringify({ homeDir: tmp, all: true }) },
        encoding: 'utf8',
      })
      const listRes = JSON.parse(listRaw)
      assert.equal(listRes.ok, true)
      assert.equal(listRes.items.length, 2)
      const codexItem = listRes.items.find(s => s.harness === 'codex')
      assert.ok(codexItem)
      assert.equal(codexItem.usage.total, 450)

      const searchRaw = execFileSync('node', [scanScript, 'search'], {
        env: { ...process.env, SESSION_SCAN_OPTS: JSON.stringify({ homeDir: tmp, all: true, query: 'needle-in-zst-codex' }) },
        encoding: 'utf8',
      })
      const searchRes = JSON.parse(searchRaw)
      assert.equal(searchRes.ok, true)
      assert.equal(searchRes.hits.length, 1)
      assert.equal(searchRes.hits[0].shortId, '99999999')
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})
