import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  formatDigestMarkdown,
  formatInspectMarkdown,
  listSessions,
  normalizeFormat,
  parseSession,
  parseStepRangeSpec,
} from '../src/session.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const srcDir = path.resolve(__dirname, '../src')
const localCrunesCli = path.resolve(__dirname, '../../../../crunes-cli/dist/cli.js')

function makeNodeIo() {
  return {
    exists: async p => fs.existsSync(p),
    stat: async p => {
      try {
        const st = fs.statSync(p)
        return { size: st.size, mtimeMs: st.mtimeMs, isFile: st.isFile(), isDirectory: st.isDirectory() }
      } catch {
        return null
      }
    },
    readText: async p => fs.readFileSync(p, 'utf8'),
    readHeadTail: async p => {
      const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(Boolean)
      return { headLines: lines.slice(0, 80), tailLines: lines.slice(-80) }
    },
    glob: async (pattern, cwd) => {
      const out = []
      const walk = (dir, prefix) => {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
          const rel = prefix ? `${prefix}/${ent.name}` : ent.name
          const full = path.join(dir, ent.name)
          if (ent.isDirectory()) walk(full, rel)
          else if (pattern === '**/*.jsonl' ? ent.name.endsWith('.jsonl') : ent.name === 'transcript.jsonl') out.push(rel)
        }
      }
      if (fs.existsSync(cwd)) walk(cwd, '')
      return out
    },
  }
}

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
  const cmd = useLocal ? process.execPath : 'crunes'
  const fullArgs = useLocal ? [localCrunesCli, ...args] : args
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
    try {
      makeAgyFixture(tmp)
      const io = makeNodeIo()
      const sessions = await listSessions({ io, homeDir: tmp, all: true, harness: 'agy' })
      assert.equal(sessions.length, 1)
      assert.equal(sessions[0].shortId, '11111111')

      const parsed = await parseSession('11111111', { io, homeDir: tmp, harness: 'agy' })
      const digest = formatDigestMarkdown(parsed, { format: 'compact' })
      assert.match(digest, /Check the status of the demo workspace/)
      assert.match(digest, /Everything in the demo workspace is clean/)

      const inspected = await formatInspectMarkdown(parsed, '1..2', { io, format: 'extended' })
      assert.match(inspected, /Step #1/)
      assert.match(inspected, /Step #2/)
    } finally {
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
