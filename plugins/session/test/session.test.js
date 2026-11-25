import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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
  resolveSession,
  searchSessions,
} = await import('../src/session.js')


function makeAgyFixture(tmp) {
  const convId = '11111111-2222-3333-4444-555555555555'
  const logsDir = path.join(tmp, '.gemini', 'antigravity', 'brain', convId, '.system_generated', 'logs')
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
    env.utils.fs.read = (p, o) => { reads.push(p); return realRead(p, o) }
    try {
      const file = writeCodex(tmp, 1, [...small, ...Array(500).fill(JSON.stringify({ timestamp: '2026-11-24T11:00:00Z', type: 'x', payload: {} }))])
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

  it('reports an unreadable transcript and still lists the rest', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crunes-session-skip-'))
    const env = setupCrunesTest({ cwd: tmp })
    const realStream = env.utils.fs.readLinesStream
    env.utils.fs.readLinesStream = (p, o) => {
      if (p.endsWith('000000000001.jsonl')) throw new Error('unreadable')
      return realStream(p, o)
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

  it('keeps finished summaries when a long first scan is interrupted', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crunes-session-resume-'))
    const env = setupCrunesTest({ cwd: tmp })
    const realStream = env.utils.fs.readLinesStream
    let scans = 0
    let failAfter = 120
    env.utils.fs.readLinesStream = (p, o) => {
      if (scans >= failAfter) throw new Error('stop')
      scans += 1
      return realStream(p, o)
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
