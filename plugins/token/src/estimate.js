/**
 * Fast zero-dependency token estimation calibrated for frontier models:
 * - OpenAI (o200k / GPT-4o): ~4.0 chars/token on natural text & code
 * - Claude (Opus / Sonnet): ~3.17 chars/token (~1.30x factor on markdown & code)
 */
export function estimateTokens(text) {
  if (!text) {
    return { chars: 0, words: 0, lines: 0, openai: 0, claude: 0 }
  }

  const chars = text.length
  const lines = text.split('\n').length
  const words = (text.match(/\S+/g) || []).length

  const chunks = text.match(/[\p{L}\p{N}]+|[^\s\p{L}\p{N}]+|\s+/gu) || []
  let baseTokens = 0

  for (const chunk of chunks) {
    if (/^\s+$/.test(chunk)) {
      baseTokens += Math.max(1, Math.floor(chunk.length / 4))
    } else if (/^[\p{L}\p{N}]+$/u.test(chunk)) {
      baseTokens += Math.max(1, Math.ceil(chunk.length / 4))
    } else {
      baseTokens += Math.max(1, Math.ceil(chunk.length / 2))
    }
  }

  const openai = Math.max(1, Math.round(baseTokens))
  const claude = Math.max(1, Math.round(baseTokens * 1.30))

  return { chars, words, lines, openai, claude }
}

export function formatNumber(n) {
  return Number(n).toLocaleString('en-US')
}

export function formatLine(label, stats, model) {
  if (model === 'claude') {
    return `${label}: ~${formatNumber(stats.claude)} tok (Claude) | ${formatNumber(stats.chars)} chars | ${formatNumber(stats.lines)} lines`
  }
  if (model === 'openai') {
    return `${label}: ~${formatNumber(stats.openai)} tok (OpenAI) | ${formatNumber(stats.chars)} chars | ${formatNumber(stats.lines)} lines`
  }
  return `${label}: ~${formatNumber(stats.openai)} tok (Claude ~${formatNumber(stats.claude)}) | ${formatNumber(stats.chars)} chars | ${formatNumber(stats.lines)} lines`
}
