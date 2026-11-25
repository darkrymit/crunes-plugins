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
