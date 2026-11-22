import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildTimeline,
  flattenEntries,
  frameName,
  parseVtt,
  pickFrameTimes,
  resolveProfile,
  stamp,
} from '../src/media.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const srcDir = path.resolve(__dirname, '../src')
const localCrunesCli = path.resolve(__dirname, '../../../../crunes-cli/dist/cli.js')

function runCrunes(cwd, args) {
  const useLocal = fs.existsSync(localCrunesCli)
  const cmd = useLocal ? process.execPath : 'crunes'
  const fullArgs = useLocal ? [localCrunesCli, ...args] : args
  return execFileSync(cmd, fullArgs, { cwd, encoding: 'utf8' })
}

describe('media.js (pure unit)', () => {
  it('formats stamps, frame names, VTT cues, frame times, and timelines', () => {
    assert.equal(stamp(65.2), '01:05.2')
    assert.equal(frameName(12.5), 't0012.5.jpg')

    const vtt = [
      'WEBVTT',
      '',
      '00:00:01.000 --> 00:00:03.000',
      'Hello <b>world</b>',
      '',
      '00:00:10.000 --> 00:00:12.000',
      'Second cue',
    ].join('\n')

    const parsed = parseVtt(vtt)
    assert.equal(parsed.segments.length, 2)
    assert.equal(parsed.segments[0].text, 'Hello world')
    assert.equal(parsed.duration_s, 12)

    const times = pickFrameTimes(parsed.segments, parsed.duration_s, { fillerInterval: 5, maxFrames: 20 })
    assert.ok(times.length >= 2)
    const timeline = buildTimeline(parsed.segments, times)
    assert.match(timeline, /Hello world → frames\/t0002\.0\.jpg/)
  })

  it('resolves creator profiles and flattens playlist entries', () => {
    assert.deepEqual(resolveProfile('demo', 'youtube'), {
      platform: 'youtube',
      url: 'https://www.youtube.com/@demo',
    })
    assert.ok(resolveProfile('demo').error)
    assert.equal(
      flattenEntries({
        entries: [
          { _type: 'playlist', entries: [{ id: 'a1', title: 'Clip', duration: 10 }] },
          { id: 'b2', title: 'Direct', view_count: 50 },
        ],
      }).length,
      2
    )
  })
})

describe('media.rune.js (E2E isolate)', () => {
  it('supports --help, --dry-run, and pack/unpack zip round-trip', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crunes-media-test-'))
    try {
      fs.mkdirSync(path.join(tmp, '.crunes', 'runes'), { recursive: true })
      fs.cpSync(srcDir, path.join(tmp, '.crunes', 'runes', 'media'), { recursive: true })
      fs.writeFileSync(
        path.join(tmp, '.crunes', 'config.json'),
        JSON.stringify({
          format: '1',
          runes: {
            media: {
              run: {
                command: '.crunes/runes/media/index.rune.js',
                permissions: { allow: ['fs.read:**', 'fs.write:**', 'fs.glob:**::*'] },
              },
            },
          },
        }),
        'utf8'
      )

      const helpOut = runCrunes(tmp, ['-p', 'run', 'media', '--help'])
      assert.match(helpOut, /download/)
      assert.match(helpOut, /unpack/)

      const dryOut = runCrunes(tmp, ['-p', 'run', 'media', 'download', 'https://example.com/v.mp4', '-o', 'out', '--dry-run'])
      assert.match(dryOut, /dry-run/)

      fs.mkdirSync(path.join(tmp, 'bundle'), { recursive: true })
      fs.writeFileSync(path.join(tmp, 'bundle', 'timeline.md'), '[00:00.0] hello\n', 'utf8')

      runCrunes(tmp, ['-p', 'run', 'media', 'pack', 'bundle', '-o', 'clip.mcf'])
      assert.ok(fs.existsSync(path.join(tmp, 'clip.mcf')))

      runCrunes(tmp, ['-p', 'run', 'media', 'unpack', 'clip.mcf', '-o', 'restored'])
      assert.equal(fs.readFileSync(path.join(tmp, 'restored', 'timeline.md'), 'utf8'), '[00:00.0] hello\n')
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})
