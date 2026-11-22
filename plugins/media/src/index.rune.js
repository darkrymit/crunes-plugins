import { archive, fs, os, rune, section, shell } from '@utils'
import {
  buildTimeline,
  flattenEntries,
  frameName,
  parseVtt,
  pickFrameTimes,
  resolveProfile,
  stamp,
} from './media.js'

const FRAME_WIDTH_PX = 720
const STANDARD_STREAM_FORMAT = 'bv*[height<=720]+ba/b[height<=720]/b'

function q(arg) {
  const s = String(arg)
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function joinPath(...parts) {
  return parts
    .filter(Boolean)
    .map((s, i) => (i === 0 ? String(s).replace(/[/\\]+$/, '') : String(s).replace(/^[/\\]+|[/\\]+$/g, '')))
    .filter(Boolean)
    .join('/')
}

async function hasBin(bin) {
  const checkCmd = os.platform === 'win32' ? 'where.exe' : 'which'
  const res = await shell.exec(`${checkCmd} ${bin}`, { throw: false })
  return res.exitCode === 0 && Boolean(res.stdout.trim())
}

async function getYtDlpPrefix() {
  if (await hasBin('yt-dlp')) return 'yt-dlp'
  if (await hasBin('uvx')) return 'uvx yt-dlp'
  if (await hasBin('uv')) return 'uv run yt-dlp'
  return null
}

async function runYtDlp(args) {
  const prefix = await getYtDlpPrefix()
  if (!prefix) {
    throw new Error('yt-dlp not found on PATH or via uvx. Install yt-dlp or uv.')
  }
  const cmd = `${prefix} ${args.map(q).join(' ')}`
  const res = await shell.exec(cmd, { throw: false })
  if (res.exitCode !== 0) {
    throw new Error(`${prefix} exited with code ${res.exitCode}: ${(res.stderr || res.stdout || '').trim()}`)
  }
  return res.stdout
}

async function extractSingleFrame(videoPath, outDir, seconds) {
  if (!(await hasBin('ffmpeg'))) {
    throw new Error('ffmpeg not found on PATH. Install ffmpeg to extract frames.')
  }
  const framesDir = joinPath(outDir, 'frames')
  await fs.mkdir(framesDir)
  const targetPath = joinPath(framesDir, frameName(seconds))
  const cmd = [
    'ffmpeg',
    '-y',
    '-loglevel',
    'error',
    '-ss',
    String(seconds),
    '-i',
    videoPath,
    '-frames:v',
    '1',
    '-vf',
    `scale=${FRAME_WIDTH_PX}:-2`,
    '-q:v',
    '3',
    targetPath,
  ]
    .map((a, i) => (i === 0 ? a : q(a)))
    .join(' ')
  const res = await shell.exec(cmd, { throw: false })
  if (res.exitCode !== 0) {
    throw new Error(`ffmpeg exited with code ${res.exitCode}: ${(res.stderr || res.stdout || '').trim()}`)
  }
  return targetPath
}

async function transcribeWithWhisper(videoPath, model = 'medium') {
  const scriptPath = await fs.resolve('@plugin/scripts/transcribe.py')
  if (!(await fs.exists('@plugin/scripts/transcribe.py'))) {
    throw new Error(`transcribe.py script not found at ${scriptPath}`)
  }
  const prefix = (await hasBin('uv'))
    ? 'uv run --with faster-whisper --with av python -X utf8 -I'
    : 'python -X utf8 -I'
  const res = await shell.exec(`${prefix} ${q(scriptPath)} ${q(videoPath)}`, {
    env: { WHISPER_MODEL: model, HF_HUB_DISABLE_SYMLINKS_WARNING: '1' },
    throw: false,
  })
  if (res.exitCode !== 0) {
    throw new Error(`transcribe exited with code ${res.exitCode}: ${(res.stderr || res.stdout || '').trim()}`)
  }
  return JSON.parse(res.stdout)
}

export function args(b) {
  return b
    .option('-h, --help', 'Show help')
    .command('download', 'Download video and metadata without transcription or frame extraction', c => {
      c.positional('<source>', 'Video URL or local file')
       .option('-o, --out <dir>', 'Output directory for downloaded video and metadata')
       .option('--subtitles', 'Fetch remote subtitles (.vtt) if available', false)
       .option('--format <fmt>', 'Stream format selector for yt-dlp', STANDARD_STREAM_FORMAT)
       .option('--dry-run', 'Show planned actions without downloading', false)
    })
    .command('list', 'List a TikTok or YouTube creator videos without downloading', c => {
      c.positional('<profile>', 'Profile URL or handle (with --platform)')
       .option('--platform <name>', 'Platform for bare handle: tiktok or youtube')
    })
    .command('prep', 'Prepare video from URL or local file into timeline and keyframes', c => {
      c.positional('<source>', 'Video URL or local file')
       .option('-o, --out <dir>', 'Output directory for media, timeline, and frames')
       .option('--fps <rate>', 'Frame extraction rate', '1')
       .option('--max-frames <n>', 'Maximum keyframe extraction budget', '60')
       .option('--filler <seconds>', 'Filler frame interval in seconds', '5.0')
       .option('--whisper', 'Force faster-whisper transcription even when subtitles exist', false)
       .option('--skip-frames', 'Skip ffmpeg frame extraction', false)
       .option('--pack <file>', 'Package output into a .rigm zip archive')
       .option('--format <fmt>', 'Stream format selector for yt-dlp', STANDARD_STREAM_FORMAT)
       .option('--dry-run', 'Show planned actions without downloading or extracting', false)
    })
    .command('pack', 'Pack a prepared media folder into a portable .rigm zip archive', c => {
      c.positional('<dir>', 'Prepared media folder')
       .option('-o, --out <file>', 'Output .rigm archive path')
    })
    .command('unpack', 'Unpack a .rigm zip archive into a target directory', c => {
      c.positional('<archive>', 'Input .rigm archive path')
       .option('-o, --out <dir>', 'Destination directory')
    })
    .command('frames', 'Extract dense frame sequence from a time range', c => {
      c.positional('<video>', 'Local video file')
       .option('-o, --out <dir>', 'Output directory for extracted frames')
       .option('--from <seconds>', 'Range start in seconds')
       .option('--to <seconds>', 'Range end in seconds')
       .option('--fps <rate>', 'Frames per second', '1')
       .option('--max <n>', 'Maximum safety frame cap', '120')
    })
    .command('transcribe', 'Transcribe audio track of local video using faster-whisper', c => {
      c.positional('<video>', 'Local video file')
       .option('-o, --out <file>', 'Output JSON file path')
       .option('-m, --model <model>', 'Whisper model name', 'medium')
    })
}

export async function run(parsed) {
  const cmd = parsed.$command

  if (cmd === 'list') {
    const resolved = resolveProfile(parsed.profile, parsed.platform)
    if (resolved.error) throw new Error(resolved.error)
    const stdout = await runYtDlp(['--flat-playlist', '--no-warnings', '-J', resolved.url])
    const rows = flattenEntries(JSON.parse(stdout))
    const lines = rows.map(r => `${r.id || '-'}  ${r.duration ?? '-'}s  ${r.title || ''}  ${r.url || ''}`.trim())
    return [section.create('media:list', { type: 'markdown', content: lines.join('\n') || 'No entries found.', rows })]
  }

  if (cmd === 'pack') {
    if (!parsed.out) throw new Error('-o, --out <file> is required')
    if (!(await fs.exists(parsed.dir))) throw new Error(`Source directory not found: ${parsed.dir}`)
    await archive.zip(parsed.dir, parsed.out)
    return [section.create('media:pack', { type: 'markdown', content: `Packed ${parsed.dir} → ${parsed.out}` })]
  }

  if (cmd === 'unpack') {
    if (!parsed.out) throw new Error('-o, --out <dir> is required')
    if (!(await fs.exists(parsed.archive))) throw new Error(`Archive not found: ${parsed.archive}`)
    await archive.unzip(parsed.archive, parsed.out)
    return [section.create('media:unpack', { type: 'markdown', content: `Unpacked ${parsed.archive} → ${parsed.out}` })]
  }

  if (cmd === 'frames') {
    if (!parsed.out) throw new Error('-o, --out <dir> is required')
    const from = parseFloat(parsed.from)
    const to = parseFloat(parsed.to)
    const fps = parseFloat(parsed.fps) || 1.0
    const max = parseInt(parsed.max, 10) || 120
    if (isNaN(from) || isNaN(to) || from < 0 || to <= from) {
      throw new Error('--from <seconds> and --to <seconds> must be positive numbers with to > from')
    }
    const count = Math.floor((to - from) * fps) + 1
    if (count > max) {
      throw new Error(`Range requires ${count} frames, exceeding cap of ${max}. Narrow range or reduce --fps.`)
    }
    if (!(await fs.exists(parsed.video))) throw new Error(`Video source not found: ${parsed.video}`)
    await fs.mkdir(parsed.out)
    const extracted = []
    for (let s = from; s <= to; s += 1 / fps) {
      extracted.push(await extractSingleFrame(parsed.video, parsed.out, s))
    }
    return [
      section.create('media:frames', {
        type: 'markdown',
        content: `Extracted ${extracted.length} frames into ${joinPath(parsed.out, 'frames')}`,
        frames: extracted,
      }),
    ]
  }

  if (cmd === 'transcribe') {
    if (!(await fs.exists(parsed.video))) throw new Error(`Video source not found: ${parsed.video}`)
    const transcript = await transcribeWithWhisper(parsed.video, parsed.model || 'medium')
    if (parsed.out) {
      await fs.write(parsed.out, JSON.stringify(transcript, null, 2))
      return [section.create('media:transcribe', { type: 'markdown', content: `Transcript saved to ${parsed.out}`, transcript })]
    }
    return [section.create('media:transcribe', { type: 'markdown', content: JSON.stringify(transcript, null, 2), transcript })]
  }

  if (cmd === 'download' || cmd === 'prep') {
    if (!parsed.out) throw new Error('-o, --out <dir> is required')
    const isUrl = /^https?:\/\//i.test(parsed.source)
    if (parsed['dry-run'] || parsed.dryRun) {
      const lines = [
        `Media ${cmd} (dry-run): ${parsed.source}`,
        `  Target directory: ${parsed.out}`,
        `  Format: ${parsed.format || STANDARD_STREAM_FORMAT}`,
      ]
      return [section.create(`media:${cmd}`, { type: 'markdown', content: lines.join('\n') })]
    }

    await fs.mkdir(parsed.out)
    const videoTarget = joinPath(parsed.out, 'source.mp4')
    let meta = { source: parsed.source, is_url: isUrl, created_at: new Date().toISOString() }

    if (isUrl) {
      try {
        const infoStdout = await runYtDlp(['--no-playlist', '--no-warnings', '--skip-download', '--dump-single-json', parsed.source])
        const rawInfo = JSON.parse(infoStdout)
        meta = {
          ...meta,
          id: rawInfo.id || null,
          title: rawInfo.title || null,
          uploader: rawInfo.uploader || rawInfo.channel || null,
          duration: rawInfo.duration || null,
          webpage_url: rawInfo.webpage_url || parsed.source,
        }
      } catch (_) {}

      if (!(await fs.exists(videoTarget))) {
        await runYtDlp([
          '--no-playlist',
          '--no-warnings',
          '--quiet',
          '-f',
          parsed.format || STANDARD_STREAM_FORMAT,
          '--merge-output-format',
          'mp4',
          '-o',
          joinPath(parsed.out, 'source.%(ext)s'),
          parsed.source,
        ])
      }

      if (parsed.subtitles || cmd === 'prep') {
        try {
          await runYtDlp([
            '--no-playlist',
            '--skip-download',
            '--write-auto-sub',
            '--write-sub',
            '--sub-lang',
            'en.*,uk.*,ru.*,en',
            '--sub-format',
            'vtt',
            '-o',
            joinPath(parsed.out, 'subs.%(ext)s'),
            parsed.source,
          ])
        } catch (_) {}
      }
    } else {
      if (!(await fs.exists(parsed.source))) throw new Error(`Local video not found: ${parsed.source}`)
      if (parsed.source !== videoTarget) {
        await fs.copy(parsed.source, videoTarget)
      }
    }

    await fs.write(joinPath(parsed.out, 'meta.json'), JSON.stringify(meta, null, 2))
    if (cmd === 'download') {
      return [section.create('media:download', { type: 'markdown', content: `Downloaded media to ${parsed.out}`, meta })]
    }

    let transcript = null
    if (!parsed.whisper) {
      const vtts = await fs.glob('subs*.vtt', { cwd: parsed.out })
      if (vtts.length > 0) {
        transcript = parseVtt(await fs.read(joinPath(parsed.out, vtts[0])))
      }
    }
    if (!transcript) {
      transcript = await transcribeWithWhisper(videoTarget, 'medium')
    }

    const durationS = transcript.duration_s || meta.duration || 0
    const times = pickFrameTimes(transcript.segments || [], durationS, {
      fillerInterval: parseFloat(parsed.filler) || 5.0,
      maxFrames: parseInt(parsed['max-frames'] ?? parsed.maxFrames, 10) || 60,
    })

    if (!(parsed['skip-frames'] || parsed.skipFrames)) {
      for (const t of times) {
        await extractSingleFrame(videoTarget, parsed.out, t.at)
      }
    }

    const timeline = buildTimeline(transcript.segments || [], times)
    await fs.write(joinPath(parsed.out, 'timeline.md'), timeline)

    if (parsed.pack) {
      await archive.zip(parsed.out, parsed.pack)
    }

    return [
      section.create('media:prep', {
        type: 'markdown',
        content: `Prepared ${parsed.out} (${times.length} frames, ${stamp(durationS)})`,
        meta,
      }),
    ]
  }

  if (parsed.help || !cmd) {
    return rune.helpSection()
  }
  throw new Error('use one of: download, list, prep, pack, unpack, frames, transcribe')
}
