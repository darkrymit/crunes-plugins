export function stamp(seconds) {
  const total = Math.max(0, Number(seconds) || 0)
  const minutes = Math.floor(total / 60)
  const rest = (total - minutes * 60).toFixed(1).padStart(4, '0')
  return `${String(minutes).padStart(2, '0')}:${rest}`
}

export function frameName(seconds) {
  const s = Math.max(0, Number(seconds) || 0)
  return `t${s.toFixed(1).padStart(6, '0')}.jpg`
}

export function parseTimestamp(str) {
  const clean = str.trim().replace(',', '.')
  const parts = clean.split(':').map(Number)
  if (parts.some(isNaN)) return 0
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return parts[0] || 0
}

export function parseVtt(text) {
  if (!text || typeof text !== 'string') {
    return { segments: [], duration_s: 0, speech_s: 0 }
  }

  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const segments = []
  let currentStart = null
  let currentEnd = null
  let currentText = []

  const timeRegex = /((?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{3})\s*-->\s*((?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{3})/

  function flush() {
    if (currentStart !== null && currentEnd !== null) {
      const raw = currentText.join(' ').replace(/<[^>]+>/g, '').trim()
      if (raw.length > 0) {
        const prev = segments[segments.length - 1]
        if (!prev || prev.text !== raw || Math.abs(prev.start - currentStart) > 0.5) {
          segments.push({
            start: Number(currentStart.toFixed(2)),
            end: Number(currentEnd.toFixed(2)),
            text: raw,
          })
        }
      }
    }
    currentStart = null
    currentEnd = null
    currentText = []
  }

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed === 'WEBVTT' || /^(NOTE|STYLE|REGION)/.test(trimmed)) {
      continue
    }

    const match = trimmed.match(timeRegex)
    if (match) {
      flush()
      currentStart = parseTimestamp(match[1])
      currentEnd = parseTimestamp(match[2])
    } else if (currentStart !== null) {
      if (/^\d+$/.test(trimmed) && currentText.length === 0) continue
      currentText.push(trimmed)
    }
  }
  flush()

  const duration_s = segments.length > 0 ? segments[segments.length - 1].end : 0
  const speech_s = segments.reduce((sum, s) => sum + (s.end - s.start), 0)

  return {
    segments,
    duration_s: Number(duration_s.toFixed(1)),
    speech_s: Number(speech_s.toFixed(1)),
  }
}

export function pickFrameTimes(segments, durationS, options = {}) {
  const fillerInterval = options.fillerInterval || 5.0
  const maxFrames = options.maxFrames || 60
  const lastFrameS = Math.max(durationS - 0.1, 0)
  const times = []
  let previous = -fillerInterval

  const fillUntil = target => {
    while (target - previous > fillerInterval) {
      previous += fillerInterval
      times.push({ at: Math.min(previous, lastFrameS), segment: null })
    }
  }

  for (const segment of segments) {
    const middle = Math.min((segment.start + segment.end) / 2, lastFrameS)
    fillUntil(middle)
    times.push({ at: middle, segment })
    previous = middle
  }
  fillUntil(lastFrameS)

  if (times.length === 0 && durationS > 0) {
    fillUntil(lastFrameS)
  }

  if (times.length <= maxFrames) return times

  const step = (times.length - 1) / (maxFrames - 1)
  return Array.from({ length: maxFrames }, (_, i) => times[Math.round(i * step)])
}

export function buildTimeline(segments, times) {
  const framed = new Map(times.filter(t => t.segment).map(t => [t.segment, t.at]))
  const lines = [
    ...segments.map(segment => ({ at: segment.start, segment })),
    ...times.filter(t => !t.segment).map(t => ({ at: t.at, segment: null })),
  ].sort((a, b) => a.at - b.at)

  return (
    lines
      .map(({ at, segment }) => {
        if (!segment) {
          const inside = segments.some(s => at >= s.start && at < s.end)
          return `[${stamp(at)}] (${inside ? 'within segment' : 'no speech'}) → frames/${frameName(at)}`
        }
        const frameAt = framed.get(segment)
        const frame = frameAt === undefined ? '' : ` → frames/${frameName(frameAt)}`
        return `[${stamp(at)}] ${segment.text}${frame}`
      })
      .join('\n') + '\n'
  )
}

const PROFILE_PLATFORMS = {
  tiktok: {
    match: /^https?:\/\/(www\.|m\.)?tiktok\.com\/@[\w.-]+\/?$/i,
    fromHandle: handle => `https://www.tiktok.com/@${handle}`,
    forms: 'https://www.tiktok.com/@<handle>',
  },
  youtube: {
    match: /^https?:\/\/(www\.|m\.)?youtube\.com\/(@[\w.-]+|channel\/[\w-]+)\/?$/i,
    fromHandle: handle => `https://www.youtube.com/@${handle}`,
    forms: 'https://www.youtube.com/@<handle>, https://www.youtube.com/channel/<id>',
  },
}

const ACCEPTED_FORMS = Object.values(PROFILE_PLATFORMS).map(p => p.forms).join(', ')

export function resolveProfile(input, platform) {
  const isUrl = /^https?:\/\//i.test(input)

  if (platform && !PROFILE_PLATFORMS[platform]) {
    return { error: `unknown --platform "${platform}"; use ${Object.keys(PROFILE_PLATFORMS).join(' or ')}` }
  }

  if (!isUrl) {
    if (!platform) {
      return { error: `"${input}" is not a URL; pass a profile URL, or a handle with --platform tiktok|youtube` }
    }
    const handle = input.replace(/^@/, '')
    if (!/^[\w.-]+$/.test(handle)) {
      return { error: `"${input}" is not a valid handle` }
    }
    return { platform, url: PROFILE_PLATFORMS[platform].fromHandle(handle) }
  }

  const found = Object.keys(PROFILE_PLATFORMS).find(p => PROFILE_PLATFORMS[p].match.test(input))
  if (!found) {
    return { error: `unsupported URL: ${input}\n  media list accepts: ${ACCEPTED_FORMS}` }
  }
  if (platform && platform !== found) {
    return { error: `--platform ${platform} disagrees with the URL, which is ${found}: ${input}` }
  }
  return { platform: found, url: input }
}

export function flattenEntries(dump) {
  const rows = []
  for (const e of dump.entries || []) {
    if (!e || typeof e !== 'object') continue
    if (e._type === 'playlist' && Array.isArray(e.entries)) {
      rows.push(...flattenEntries(e))
      continue
    }
    rows.push({
      id: e.id || null,
      url: e.url || e.webpage_url || null,
      title: e.title || null,
      views: typeof e.view_count === 'number' ? e.view_count : null,
      duration: typeof e.duration === 'number' ? e.duration : null,
    })
  }
  return rows
}
