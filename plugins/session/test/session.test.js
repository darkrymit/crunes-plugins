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
} from '../src/session.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const entryPath = path.resolve(__dirname, '../src/index.mjs')

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

describe('session.mjs (unit + fixture)', () => {
  it('parses step ranges and normalizes format names', () => {
    assert.deepEqual(parseStepRangeSpec('1,3..5', 10), [1, 3, 4, 5])
    assert.equal(normalizeFormat('compact'), 'compact')
    assert.equal(normalizeFormat('FULL'), 'full')
  })

  it('lists, parses, digests, and inspects an Antigravity transcript fixture', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crunes-session-test-'))
    try {
      makeAgyFixture(tmp)
      const sessions = listSessions({ homeDir: tmp, all: true, harness: 'agy' })
      assert.equal(sessions.length, 1)
      assert.equal(sessions[0].shortId, '11111111')

      const parsed = parseSession('11111111', { homeDir: tmp, harness: 'agy' })
      const digest = formatDigestMarkdown(parsed, { format: 'compact' })
      assert.match(digest, /Check the status of the demo workspace/)
      assert.match(digest, /Everything in the demo workspace is clean/)

      const inspected = formatInspectMarkdown(parsed, '1..2', { format: 'extended' })
      assert.match(inspected, /Step #1/)
      assert.match(inspected, /Step #2/)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('session CLI (E2E native)', () => {
  it('runs list, digest, and inspect via src/index.mjs', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crunes-session-cli-'))
    try {
      makeAgyFixture(tmp)
      const env = { ...process.env, HOME: tmp, USERPROFILE: tmp }

      const listOut = execFileSync(process.execPath, [entryPath, 'list', '--all', '--harness', 'agy'], {
        env,
        encoding: 'utf8',
      })
      assert.match(listOut, /11111111/)
      assert.match(listOut, /agy/)

      const digestOut = execFileSync(process.execPath, [entryPath, 'digest', '11111111', '--harness', 'agy'], {
        env,
        encoding: 'utf8',
      })
      assert.match(digestOut, /Everything in the demo workspace is clean/)

      const inspectOut = execFileSync(
        process.execPath,
        [entryPath, 'inspect', '11111111', '1..2', '--harness', 'agy'],
        { env, encoding: 'utf8' }
      )
      assert.match(inspectOut, /Step #2/)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})
