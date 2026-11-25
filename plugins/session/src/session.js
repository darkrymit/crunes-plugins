import { fs, sqlite } from '@utils';

// fs.stat returns its dates as ISO strings and has no millisecond fields.
async function safeStat(p) {
  try {
    const s = await fs.stat(p);
    const mtime = new Date(s.mtime);
    const birthtime = new Date(s.birthtime);
    return { ...s, mtime, birthtime, mtimeMs: mtime.getTime(), birthtimeMs: birthtime.getTime() };
  } catch {
    return null;
  }
}

const path = {
  basename(p, ext = '') {
    const clean = String(p || '').replace(/[/\\]+$/, '');
    const idx = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
    const base = idx === -1 ? clean : clean.slice(idx + 1);
    return ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base;
  },
  dirname(p) {
    const clean = String(p || '').replace(/[/\\]+$/, '');
    const idx = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
    if (idx === -1) return '.';
    return idx === 0 ? clean.slice(0, 1) : clean.slice(0, idx);
  },
  join(...parts) {
    return parts
      .filter(Boolean)
      .map((s, i) => (i === 0 ? String(s).replace(/[/\\]+$/, '') : String(s).replace(/^[/\\]+|[/\\]+$/g, '')))
      .filter(Boolean)
      .join('/');
  },
};

/**
 * Dual-harness session reader for Claude Code (~/.claude/projects/<project>/<id>.jsonl)
 * and Antigravity (~/.gemini/antigravity{,-cli,-ide}/brain/<id>/.system_generated/logs/transcript.jsonl).
 *
 * Converts raw JSONL transcripts (85-95% tool-result payloads and telemetry envelopes)
 * into three progressive lenses:
 *   1. list    — fast head/tail discovery across harnesses by workspace or query
 *   2. digest  — compact FDR/CVR Markdown spine with 1-line tool target signatures,
 *                loop/error/hook-block flags, and cold-pickup tail coordinates
 *   3. inspect — full un-truncated step drill-down (with transcript_full.jsonl fallback)
 */

// Desktop app, CLI and IDE keep separate transcript folders of the same shape.
const AGY_APPS = ['antigravity', 'antigravity-cli', 'antigravity-ide'];

function defaultDirs(opts = {}) {
  const home = opts.homeDir || '~';
  return {
    claudeDir: opts.claudeDir || path.join(home, '.claude', 'projects'),
    agyDirs: opts.agyDir ? [opts.agyDir] : AGY_APPS.map(app => path.join(home, '.gemini', app, 'brain')),
    codexDirs: opts.codexDir ? [opts.codexDir] : ['sessions', 'archived_sessions'].map(d => path.join(home, '.codex', d))
  };
}

const isCompressed = filePath => filePath.endsWith('.zst');

function readLines(filePath, opts = {}) {
  return fs.readLinesStream(filePath, isCompressed(filePath) ? { ...opts, decompress: 'zstd' } : opts);
}

const EDGE_LINES = 80;
const MAX_TAIL_CHARS = 8 * 1024 * 1024;
const SMALL_FILE_BYTES = 1024 * 1024;

/**
 * Feeds a transcript in three parts: its first lines, the records holding one of `wanted` anywhere
 * in the file, and its last lines. A small file is read once; a large one is read by parts, so that
 * the other records, mostly tool output, stay on the host. The tail of a large file grows line by
 * line until `enough()`, because a few last records can be huge; lines fed again must be harmless.
 */
async function scanTranscript(filePath, size, { head = EDGE_LINES, wanted, onHead, onRecord, onTail, hasEnd, enough = hasEnd }) {
  const toLines = raw => raw.split('\n').map(l => l.trim()).filter(Boolean);
  const feedRecord = (line) => {
    let o;
    try { o = JSON.parse(line); } catch (_) { return; }
    if (o && typeof o === 'object') onRecord(o);
  };

  if (isCompressed(filePath)) {
    // It can only be read forwards, so the tail is collected on the way, bounded in size.
    const tail = [];
    let tailChars = 0;
    let count = 0;
    for await (const raw of readLines(filePath)) {
      const line = raw.trim();
      if (!line) continue;
      if (onHead && ++count <= head) onHead(line);
      if (wanted.some(w => line.includes(w))) feedRecord(line);
      tail.push(line);
      tailChars += line.length;
      while (tail.length > EDGE_LINES || (tailChars > MAX_TAIL_CHARS && tail.length > 1)) {
        tailChars -= tail.shift().length;
      }
    }
    tail.forEach(onTail);
    return;
  }
  if (size < SMALL_FILE_BYTES) {
    const lines = toLines(await fs.read(filePath));
    if (onHead) lines.slice(0, head).forEach(onHead);
    for (const line of lines) {
      if (wanted.some(w => line.includes(w))) feedRecord(line);
    }
    lines.slice(-EDGE_LINES).forEach(onTail);
    for (let i = lines.length - EDGE_LINES - 1; i >= 0 && !hasEnd(); i--) onTail(lines[i]);
    return;
  }
  if (onHead) toLines(await fs.read(filePath, { from: 1, to: head })).forEach(onHead);
  for await (const line of readLines(filePath, { contains: wanted })) feedRecord(line);
  for (let n = 1; ; n = Math.min(n * 2, EDGE_LINES)) {
    toLines(await fs.read(filePath, { from: -n })).forEach(onTail);
    if (n === EDGE_LINES || enough()) break;
  }
}

function cleanUserText(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let text = raw;

  // Antigravity <USER_REQUEST> wrapper
  const reqMatch = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(text);
  if (reqMatch) {
    text = reqMatch[1];
  } else {
    text = text
      .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
      .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '');
  }

  // Claude Code IDE & system wrappers
  text = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
    .replace(/<ide_opened_file>[\s\S]*?<\/ide_opened_file>/gi, '')
    .replace(/<ide_selection>[\s\S]*?<\/ide_selection>/gi, '')
    .replace(/<user-prompt-submit-hook>[\s\S]*?<\/user-prompt-submit-hook>/gi, '')
    .trim();

  return text;
}

function isInjectedSkillPayload(text) {
  if (!text) return null;
  const m = /^Base directory for this skill:\s*([^\r\n]+)/i.exec(text.trim());
  if (!m) return null;
  return path.basename(m[1].trim());
}

function isCompactionSummaryText(text) {
  if (!text) return false;
  return text.trim().startsWith('This session is being continued from a previous conversation that ran out of context.');
}

function inferProjectFromText(text) {
  if (!text) return null;
  // 1. Check Dex status header: "Dex · <project> ›"
  const dexHeader = /Dex\s*·\s*([A-Za-z0-9_.-]+)\s*›/.exec(text);
  if (dexHeader && dexHeader[1] && dexHeader[1] !== '<project>') {
    return dexHeader[1];
  }
  // 2. Check workspace URI or repo roots preceded by a path separator (never matching JSON \n escapes)
  const sep = '(?:\\\\\\\\+|\\/+|%5[cC]|%2[fF])';
  const pathMatch = new RegExp(`${sep}(?:Playground|Documents|Homelab)${sep}([A-Za-z0-9_.-]+)`, 'i').exec(text);
  if (pathMatch) return pathMatch[1];
  const workMatch = new RegExp(`${sep}Work${sep}[A-Za-z0-9_.-]+${sep}([A-Za-z0-9_.-]+)`, 'i').exec(text);
  if (workMatch) return workMatch[1];
  return null;
}

function inferProjectFromClaudeDir(projDirName) {
  if (!projDirName) return 'unknown';
  const m = /-(?:Playground|Work|Documents|Homelab|repos|projects)-(?:[A-Za-z0-9_.-]+-)?([A-Za-z0-9_.-]+)$/i.exec(projDirName);
  // Prefer everything after Playground/Documents/Homelab, or after Work/<org>/
  const pgMatch = /-(?:Playground|Documents|Homelab)-(.+)$/i.exec(projDirName);
  if (pgMatch) return pgMatch[1];
  const workMatch = /-Work-[^-]+-(.+)$/i.exec(projDirName);
  if (workMatch) return workMatch[1];
  if (m) return m[1];
  return projDirName.split('-').pop() || 'unknown';
}

function emptyUsage() {
  return { input: 0, cacheCreate: 0, cacheRead: 0, output: 0, writeOrUncached: 0, total: 0, cacheHitPct: 0 };
}

function finalizeUsage(u) {
  const input = u.input || 0;
  const cacheCreate = u.cacheCreate || 0;
  const cacheRead = u.cacheRead || 0;
  const output = u.output || 0;
  const writeOrUncached = input + cacheCreate;
  const total = writeOrUncached + cacheRead + output;
  const promptTotal = writeOrUncached + cacheRead;
  const cacheHitPct = promptTotal > 0 ? Math.round((cacheRead / promptTotal) * 100) : 0;
  return { input, cacheCreate, cacheRead, output, writeOrUncached, total, cacheHitPct };
}

function addUsage(acc, delta) {
  acc.input += delta.input || 0;
  acc.cacheCreate += delta.cacheCreate || 0;
  acc.cacheRead += delta.cacheRead || 0;
  acc.output += delta.output || 0;
}

function fmtCompactNum(n) {
  const v = Number(n) || 0;
  if (v < 1000) return String(Math.round(v));
  if (v < 100_000) return `${(v / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (v < 1_000_000) return `${Math.round(v / 1000)}k`;
  if (v < 1_000_000_000) return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  return `${(v / 1_000_000_000).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')}B`;
}

function fmtTok(u) {
  const f = finalizeUsage(u || {});
  if (f.total === 0) return '0/0/0 (0% cr)';
  return `${fmtCompactNum(f.total)}/${fmtCompactNum(f.writeOrUncached)}/${fmtCompactNum(f.output)} (${f.cacheHitPct}% cr)`;
}

function fmtDuration(ms) {
  const sec = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) {
    const remS = sec % 60;
    return remS > 0 && min < 10 ? `${min}m${String(remS).padStart(2, '0')}s` : `${min}m`;
  }
  const hr = Math.floor(min / 60);
  const remM = min % 60;
  return remM > 0 ? `${hr}h${String(remM).padStart(2, '0')}m` : `${hr}h`;
}

function toMs(iso, fallbackMs = 0) {
  if (!iso) return fallbackMs;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? fallbackMs : t;
}

function oneLine(text, maxLen = 100) {
  if (!text) return '';
  const flat = String(text).replace(/\s+/g, ' ').trim();
  if (flat.length <= maxLen) return flat;
  return flat.slice(0, maxLen - 1) + '…';
}

const VALID_FORMATS = new Set(['compact', 'standard', 'extended', 'full']);

function normalizeFormat(fmt, fallback = 'compact') {
  if (!fmt) return fallback;
  const clean = String(fmt).toLowerCase().trim();
  if (!VALID_FORMATS.has(clean)) {
    throw new Error(`invalid format "${fmt}" (expected: compact, standard, extended, or full)`);
  }
  return clean;
}

function truncateSandwich(text, { headLines = 4, tailLines = 4, maxChars = 550, step = null, shortId = '' } = {}) {
  if (!text || typeof text !== 'string') return '';
  const trimmed = text.trim();
  if (!trimmed) return '';

  const rawLines = trimmed.split(/\r?\n/);
  const inspectHint = step !== null && shortId
    ? `; run \`crunes -p run session inspect ${shortId} ${step}\` for full step`
    : '';

  if (rawLines.length <= headLines + tailLines && trimmed.length <= maxChars) {
    return trimmed;
  }

  if (rawLines.length > headLines + tailLines) {
    const omittedCount = rawLines.length - headLines - tailLines;
    let headPart = rawLines.slice(0, headLines).join('\n');
    let tailPart = tailLines > 0 ? rawLines.slice(-tailLines).join('\n') : '';
    const headCap = Math.floor(maxChars * 0.55);
    const tailCap = Math.floor(maxChars * 0.45);
    if (headPart.length > headCap) headPart = headPart.slice(0, headCap).trimEnd() + '…';
    if (tailPart.length > tailCap) tailPart = '…' + tailPart.slice(tailPart.length - tailCap).trimStart();
    const marker = `*(... ${omittedCount} line${omittedCount === 1 ? '' : 's'} omitted${inspectHint} ...)*`;
    return tailPart ? `${headPart}\n${marker}\n${tailPart}` : `${headPart}\n${marker}`;
  }

  // Few lines, but total characters exceed maxChars
  const headCap = Math.floor(maxChars * 0.55);
  const tailCap = Math.floor(maxChars * 0.45);
  const omittedChars = Math.max(1, trimmed.length - headCap - tailCap);
  return `${trimmed.slice(0, headCap).trimEnd()}\n*(... ${omittedChars} chars omitted${inspectHint} ...)*\n${trimmed.slice(trimmed.length - tailCap).trimStart()}`;
}

function unwrapArgValue(val) {
  if (typeof val !== 'string') return val;
  const trimmed = val.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
    (trimmed.startsWith('{') && trimmed.endsWith('}'))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch (_) {
      return val;
    }
  }
  return val;
}

function unwrapArgs(args) {
  if (!args || typeof args !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = unwrapArgValue(v);
  }
  return out;
}

function shortPath(p, cwd) {
  if (!p || typeof p !== 'string') return '';
  const norm = p.replace(/\\/g, '/');
  if (cwd) {
    const normCwd = cwd.replace(/\\/g, '/').replace(/\/$/, '');
    if (norm.toLowerCase().startsWith(normCwd.toLowerCase() + '/')) {
      return norm.slice(normCwd.length + 1);
    }
  }
  // Check skill path
  const skillMatch = /\/skills\/([^/]+\/SKILL\.md)$/i.exec(norm);
  if (skillMatch) return `skills/${skillMatch[1]}`;
  const parts = norm.split('/').filter(Boolean);
  if (parts.length <= 2) return parts.join('/');
  return parts.slice(-2).join('/');
}

function detectSkillLoad(toolName, args) {
  if (toolName === 'Skill' && args && args.skill) {
    return String(args.skill);
  }
  const filePath = args && (args.file_path || args.Path || args.AbsolutePath || args.path);
  if (typeof filePath === 'string') {
    const m = /[\\/]skills[\\/]([^\\/]+)[\\/]SKILL\.md$/i.exec(filePath);
    if (m) return m[1];
  }
  return null;
}

function normalizeToolCall(rawName, rawArgs, cwd) {
  const args = unwrapArgs(rawArgs);
  const lower = String(rawName || '').toLowerCase();

  if (lower === 'read' || lower === 'read_file' || lower === 'view_file') {
    const p = args.file_path || args.Path || args.AbsolutePath || args.path || '';
    const baseTarget = shortPath(p, cwd) || 'file';
    let rangeSuffix = '';
    if (args.StartLine !== undefined || args.EndLine !== undefined) {
      rangeSuffix = `:${args.StartLine ?? 1}..${args.EndLine ?? 'end'}`;
    } else if (args.offset !== undefined || args.limit !== undefined) {
      rangeSuffix = `:${args.offset ?? 1}+${args.limit ?? 'all'}`;
    }
    return { name: 'read', rawName, target: `${baseTarget}${rangeSuffix}`, file: p, args };
  }
  if (lower === 'edit' || lower === 'edit_file' || lower === 'replace_file_content' || lower === 'multi_replace_file_content') {
    const p = args.file_path || args.Path || args.TargetFile || args.path || '';
    return { name: 'edit', rawName, target: shortPath(p, cwd) || 'file', file: p, mutation: 'edit', args };
  }
  if (lower === 'write' || lower === 'write_file' || lower === 'write_to_file') {
    const p = args.file_path || args.Path || args.TargetFile || args.path || '';
    return { name: 'write', rawName, target: shortPath(p, cwd) || 'file', file: p, mutation: 'write', args };
  }
  if (lower === 'bash' || lower === 'run_command' || lower === 'exec_command' || lower === 'shell' || lower === 'exec') {
    let cmd = args.command || args.CommandLine || args.cmd || args.input || '';
    if (lower === 'exec' && typeof cmd === 'string') {
      if (/write_stdin\(\s*\{[^}]*chars\s*:\s*""/.test(cmd) && !/exec_command\(/.test(cmd)) {
        return { name: 'poll', rawName, target: 'write_stdin', command: cmd, args };
      }
      const m = /exec_command\(\s*\{\s*cmd\s*:\s*"([^"]+)"/.exec(cmd);
      if (m) cmd = m[1];
    }
    // Strip outer Git Bash wrapper if present for cleaner display
    const bashWrap = /^&\s*"[^"]*bash\.exe"\s*-l?c\s*(['"])([\s\S]*)\1$/.exec(String(cmd).trim());
    if (bashWrap) cmd = bashWrap[2];
    return { name: 'bash', rawName, target: `"${oneLine(cmd, 72)}"`, command: cmd, args };
  }
  if (lower === 'apply_patch') {
    const patchText = String(args.input || args.patch || '');
    const fileMatch = /^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/m.exec(patchText);
    const p = fileMatch ? fileMatch[1].trim() : '';
    return { name: 'edit', rawName, target: p ? shortPath(p, cwd) : 'patch', file: p, mutation: 'edit', args };
  }
  if (lower === 'grep' || lower === 'grep_search') {
    const pat = args.pattern || args.Query || '';
    const searchPath = args.path || args.SearchPath || '';
    const suffix = searchPath ? ` in ${shortPath(searchPath, cwd)}` : '';
    return { name: 'grep', rawName, target: `"${oneLine(pat, 40)}"${suffix}`, args };
  }
  if (lower === 'glob' || lower === 'find_by_name') {
    const pat = args.pattern || args.Pattern || '';
    return { name: 'glob', rawName, target: `"${oneLine(pat, 40)}"`, args };
  }
  if (lower === 'skill') {
    return { name: 'skill', rawName, target: String(args.skill || ''), args };
  }
  if (lower === 'askuserquestion' || lower === 'ask_question' || lower === 'request_user_input_async' || lower === 'request_user_input') {
    const qList = Array.isArray(args.questions) ? args.questions : [];
    const q0 = qList[0] || {};
    const qText = q0.question || q0.title || args.question || '';
    const options = Array.isArray(q0.options)
      ? q0.options.map(o => (typeof o === 'string' ? o : (o.label || o.text || '')))
      : [];
    // Parallel to options: what each choice meant, which a bare label does not say.
    const optionDescriptions = Array.isArray(q0.options)
      ? q0.options.map(o => (o && typeof o === 'object' && o.description) || '')
      : [];
    return {
      name: 'ask',
      rawName,
      target: `"${oneLine(qText, 60)}"`,
      ask: { question: qText, options, optionDescriptions, answer: null },
      args
    };
  }
  if (lower === 'agent' || lower === 'invoke_subagent' || lower === 'spawn_agent' || lower === 'followup_task') {
    const role = args.Role || args.description || args.subagent_type || args.TypeName || args.task_name || args.target || 'subagent';
    const model = args.Model || args.model || '';
    return {
      name: 'subagent',
      rawName,
      target: `${role}${model ? ` (${model})` : ''}`,
      args
    };
  }

  const firstVal = Object.values(args).find(v => typeof v === 'string' && v.length > 0);
  return {
    name: rawName || 'tool',
    rawName: rawName || 'tool',
    target: firstVal ? oneLine(firstVal, 50) : '',
    args
  };
}

async function summarizeClaudeFile(filePath, stat) {
  const rawBase = path.basename(filePath, '.jsonl');
  const inSubagentsDir = path.basename(path.dirname(filePath)) === 'subagents';
  let id = inSubagentsDir ? rawBase.replace(/^agent-/, '') : rawBase;

  let cwd = null;
  let branch = null;
  let title = null;
  let firstPrompt = null;
  let model = null;
  let startedAt = null;
  let endedAt = null;
  let isSubagent = inSubagentsDir;
  let parentId = inSubagentsDir ? path.basename(path.dirname(path.dirname(filePath))) : null;

  if (inSubagentsDir) {
    const metaPath = filePath.replace(/\.jsonl$/, '.meta.json');
    try {
      if (await fs.exists(metaPath)) {
        const metaObj = JSON.parse(await fs.read(metaPath));
        if (metaObj.description) {
          title = `[${metaObj.agentType || 'subagent'}] ${metaObj.description}`;
        }
      }
    } catch (_) {}
  }

  const inspectLine = (line) => {
    let o;
    try {
      o = JSON.parse(line);
    } catch (_) {
      return;
    }
    if (!startedAt && o.timestamp) startedAt = o.timestamp;
    if (o.timestamp) endedAt = o.timestamp;
    if (!cwd && o.cwd) cwd = o.cwd;
    if (!branch && o.gitBranch) branch = o.gitBranch;
    if (o.isSidechain && o.agentId) {
      isSubagent = true;
      id = String(o.agentId);
      if (!parentId && o.sessionId) parentId = String(o.sessionId);
    }
    if (!model && (o.requestedModel || o.message?.model)) {
      model = o.requestedModel || o.message?.model;
    }
    if (o.type === 'ai-title' && o.aiTitle) {
      title = o.aiTitle;
    }
    if (!firstPrompt && o.type === 'user' && o.message) {
      const c = o.message.content;
      let rawText = '';
      if (typeof c === 'string') rawText = c;
      else if (Array.isArray(c)) {
        const tb = c.find(b => b.type === 'text' && b.text && !isInjectedSkillPayload(b.text) && !isCompactionSummaryText(b.text));
        if (tb) rawText = tb.text;
      }
      const cleaned = cleanUserText(rawText);
      if (cleaned && !isInjectedSkillPayload(cleaned) && !isCompactionSummaryText(cleaned)) {
        firstPrompt = oneLine(cleaned, 100);
      }
    }
  };

  // Stream-scan full file for accurate deduplicated token totals & true endedAt
  const usageAcc = emptyUsage();
  const seenReqMsg = new Set();
  let firstTs = null;
  let lastTs = null;
  let firstCwd = null;
  let lastTitle = null;
  const onRecord = (o) => {
    if (!firstTs && o.timestamp) firstTs = o.timestamp;
    if (o.timestamp) lastTs = o.timestamp;
    if (!firstCwd && o.cwd) firstCwd = o.cwd;
    if (o.type === 'ai-title' && o.aiTitle) lastTitle = o.aiTitle;
    if (o.type === 'assistant' && o.message && o.message.usage) {
      const rid = o.requestId || '';
      const mid = o.message.id || '';
      if (rid && mid) {
        const k = `${rid}:${mid}`;
        if (seenReqMsg.has(k)) return;
        seenReqMsg.add(k);
      }
      const u = o.message.usage;
      addUsage(usageAcc, {
        input: u.input_tokens || 0,
        cacheCreate: u.cache_creation_input_tokens || 0,
        cacheRead: u.cache_read_input_tokens || 0,
        output: u.output_tokens || 0
      });
    }
  };
  let headTs = null;
  await scanTranscript(filePath, stat.size, {
    wanted: ['"usage"', '"ai-title"'],
    onHead: l => inspectLine(l),
    onRecord,
    onTail: (l) => {
      if (headTs === null) {
        headTs = startedAt || '';
        endedAt = null;
      }
      inspectLine(l);
    },
    hasEnd: () => Boolean(endedAt),
    enough: () => Boolean(endedAt && firstPrompt)
  });
  startedAt = headTs || firstTs || startedAt;
  endedAt = endedAt || lastTs;
  if (lastTitle) title = lastTitle;
  if (!cwd) cwd = firstCwd;

  const finalStarted = startedAt || stat.birthtime.toISOString();
  const finalEnded = endedAt || stat.mtime.toISOString();
  const durationMs = Math.max(0, toMs(finalEnded, stat.mtimeMs) - toMs(finalStarted, stat.birthtimeMs));
  const projDirPath = inSubagentsDir ? path.dirname(path.dirname(path.dirname(filePath))) : path.dirname(filePath);
  const project = cwd ? path.basename(cwd) : inferProjectFromClaudeDir(path.basename(projDirPath));
  return {
    id,
    shortId: id.slice(0, 8),
    harness: 'claude',
    project: project || 'unknown',
    cwd: cwd || null,
    branch: branch || null,
    model: model || null,
    title: title || firstPrompt || id.slice(0, 8),
    firstPrompt: firstPrompt || '',
    isSubagent,
    parentId: parentId || null,
    startedAt: finalStarted,
    endedAt: finalEnded,
    endedMs: toMs(finalEnded, stat.mtimeMs),
    durationMs,
    usage: finalizeUsage(usageAcc),
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    path: filePath
  };
}

function readVarint(bytes, at) {
  let value = 0;
  let scale = 1;
  for (let i = at; i < bytes.length; i++) {
    value += (bytes[i] & 127) * scale;
    if (bytes[i] < 128) return [value, i + 1];
    scale *= 128;
  }
  throw new Error('truncated varint');
}

/** Top-level protobuf fields as [number, value]; nested messages stay bytes. */
function readProtoFields(bytes) {
  const fields = [];
  let at = 0;
  while (at < bytes.length) {
    let tag;
    [tag, at] = readVarint(bytes, at);
    const number = Math.floor(tag / 8);
    const wire = tag % 8;
    if (wire === 0) {
      let value;
      [value, at] = readVarint(bytes, at);
      fields.push([number, value]);
    } else if (wire === 2) {
      let length;
      [length, at] = readVarint(bytes, at);
      if (at + length > bytes.length) throw new Error('truncated field');
      fields.push([number, bytes.subarray(at, at + length)]);
      at += length;
    } else if (wire === 1) at += 8;
    else if (wire === 5) at += 4;
    else throw new Error('unsupported wire type');
  }
  return fields;
}

const protoLast = (fields, number) => fields.findLast(([n]) => n === number)?.[1];
const isBytes = v => v instanceof Uint8Array && v.length > 0;

// Field numbers observed in Antigravity databases: generation.1 is the model call, its 4 the usage
// and 17 its retries (each holding a usage in 2). In a usage: 2 input, 3 output, 4 cache write,
// 5 cache read, 9 reasoning, 10 visible output, 11/12/7 response ids.
function readAgyGeneration(data, rowKey, seen, acc) {
  const call = protoLast(readProtoFields(data), 1);
  if (!isBytes(call)) return 0;
  const callFields = readProtoFields(call);
  const usages = [protoLast(callFields, 4)];
  for (const [n, retry] of callFields) {
    if (n === 17 && isBytes(retry)) usages.push(protoLast(readProtoFields(retry), 2));
  }
  let counted = 0;
  for (const raw of usages) {
    if (!isBytes(raw)) continue;
    const usage = readProtoFields(raw);
    const idBytes = [11, 12, 7].map(n => protoLast(usage, n)).find(isBytes);
    const id = idBytes ? Array.from(idBytes).join() : rowKey;
    if (seen.has(id)) continue;
    seen.add(id);
    const num = (n) => {
      const v = protoLast(usage, n);
      return typeof v === 'number' ? v : 0;
    };
    addUsage(acc, {
      input: num(2),
      cacheCreate: num(4),
      cacheRead: num(5),
      output: Math.max(num(3), num(9) + num(10))
    });
    counted += 1;
  }
  return counted;
}

const AGY_PAGE_ROWS = 20;

/**
 * Some Antigravity apps leave token counts out of the transcript and keep them in the conversation
 * database beside it. Returns null when there is no readable database.
 */
async function readAgyDatabaseUsage(transcriptPath) {
  const brainFolder = path.dirname(path.dirname(path.dirname(transcriptPath)));
  const dir = path.join(path.dirname(path.dirname(brainFolder)), 'conversations');
  const file = `${path.basename(brainFolder)}.db`;
  let db = null;
  try {
    if (!(await fs.exists(path.join(dir, file)))) return null;
    db = await sqlite.open(dir, file);
    const acc = emptyUsage();
    const seen = new Set();
    let turns = 0;
    let after = -1;
    for (;;) {
      const rows = await db.query('SELECT idx, data FROM gen_metadata WHERE idx > ? ORDER BY idx LIMIT ?', [after, AGY_PAGE_ROWS]);
      for (const row of rows) {
        after = row.idx;
        try {
          if (isBytes(row.data)) turns += readAgyGeneration(row.data, `row:${row.idx}`, seen, acc);
        } catch (_) {}
      }
      if (rows.length < AGY_PAGE_ROWS) break;
    }
    return turns > 0 ? { usage: acc, turns } : null;
  } catch (_) {
    return null;
  } finally {
    if (db) await db.close();
  }
}

async function summarizeAgyFile(filePath, stat) {
  const logsDir = path.dirname(filePath);
  const sysGenDir = path.dirname(logsDir);
  const brainFolder = path.dirname(sysGenDir);
  const id = path.basename(brainFolder);
  const fullPath = path.join(logsDir, 'transcript_full.jsonl');

  let project = null;
  let firstPrompt = null;
  let title = null;
  let model = null;
  let startedAt = null;
  let endedAt = null;
  let stepCount = 0;
  let hasUserInput = false;
  let step0Sender = null;

  const inspectLine = (line) => {
    let o;
    try {
      o = JSON.parse(line);
    } catch (_) {
      return;
    }
    if (typeof o.step_index === 'number' && o.step_index + 1 > stepCount) {
      stepCount = o.step_index + 1;
    }
    if (!startedAt && o.created_at) startedAt = o.created_at;
    if (o.created_at) endedAt = o.created_at;

    if (o.step_index <= 2 && o.type === 'SYSTEM_MESSAGE' && o.content && !step0Sender) {
      const sMatch = /\bsender=([0-9a-f-]{8,})/i.exec(o.content);
      if (sMatch) step0Sender = sMatch[1];
      if (!firstPrompt) {
        const cMatch = /\bcontent=([\s\S]*?)(?:<\/SYSTEM_MESSAGE>|$)/i.exec(o.content);
        if (cMatch) firstPrompt = oneLine(cMatch[1], 100);
      }
    }

    if (o.type === 'USER_INPUT' && o.content) {
      hasUserInput = true;
      if (!model) {
        const mMatch = /changed setting `Model Selection` from [^\r\n]+? to ([^\r\n.]+)/.exec(o.content);
        if (mMatch) model = mMatch[1].trim();
      }
      if (!firstPrompt) {
        const cleaned = cleanUserText(o.content);
        if (cleaned) firstPrompt = oneLine(cleaned, 100);
      }
    }
    if (!project) {
      project = inferProjectFromText(line);
    }
    if (!title && o.type === 'PLANNER_RESPONSE' && o.content) {
      const m = /^Dex\s*·\s*([^\r\n]+?)\s*·\s*(?:waiting|working|done|needs)/m.exec(o.content.trim());
      if (m) title = m[1].trim();
      else if (!firstPrompt) firstPrompt = oneLine(o.content, 100);
    }
  };

  const usageAcc = emptyUsage();
  let firstTs = null;
  let lastTs = null;
  const onRecord = (o) => {
    if (!firstTs && o.created_at) firstTs = o.created_at;
    if (o.created_at) lastTs = o.created_at;
    if (o.input_tokens || o.cache_read_tokens || o.output_tokens) {
      addUsage(usageAcc, {
        input: o.input_tokens || 0,
        cacheRead: o.cache_read_tokens || 0,
        output: o.output_tokens || 0
      });
    }
  };
  let headTs = null;
  await scanTranscript(filePath, stat.size, {
    wanted: ['"input_tokens"', '"cache_read_tokens"', '"output_tokens"'],
    onHead: l => inspectLine(l),
    onRecord,
    onTail: (l) => {
      if (headTs === null) {
        headTs = startedAt || '';
        endedAt = null;
      }
      inspectLine(l);
    },
    hasEnd: () => Boolean(endedAt),
    enough: () => Boolean(endedAt && firstPrompt)
  });
  startedAt = headTs || firstTs || startedAt;
  endedAt = endedAt || lastTs;
  if (finalizeUsage(usageAcc).total === 0) {
    const stored = await readAgyDatabaseUsage(filePath);
    if (stored) addUsage(usageAcc, stored.usage);
  }

  const isSubagent = Boolean(step0Sender && !hasUserInput);
  const finalStarted = startedAt || stat.birthtime.toISOString();
  const finalEnded = endedAt || stat.mtime.toISOString();
  const durationMs = Math.max(0, toMs(finalEnded, stat.mtimeMs) - toMs(finalStarted, stat.birthtimeMs));

  return {
    id,
    shortId: id.slice(0, 8),
    harness: 'agy',
    project: project || 'unknown',
    cwd: null,
    branch: null,
    model: model || null,
    title: title || firstPrompt || id.slice(0, 8),
    firstPrompt: firstPrompt || '',
    isSubagent,
    parentId: isSubagent ? step0Sender : null,
    stepCount,
    startedAt: finalStarted,
    endedAt: finalEnded,
    endedMs: toMs(finalEnded, stat.mtimeMs),
    durationMs,
    usage: finalizeUsage(usageAcc),
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    path: filePath,
    fullPath: (await fs.exists(fullPath)) ? fullPath : null
  };
}


function extractCodexIdFromPath(filePath) {
  const base = path.basename(path.basename(filePath, '.zst'), '.jsonl');
  const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(base);
  return m ? m[1] : base;
}

function codexUsageDelta(u) {
  if (!u || typeof u !== 'object') return null;
  const rawInput = Number(u.input_tokens) || 0;
  const cacheRead = Number(u.cached_input_tokens) || 0;
  const cacheCreate = Number(u.cache_write_input_tokens) || 0;
  const output = Number(u.output_tokens) || 0;
  // OpenAI/Codex input_tokens already includes cached_input_tokens
  const input = Math.max(0, rawInput - cacheRead - cacheCreate);
  return { input, cacheCreate, cacheRead, output };
}

function extractCodexOutputText(output) {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    return output
      .map(x => (typeof x === 'string' ? x : (x && x.text ? x.text : JSON.stringify(x))))
      .join('');
  }
  if (output && typeof output === 'object') return JSON.stringify(output);
  return '';
}

/** Picks the usage records a thread wrote itself, each response once. */
function createCodexOwnUsage(threadId) {
  const seen = new Set();
  return {
    threadId,
    take(p) {
      if (!p.usage || p.thread_id !== threadId) return null;
      if (p.response_id) {
        if (seen.has(p.response_id)) return null;
        seen.add(p.response_id);
      }
      return codexUsageDelta(p.usage);
    }
  };
}

async function summarizeCodexFile(filePath, stat) {
  let id = extractCodexIdFromPath(filePath);

  let cwd = null;
  let branch = null;
  let model = null;
  let firstPrompt = null;
  let title = null;
  let startedAt = null;
  let endedAt = null;
  let isSubagent = false;
  let parentId = null;
  let agentPath = null;
  let lastTotalUsage = null;
  const turnUsageAcc = emptyUsage();
  const own = createCodexOwnUsage(extractCodexIdFromPath(filePath));
  const ownUsageAcc = emptyUsage();
  let isFork = false;

  const inspectRecord = (o) => {
    if (!startedAt && o.timestamp) startedAt = o.timestamp;
    if (o.timestamp) endedAt = o.timestamp;
    const p = o.payload;
    if (!p || typeof p !== 'object') return;

    if (o.type === 'session_meta') {
      if (p.forked_from_id && p.forked_from_id !== p.id) isFork = true;
      if (p.id) id = String(p.id);
      else if (p.session_id && !id) id = String(p.session_id);
      if (!cwd && p.cwd) cwd = p.cwd;
      if (!branch && p.git && p.git.branch) branch = p.git.branch;
      if (p.timestamp && (!startedAt || toMs(p.timestamp) < toMs(startedAt))) startedAt = p.timestamp;
      if (p.parent_thread_id || p.thread_source === 'subagent' || (p.source && p.source.subagent)) {
        isSubagent = true;
        parentId = p.parent_thread_id || p.source?.subagent?.thread_spawn?.parent_thread_id || parentId;
        agentPath = p.agent_path || p.source?.subagent?.thread_spawn?.agent_path || agentPath;
      }
    } else if (o.type === 'turn_context') {
      if (!cwd && p.cwd) cwd = p.cwd;
      if (p.model) model = p.model;
    } else if (o.type === 'event_msg') {
      if (p.type === 'user_message' && p.message && !firstPrompt) {
        firstPrompt = oneLine(cleanUserText(p.message), 100);
      } else if (p.type === 'token_count' && p.info && p.info.total_token_usage) {
        lastTotalUsage = p.info.total_token_usage;
      } else if (p.type === 'task_complete' && p.last_agent_message && !title && isSubagent) {
        title = `[${agentPath || 'subagent'}] ${oneLine(p.last_agent_message, 80)}`;
      }
    } else if (o.type === 'token_usage_record') {
      const d = codexUsageDelta(p.usage || p.turn_token_usage);
      if (d) addUsage(turnUsageAcc, d);
      const ownDelta = own.take(p);
      if (ownDelta) addUsage(ownUsageAcc, ownDelta);
      if (p.thread_id && p.thread_id !== own.threadId) isFork = true;
    }
  };

  let tailDated = false;
  await scanTranscript(filePath, stat.size, {
    wanted: ['"session_meta"', '"turn_context"', '"user_message"', '"token_count"', '"task_complete"', '"token_usage_record"'],
    onRecord: inspectRecord,
    onTail: (l) => {
      try {
        const { timestamp } = JSON.parse(l);
        if (timestamp && !(tailDated && toMs(timestamp, 0) < toMs(endedAt, 0))) {
          endedAt = timestamp;
          tailDated = true;
        }
      } catch (_) {}
    },
    hasEnd: () => tailDated
  });

  const runningTotal = lastTotalUsage ? (codexUsageDelta(lastTotalUsage) || emptyUsage()) : turnUsageAcc;
  // A fork's running total includes history copied from its parent. Elsewhere the records win unless
  // they cover less, as when an older Codex wrote the first part of the file.
  const ownTotal = finalizeUsage(ownUsageAcc).total;
  const usageFromRecords = ownTotal > 0 && (isFork || !lastTotalUsage || ownTotal >= finalizeUsage(runningTotal).total);
  const usageAcc = usageFromRecords ? ownUsageAcc : runningTotal;
  const finalStarted = startedAt || stat.birthtime.toISOString();
  const finalEnded = endedAt || stat.mtime.toISOString();
  const durationMs = Math.max(0, toMs(finalEnded, stat.mtimeMs) - toMs(finalStarted, stat.birthtimeMs));
  const project = cwd ? path.basename(cwd) : 'unknown';
  if (!title && isSubagent && agentPath) {
    title = `[subagent] ${agentPath}`;
  }

  return {
    id,
    shortId: id.slice(0, 8),
    harness: 'codex',
    project: project || 'unknown',
    cwd: cwd || null,
    branch: branch || null,
    model: model || null,
    title: title || firstPrompt || id.slice(0, 8),
    firstPrompt: firstPrompt || '',
    isSubagent,
    parentId: parentId || null,
    startedAt: finalStarted,
    endedAt: finalEnded,
    endedMs: toMs(finalEnded, stat.mtimeMs),
    durationMs,
    usage: finalizeUsage(usageAcc),
    usageFromRecords,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    path: filePath
  };
}

async function discoverSessionStubs(opts = {}) {
    const { claudeDir, agyDirs, codexDirs } = defaultDirs(opts);
  const wantHarness = opts.harness ? opts.harness.toLowerCase() : null;
  const includeSubagents = Boolean(opts.includeSubagents || opts.subagents);
  const stubs = [];

  if ((!wantHarness || wantHarness === 'claude') && (await fs.exists(claudeDir))) {
    try {
      const files = await fs.glob('**/*.jsonl', { cwd: claudeDir, dot: true });
      for (const rel of files) {
        const norm = rel.replace(/\\/g, '/');
        const parts = norm.split('/');
        const fullFile = path.join(claudeDir, norm);
        const st = await safeStat(fullFile);
        if (!st || !st.isFile || st.size <= 0) continue;
        if (parts.length === 2) {
          const id = path.basename(fullFile, '.jsonl');
          stubs.push({ id, harness: 'claude', path: fullFile, stat: st, mtimeMs: st.mtimeMs });
        } else if (includeSubagents && parts.length === 4 && parts[2] === 'subagents') {
          const rawBase = path.basename(fullFile, '.jsonl');
          const rawId = rawBase.replace(/^agent-/, '');
          stubs.push({ id: rawId, rawId: rawBase, harness: 'claude', isSubagent: true, path: fullFile, stat: st, mtimeMs: st.mtimeMs });
        }
      }
    } catch (_) {}
  }

  for (const agyDir of !wantHarness || wantHarness === 'agy' || wantHarness === 'antigravity' ? agyDirs : []) {
    try {
      if (!(await fs.exists(agyDir))) continue;
      const files = await fs.glob('**/transcript.jsonl', { cwd: agyDir, dot: true });
      for (const rel of files) {
        const norm = rel.replace(/\\/g, '/');
        const parts = norm.split('/');
        if (parts.length !== 4 || parts[1] !== '.system_generated' || parts[2] !== 'logs') continue;
        const convId = parts[0];
        const tFile = path.join(agyDir, norm);
        const st = await safeStat(tFile);
        if (st && st.isFile && st.size > 0) {
          stubs.push({ id: convId, harness: 'agy', path: tFile, stat: st, mtimeMs: st.mtimeMs });
        }
      }
    } catch (_) {}
  }

  // Active before archived and plain before compressed: a later copy of a listed session is skipped.
  const seenCodex = new Set();
  const codexSources = codexDirs.flatMap(dir => ['**/*.jsonl', '**/*.jsonl.zst'].map(pattern => [dir, pattern]));
  for (const [codexDir, pattern] of !wantHarness || wantHarness === 'codex' ? codexSources : []) {
    const listed = new Set(seenCodex);
    try {
      if (!(await fs.exists(codexDir))) continue;
      const files = await fs.glob(pattern, { cwd: codexDir, dot: true });
      for (const rel of files) {
        const norm = rel.replace(/\\/g, '/');
        const fullFile = path.join(codexDir, norm);
        const st = await safeStat(fullFile);
        if (!st || !st.isFile || st.size <= 0) continue;
        const id = extractCodexIdFromPath(fullFile);
        if (listed.has(id)) continue;
        seenCodex.add(id);
        stubs.push({ id, harness: 'codex', path: fullFile, stat: st, mtimeMs: st.mtimeMs });
      }
    } catch (_) {}
  }

  stubs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  // A conversation opened in two Antigravity apps can exist twice; keep the newest copy.
  const seenAgy = new Set();
  return stubs.filter(s => s.harness !== 'agy' || (!seenAgy.has(s.id) && seenAgy.add(s.id)));
}

function resolveCachePath(opts = {}) {
  if (opts.noCache) return null;
  if (opts.cacheFile) return opts.cacheFile;
  const home = opts.homeDir || '~';
  return path.join(home, '.crunes', 'cache', 'session-index.json');
}

async function loadSessionCache(cachePath) {
  if (!cachePath) return {};
  try {
    if (!(await fs.exists(cachePath))) return {};
    const raw = await fs.read(cachePath, { throw: false });
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

async function saveSessionCache(cachePath, cacheObj) {
  if (!cachePath || !fs.write) return;
  try {
    await fs.write(cachePath, JSON.stringify(cacheObj));
  } catch (_) {}
}

// Raise when a summary is computed differently, so cached ones are rebuilt.
const CACHE_VERSION = 2;

async function hydrateStub(stub, cacheObj = null) {
  const cached = cacheObj && cacheObj[stub.path];
  if (
    cached &&
    cached.v === CACHE_VERSION &&
    cached.size === stub.stat.size &&
    cached.mtimeMs === stub.stat.mtimeMs &&
    cached.summary &&
    cached.summary.harness === stub.harness
  ) {
    return cached.summary;
  }
  let summary;
  if (stub.harness === 'claude') summary = await summarizeClaudeFile(stub.path, stub.stat);
  else if (stub.harness === 'codex') summary = await summarizeCodexFile(stub.path, stub.stat);
  else summary = await summarizeAgyFile(stub.path, stub.stat);

  if (cacheObj && summary) {
    cacheObj[stub.path] = { v: CACHE_VERSION, size: stub.stat.size, mtimeMs: stub.stat.mtimeMs, summary };
  }
  return summary;
}

const SAVE_EVERY = 100;

async function listSessions(opts = {}) {
    const stubs = await discoverSessionStubs(opts);
  const limit = Number(opts.limit) > 0 ? Number(opts.limit) : 15;
  const query = opts.query ? String(opts.query).toLowerCase().trim() : null;
  const explicitProject = opts.project ? String(opts.project).toLowerCase().trim() : null;
  const includeSubagents = Boolean(opts.subagents || opts.includeSubagents);
  const cwdBase = (!explicitProject && !opts.all && !query && opts.cwd)
    ? path.basename(opts.cwd).toLowerCase()
    : null;

  const matchesFilter = (s, projNeedle) => {
    const directIdHit = Boolean(query && s.id && s.id.toLowerCase().startsWith(query));
    if (s.isSubagent && !includeSubagents && !directIdHit) {
      return false;
    }
    if (projNeedle) {
      const pMatch =
        (s.project && s.project.toLowerCase().includes(projNeedle)) ||
        (s.cwd && s.cwd.toLowerCase().includes(projNeedle)) ||
        (s.title && s.title.toLowerCase().includes(projNeedle));
      if (!pMatch) return false;
    }
    if (query) {
      const qMatch =
        s.id.toLowerCase().includes(query) ||
        (s.project && s.project.toLowerCase().includes(query)) ||
        (s.title && s.title.toLowerCase().includes(query)) ||
        (s.firstPrompt && s.firstPrompt.toLowerCase().includes(query)) ||
        (s.cwd && s.cwd.toLowerCase().includes(query));
      if (!qMatch) return false;
    }
    return true;
  };

  const validSorts = new Set(['recent', 'tokens', 'duration', 'size']);
  const sortBy = opts.sort ? String(opts.sort).toLowerCase().trim() : 'recent';
  if (!validSorts.has(sortBy)) {
    throw new Error(`invalid sort "${opts.sort}" (expected: recent, tokens, duration, or size)`);
  }

  const hydratedCache = [];
  const activeProjNeedle = explicitProject || cwdBase;
  const cachePath = resolveCachePath(opts);
  const diskCache = await loadSessionCache(cachePath);
  const prevSize = Object.keys(diskCache).length;
  let cacheDirty = false;

  let unsaved = 0;
  for (const stub of stubs) {
    const before = diskCache[stub.path];
    let s;
    try {
      s = await hydrateStub(stub, diskCache);
    } catch (err) {
      if (opts.onSkip) opts.onSkip(stub, err);
      continue;
    }
    if (!before || before.v !== CACHE_VERSION || before.size !== stub.stat.size || before.mtimeMs !== stub.stat.mtimeMs) {
      cacheDirty = true;
      unsaved += 1;
      // A first scan can be long; saving along the way lets an interrupted one resume.
      if (unsaved >= SAVE_EVERY) {
        await saveSessionCache(cachePath, diskCache);
        unsaved = 0;
      }
    }
    hydratedCache.push(s);
  }
  if (cacheDirty || Object.keys(diskCache).length !== prevSize) {
    await saveSessionCache(cachePath, diskCache);
  }

  const sortList = (arr) => {
    const copy = [...arr];
    if (sortBy === 'tokens') {
      copy.sort((a, b) => (b.usage?.total || 0) - (a.usage?.total || 0));
    } else if (sortBy === 'duration') {
      copy.sort((a, b) => (b.durationMs || 0) - (a.durationMs || 0));
    } else if (sortBy === 'size') {
      copy.sort((a, b) => (b.size || 0) - (a.size || 0));
    } else {
      copy.sort((a, b) => (b.endedMs || b.mtimeMs || 0) - (a.endedMs || a.mtimeMs || 0));
    }
    return copy;
  };

  let matched = hydratedCache.filter(s => matchesFilter(s, activeProjNeedle));
  if (matched.length === 0 && cwdBase && !explicitProject && !query) {
    matched = hydratedCache.filter(s => includeSubagents || !s.isSubagent);
  }

  return sortList(matched).slice(0, limit);
}

async function resolveSession(idOrLatest, opts = {}) {
    if (idOrLatest && (await fs.exists(idOrLatest))) {
    const st = await safeStat(idOrLatest);
    if (st && st.isFile) {
      let firstLine = '{}';
      for await (const line of readLines(idOrLatest)) {
        firstLine = line || '{}';
        break;
      }
      let parsed = {};
      try {
        parsed = JSON.parse(firstLine);
      } catch (_) {}
      if (typeof parsed.step_index === 'number' || parsed.source === 'USER_EXPLICIT' || parsed.type === 'PLANNER_RESPONSE' || parsed.type === 'SYSTEM_MESSAGE') {
        return summarizeAgyFile(idOrLatest, st);
      }
      if (parsed.type === 'session_meta' || parsed.type === 'turn_context' || parsed.type === 'event_msg' || parsed.type === 'response_item') {
        return summarizeCodexFile(idOrLatest, st);
      }
      return summarizeClaudeFile(idOrLatest, st);
    }
  }

  if (!idOrLatest || idOrLatest === 'latest') {
    const scoped = await listSessions({ ...opts, limit: 1 });
    if (scoped[0]) return scoped[0];
    const topStubs = await discoverSessionStubs(opts);
    return topStubs[0] ? hydrateStub(topStubs[0]) : null;
  }

  const stubs = await discoverSessionStubs({ ...opts, includeSubagents: true });
  if (stubs.length === 0) return null;

  const needle = String(idOrLatest).toLowerCase().trim().replace(/^agent-/, '');
  const fastStub = stubs.find(
    st =>
      st.id.toLowerCase() === needle ||
      st.id.toLowerCase().startsWith(needle) ||
      (st.rawId && st.rawId.toLowerCase().startsWith(String(idOrLatest).toLowerCase().trim()))
  );
  if (fastStub) return hydrateStub(fastStub);

  for (const st of stubs) {
    const s = await hydrateStub(st);
    if (
      (s.title && s.title.toLowerCase().includes(needle)) ||
      (s.project && s.project.toLowerCase().includes(needle))
    ) {
      return s;
    }
  }
  return null;
}

function extractAnchorStamp(text) {
  if (!text || typeof text !== 'string') return null;
  const m = /Dexter anchor\s*\(([^)]+)\)/i.exec(text) || /\bcommit\s+([0-9a-f]{7,12}(?:-dirty)?)\b/i.exec(text);
  return m ? m[1].trim() : null;
}

function applyResultToToolCall(tc, rawOutput, isErrorStatus) {
  const outStr = typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput || '');
  tc.output = outStr;

  // Check for hook blocks or user rejections (only when step errored or explicitly rejected)
  if (
    isErrorStatus &&
    (/denied by pre-tool hook/i.test(outStr) ||
      /The user doesn't want to proceed with this tool use/i.test(outStr) ||
      /tool use was rejected/i.test(outStr))
  ) {
    tc.status = 'blocked';
    const reasonMatch = /denied by pre-tool hook:\s*([^\r\n]+)/i.exec(outStr);
    tc.errorSummary = reasonMatch ? oneLine(reasonMatch[1], 120) : oneLine(outStr, 120);
    return;
  }

  // Check for command exit codes
  const agyExit = /Command exited with code (\d+)/.exec(outStr);
  const claudeExit = /^Exit code (\d+)/m.exec(outStr);
  const codexExit = /"exit_code"\s*:\s*(\d+)/.exec(outStr);
  if (agyExit) {
    tc.exitCode = Number(agyExit[1]);
  } else if (claudeExit) {
    tc.exitCode = Number(claudeExit[1]);
  } else if (codexExit) {
    tc.exitCode = Number(codexExit[1]);
  } else if (tc.name === 'bash' && !isErrorStatus) {
    tc.exitCode = 0;
  }

  if (isErrorStatus || (typeof tc.exitCode === 'number' && tc.exitCode !== 0)) {
    tc.status = 'error';
    // Strip "Created At / Completed At / Command exited with code X / Command output:" headers for concise summary
    const cleanErr = outStr
      .replace(/^Created At:[^\r\n]*\r?\n/gm, '')
      .replace(/^Completed At:[^\r\n]*\r?\n/gm, '')
      .replace(/^Command exited with code \d+\.?\r?\n/gm, '')
      .replace(/^Command output:\s*/gm, '')
      .replace(/^Exit code \d+\r?\n/gm, '')
      .trim();
    tc.errorSummary = oneLine(cleanErr || outStr, 120);
  } else {
    tc.status = 'ok';
  }

  // Populate AskUserQuestion / ask_question answer if present
  if (tc.ask) {
    const claudeAns = /(?:The user answered|Your questions have been answered):\s*"[\s\S]*?"="([\s\S]*?)"(?:\.\s*You can now continue[\s\S]*|$)/i.exec(outStr);
    if (claudeAns) {
      tc.ask.answer = oneLine(claudeAns[1], 300);
    } else if (tc.status === 'ok' && outStr.trim()) {
      const cleanAns = outStr
        .replace(/^Created At:[^\r\n]*\r?\n/gm, '')
        .replace(/^Completed At:[^\r\n]*\r?\n/gm, '')
        .trim();
      if (cleanAns) tc.ask.answer = oneLine(cleanAns, 300);
    }
  }

  // Populate spawned subagent ID (conversationId in Antigravity, agentId in Claude Code)
  if (tc.name === 'subagent') {
    const childMatch =
      /"conversationId"\s*:\s*"([0-9a-f-]{8,})"/i.exec(outStr) ||
      /\bagentId["\s:=]+([0-9a-f]{8,})/i.exec(outStr);
    if (childMatch) {
      const shortChild = childMatch[1].slice(0, 8);
      tc.childId = shortChild;
      if (!tc.target.includes(`-> ${shortChild}`)) {
        tc.target = `${tc.target} -> ${shortChild}`;
      }
    }
  }
}

async function* readRecords(filePath) {
  for await (const raw of readLines(filePath)) {
    const line = raw.trim();
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch (_) { continue; }
    if (o && typeof o === 'object') yield o;
  }
}

// V8 keeps a whole parent string alive for a slice of it; a copy lets the large output go.
function detach(s) {
  return typeof s === 'string' ? JSON.parse(JSON.stringify(s)) : s;
}

function renderOutputExcerpt(output, step, shortId) {
  const cleanOut = output
    .replace(/^Created At:[^\r\n]*\r?\n/gm, '')
    .replace(/^Completed At:[^\r\n]*\r?\n/gm, '')
    .trim();
  return cleanOut ? truncateSandwich(cleanOut, { headLines: 10, tailLines: 8, maxChars: 1200, step, shortId }) : '';
}

/**
 * Keep rules say what a parse retains once the facts (status, exit code, answer) are taken from a
 * tool output. `output` runs as each output arrives; `step` selects steps kept in full. Without a
 * rule everything is kept.
 */
function keepForDigest(format) {
  const level = normalizeFormat(format, 'compact');
  const excerpts = level === 'extended' || level === 'full';
  return {
    step: () => false,
    thinking: level === 'full',
    output(tc, shortId) {
      if (excerpts) tc.excerpt = detach(renderOutputExcerpt(tc.output, tc.step, shortId));
      tc.output = '';
    }
  };
}

function keepForInspect(stepSpec) {
  const ranges = parseStepRanges(stepSpec);
  const step = i => ranges.some(([lo, hi]) => i >= lo && i <= hi);
  return {
    step,
    thinking: false,
    output(tc) {
      if (!step(tc.step) && !step(tc.resultStep)) tc.output = '';
    }
  };
}

function keepForSearch(matches) {
  return {
    step: () => false,
    thinking: false,
    output(tc) {
      tc.matched = matches(toolHaystack(tc));
      tc.output = '';
    }
  };
}

function toolHaystack(tc) {
  return `${tc.rawName} ${tc.target || ''} ${tc.output || ''}`;
}

function slimStep(s, keep) {
  if (!keep || keep.step(s.index) || s.tools.some(tc => keep.step(tc.resultStep))) return;
  if (s.rawContent) s.rawContent = '';
  if (s.thinking && !keep.thinking) s.thinking = '';
  if (s.kind === 'ephemeral' || s.kind === 'tool_result' || s.kind === 'compaction') s.text = '';
  for (const tc of s.tools) tc.args = {};
}

/**
 * Pairs streamed tool calls with their results. Each output is applied on arrival and then reduced
 * by the keep rule; mutations, errors and blocks are reported at the end, in call order.
 */
function createToolLedger(meta, keep) {
  const byId = new Map();
  const outcomes = [];
  let needsReplay = false;

  const settle = (tc, content, isError) => {
    applyResultToToolCall(tc, content, isError);
    if (!keep) return;
    keep.output(tc, meta.shortId);
    tc.errorSummary = detach(tc.errorSummary);
    tc.target = detach(tc.target);
    if (tc.childId) tc.childId = detach(tc.childId);
    if (tc.ask && tc.ask.answer) tc.ask.answer = detach(tc.ask.answer);
  };

  return {
    settle,
    call(id, tc, step, withResultStep = false) {
      tc.status = tc.status || 'ok';
      tc.output = '';
      outcomes.push({ tc, step, withResultStep });
      if (!id) return;
      const entry = byId.get(id) || { calls: [], hasResult: false };
      byId.set(id, entry);
      entry.calls.push({ tc, target: tc.target });
      // Its result has already gone by: a repeated row, or a result written before its call.
      if (entry.hasResult) needsReplay = true;
    },
    result(id, content, isError) {
      const entry = byId.get(id) || { calls: [], hasResult: false };
      byId.set(id, entry);
      entry.hasResult = true;
      for (const { tc, target } of entry.calls) {
        // The last result wins, so clear what an earlier one set.
        tc.target = target;
        for (const k of ['exitCode', 'errorSummary', 'excerpt', 'matched', 'childId']) delete tc[k];
        if (tc.ask) delete tc.ask.answer;
        settle(tc, content, isError);
      }
    },
    /** True when results must be streamed again, now that every call is known. */
    needsReplay: () => needsReplay,
    mutation(m) {
      outcomes.push({ mutation: m });
    },
    finish() {
      for (const { tc, step, withResultStep, mutation } of outcomes) {
        if (mutation) {
          meta.mutations.push(mutation);
          continue;
        }
        const at = withResultStep ? { step, resultStep: tc.resultStep } : { step };
        if (tc.mutation && tc.status === 'ok') {
          meta.mutations.push({ file: tc.target, fullPath: tc.file, op: tc.mutation, step });
        }
        if (tc.status === 'error') {
          meta.errors.push({ ...at, tool: tc.name, target: tc.target, summary: tc.errorSummary });
        } else if (tc.status === 'blocked') {
          meta.hookBlocks.push({ ...at, tool: tc.name, target: tc.target, reason: tc.errorSummary });
        }
      }
    }
  };
}

async function parseAntigravityTranscript(sessionSummary, keep) {
  const meta = {
    id: sessionSummary.id,
    shortId: sessionSummary.shortId,
    harness: 'agy',
    project: sessionSummary.project,
    cwd: sessionSummary.cwd,
    branch: null,
    title: sessionSummary.title,
    startedAt: sessionSummary.startedAt,
    endedAt: sessionSummary.endedAt,
    stepCount: 0,
    durationMs: sessionSummary.durationMs || 0,
    models: sessionSummary.model ? [sessionSummary.model] : [],
    usage: emptyUsage(),
    modelUsage: {},
    toolCounts: {},
    thinkingTurns: 0,
    anchors: [],
    compactions: [],
    skills: [],
    mutations: [],
    errors: [],
    hookBlocks: [],
    loops: []
  };

  const seenSkills = new Set();
  const seenAnchors = new Set();
  const seenModels = new Set(meta.models);
  const steps = [];
  const ledger = createToolLedger(meta, keep);
  const addStep = (s) => {
    steps.push(s);
    return s;
  };

  // Results arrive as GENERIC records, in call order, until the next planner response or user input.
  let open = null;
  const closeOpen = () => {
    if (open) slimStep(open.step, keep);
    open = null;
  };

  let i = -1;
  for await (const e of readRecords(sessionSummary.path)) {
    i += 1;
    meta.stepCount += 1;
    if (e.type === 'PLANNER_RESPONSE' || e.type === 'USER_INPUT') closeOpen();
    const stepIdx = typeof e.step_index === 'number' ? e.step_index : i;
    const ts = e.created_at || null;

    if (!meta.project || meta.project === 'unknown') {
      const inferred = inferProjectFromText(JSON.stringify(e));
      if (inferred) meta.project = inferred;
    }

    if (e.source === 'SYSTEM_SDK' && e.type === 'EPHEMERAL_MESSAGE') {
      const anchor = extractAnchorStamp(e.content);
      if (anchor && !seenAnchors.has(anchor)) {
        seenAnchors.add(anchor);
        meta.anchors.push(anchor);
      }
      slimStep(addStep({
        index: stepIdx,
        kind: 'ephemeral',
        timestamp: ts,
        text: e.content || '',
        tools: [],
        truncated: Array.isArray(e.truncated_fields) && e.truncated_fields.length > 0
      }), keep);
      continue;
    }

    if (e.type === 'USER_INPUT') {
      const mMatch = /changed setting `Model Selection` from [^\r\n]+? to ([^\r\n.]+)/.exec(e.content || '');
      if (mMatch && !seenModels.has(mMatch[1].trim())) {
        seenModels.add(mMatch[1].trim());
        meta.models.push(mMatch[1].trim());
      }
      slimStep(addStep({
        index: stepIdx,
        kind: 'user',
        timestamp: ts,
        text: cleanUserText(e.content || ''),
        rawContent: e.content || '',
        tools: [],
        truncated: Array.isArray(e.truncated_fields) && e.truncated_fields.length > 0
      }), keep);
      continue;
    }

    if (e.source === 'SYSTEM' && e.type === 'SYSTEM_MESSAGE') {
      const rawSys = e.content || '';
      const taskMatch = /sender=[0-9a-f-]+\/(task-\d+)/i.exec(rawSys);
      const senderMatch = /sender=([0-9a-f-]+)/i.exec(rawSys);
      const contentMatch = /content=([\s\S]*?)(?:<\/SYSTEM_MESSAGE>|$)/i.exec(rawSys);
      const bodyText = contentMatch ? contentMatch[1].trim() : rawSys.replace(/<\/?SYSTEM_MESSAGE>/g, '').trim();
      const senderId = taskMatch ? taskMatch[1] : (senderMatch ? senderMatch[1].slice(0, 8) : 'system');

      // When an Antigravity child subagent starts with a SYSTEM_MESSAGE from its parent brain
      // (at step 0, or step 1 right after an EPHEMERAL_MESSAGE anchor), treat it as the initial mission prompt.
      if (stepIdx <= 2 && !steps.some(s => s.kind !== 'ephemeral') && senderMatch && !taskMatch) {
        meta.isSubagent = true;
        meta.parentId = senderMatch[1].slice(0, 8);
        steps.push({
          index: stepIdx,
          kind: 'user',
          timestamp: ts,
          text: `[Parent #${meta.parentId}] ${bodyText}`,
          rawContent: rawSys,
          tools: [],
          truncated: Array.isArray(e.truncated_fields) && e.truncated_fields.length > 0
        });
        continue;
      }

      steps.push({
        index: stepIdx,
        kind: 'subagent',
        timestamp: ts,
        sender: senderId,
        text: bodyText,
        tools: [],
        truncated: Array.isArray(e.truncated_fields) && e.truncated_fields.length > 0
      });
      continue;
    }

    if (e.type === 'PLANNER_RESPONSE') {
      const rawCalls = Array.isArray(e.tool_calls) ? e.tool_calls : [];
      const tools = [];
      const stepUsage = {
        input: e.input_tokens || 0,
        cacheCreate: 0,
        cacheRead: e.cache_read_tokens || 0,
        output: e.output_tokens || 0
      };
      addUsage(meta.usage, stepUsage);
      const stepModel = meta.models[meta.models.length - 1] || 'antigravity';
      if (!meta.modelUsage[stepModel]) meta.modelUsage[stepModel] = { ...emptyUsage(), turns: 0 };
      addUsage(meta.modelUsage[stepModel], stepUsage);
      meta.modelUsage[stepModel].turns += 1;
      if (e.thinking) meta.thinkingTurns += 1;

      for (let k = 0; k < rawCalls.length; k++) {
        const rc = rawCalls[k];
        const tName = rc.name || rc.tool_name || 'tool';
        const tArgs = rc.args || rc.parameters || {};
        const norm = normalizeToolCall(tName, tArgs, meta.cwd);
        meta.toolCounts[norm.name] = (meta.toolCounts[norm.name] || 0) + 1;
        norm.step = stepIdx;
        norm.resultStep = stepIdx;
        norm.truncated = Array.isArray(e.truncated_fields) && e.truncated_fields.length > 0;
        norm.status = e.status === 'ERROR' ? 'error' : 'ok';
        ledger.call(null, norm, stepIdx, true);

        const skillName = detectSkillLoad(tName, norm.args);
        if (skillName && !seenSkills.has(skillName)) {
          seenSkills.add(skillName);
          meta.skills.push({ name: skillName, step: stepIdx });
        }

        tools.push(norm);
      }

      open = {
        pending: [...tools],
        step: addStep({
          index: stepIdx,
          kind: 'assistant',
          timestamp: ts,
          text: (e.content || '').trim(),
          thinking: (e.thinking || '').trim(),
          usage: finalizeUsage(stepUsage),
          tools,
          truncated: Array.isArray(e.truncated_fields) && e.truncated_fields.length > 0
        })
      };
      continue;
    }

    if (e.type === 'GENERIC') {
      const truncated = Array.isArray(e.truncated_fields) && e.truncated_fields.length > 0;
      const tc = open ? open.pending.shift() : null;
      if (tc) {
        tc.resultStep = stepIdx;
        tc.truncated = tc.truncated || truncated;
        ledger.settle(tc, e.content || '', e.status === 'ERROR');
      }
      slimStep(addStep({
        index: stepIdx,
        kind: 'tool_result',
        timestamp: ts,
        status: e.status,
        text: e.content || '',
        tools: [],
        truncated
      }), keep);
    }
  }
  closeOpen();
  ledger.finish();
  if (finalizeUsage(meta.usage).total === 0) {
    const stored = await readAgyDatabaseUsage(sessionSummary.path);
    if (stored) {
      const name = meta.models[meta.models.length - 1] || 'antigravity';
      meta.usage = { ...stored.usage };
      meta.modelUsage = { [name]: { ...stored.usage, turns: stored.turns } };
    }
  }

  return finalizeParsedSession(meta, steps, sessionSummary);
}

async function parseClaudeTranscript(sessionSummary, keep) {
  const meta = {
    id: sessionSummary.id,
    shortId: sessionSummary.shortId,
    harness: 'claude',
    project: sessionSummary.project,
    cwd: sessionSummary.cwd,
    branch: sessionSummary.branch,
    title: sessionSummary.title,
    startedAt: sessionSummary.startedAt,
    endedAt: sessionSummary.endedAt,
    stepCount: 0,
    durationMs: sessionSummary.durationMs || 0,
    models: sessionSummary.model ? [sessionSummary.model] : [],
    usage: emptyUsage(),
    modelUsage: {},
    toolCounts: {},
    thinkingTurns: 0,
    anchors: [],
    compactions: [],
    skills: [],
    mutations: [],
    errors: [],
    hookBlocks: [],
    loops: []
  };

  const seenSkills = new Set();
  const seenAnchors = new Set();
  const seenModels = new Set(meta.models);

  const ledger = createToolLedger(meta, keep);

  const readRowFacts = (e) => {
    if (!meta.cwd && e.cwd) {
      meta.cwd = e.cwd;
      meta.project = path.basename(e.cwd);
    }
    if (!meta.branch && e.gitBranch) meta.branch = e.gitBranch;
    if (e.type === 'ai-title' && e.aiTitle) meta.title = e.aiTitle;

    const mName = e.requestedModel || e.message?.model;
    if (mName && !seenModels.has(mName)) {
      seenModels.add(mName);
      meta.models.push(mName);
    }

    if (e.type === 'user' && e.message && Array.isArray(e.message.content)) {
      const rowAgentId = e.toolUseResult && e.toolUseResult.agentId ? String(e.toolUseResult.agentId) : null;
      for (const b of e.message.content) {
        if (b.type === 'tool_result' && b.tool_use_id) {
          let textOut = '';
          if (typeof b.content === 'string') textOut = b.content;
          else if (Array.isArray(b.content)) {
            textOut = b.content.map(x => x.text || JSON.stringify(x)).join('\n');
          } else if (b.content) {
            textOut = JSON.stringify(b.content);
          }
          if (rowAgentId && !textOut.includes(rowAgentId)) {
            textOut = `${textOut}\nagentId: ${rowAgentId}`;
          }
          ledger.result(b.tool_use_id, textOut, Boolean(b.is_error));
        }
      }
    }
  };

  const steps = [];
  let stepCounter = 0;
  const seenReqMsg = new Set();

  const cleanSubagentBody = (raw) => {
    if (raw.includes('<task-notification>')) {
      const resMatch = /<result>([\s\S]*?)<\/result>/i.exec(raw) || /<summary>([\s\S]*?)<\/summary>/i.exec(raw);
      if (resMatch) return resMatch[1].trim();
    }
    return raw
      .replace(/^Another Claude session sent a message:\s*/i, '')
      .replace(/<\/?agent-message[^>]*>/g, '')
      .replace(/^\s*\[Subagent hand-back\][^\r\n]*\r?\n+/i, '')
      .replace(/<\/?task-notification>/g, '')
      .trim();
  };

  const pushOrMergeSubagent = (sender, rawBody, ts) => {
    const body = cleanSubagentBody(rawBody);
    const existing = [...steps].reverse().find(s => s.kind === 'subagent' && s.sender === sender);
    if (existing) {
      if (body && (!existing.text || existing.text.startsWith('<task-id>'))) {
        existing.text = body;
      }
      return;
    }
    steps.push({
      index: stepCounter++,
      kind: 'subagent',
      timestamp: ts,
      sender,
      text: body,
      tools: [],
      truncated: false
    });
  };

  for await (const e of readRecords(sessionSummary.path)) {
    readRowFacts(e);
    const ts = e.timestamp || null;

    if (e.type === 'attachment' && e.attachment) {
      const att = e.attachment;
      const anchor = extractAnchorStamp(JSON.stringify(att));
      if (anchor && !seenAnchors.has(anchor)) {
        seenAnchors.add(anchor);
        meta.anchors.push(anchor);
      }
      if (att.type === 'queued_command' && typeof att.prompt === 'string' && att.prompt.includes('<agent-message')) {
        const fromMatch = /from="([^"]+)"/.exec(att.prompt);
        const sender = fromMatch ? fromMatch[1].slice(0, 8) : 'subagent';
        pushOrMergeSubagent(sender, att.prompt, ts);
      }
      continue;
    }

    if (e.type === 'system' && e.subtype === 'compact_boundary') {
      const idx = stepCounter++;
      meta.compactions.push({ step: idx, timestamp: ts });
      steps.push({
        index: idx,
        kind: 'compaction',
        timestamp: ts,
        text: 'Context compacted',
        tools: [],
        truncated: false
      });
      continue;
    }

    if (e.type === 'user' && e.message) {
      const c = e.message.content;
      const textParts = [];

      if (typeof c === 'string') {
        textParts.push(c);
      } else if (Array.isArray(c)) {
        for (const b of c) {
          if (b.type === 'text' && b.text) textParts.push(b.text);
        }
      }

      for (const rawPart of textParts) {
        const skillFromPayload = isInjectedSkillPayload(rawPart);
        if (skillFromPayload) {
          if (!seenSkills.has(skillFromPayload)) {
            seenSkills.add(skillFromPayload);
            meta.skills.push({ name: skillFromPayload, step: Math.max(0, stepCounter - 1) });
          }
          continue;
        }
        if (isCompactionSummaryText(rawPart)) {
          const idx = stepCounter++;
          meta.compactions.push({ step: idx, timestamp: ts });
          const s = { index: idx, kind: 'compaction', timestamp: ts, text: rawPart, tools: [], truncated: false };
          slimStep(s, keep);
          steps.push(s);
          continue;
        }

        if (rawPart.includes('<agent-message') || rawPart.includes('<task-notification>')) {
          const fromMatch = /from="([^"]+)"/.exec(rawPart) || /<task-id>([^<]+)<\/task-id>/.exec(rawPart);
          const sender = fromMatch ? fromMatch[1].slice(0, 8) : 'subagent';
          pushOrMergeSubagent(sender, rawPart, ts);
          continue;
        }

        const cleaned = cleanUserText(rawPart);
        if (cleaned) {
          const s = { index: stepCounter++, kind: 'user', timestamp: ts, text: cleaned, rawContent: rawPart, tools: [], truncated: false };
          slimStep(s, keep);
          steps.push(s);
        }
      }
      continue;
    }

    if (e.type === 'assistant' && e.message && Array.isArray(e.message.content)) {
      let text = '';
      let thinking = '';
      const tools = [];
      const currentIdx = stepCounter;
      let stepUsage = emptyUsage();
      if (e.message.usage) {
        const rid = e.requestId || '';
        const mid = e.message.id || '';
        const key = (rid && mid) ? `${rid}:${mid}` : null;
        if (!key || !seenReqMsg.has(key)) {
          if (key) seenReqMsg.add(key);
          const u = e.message.usage;
          const delta = {
            input: u.input_tokens || 0,
            cacheCreate: u.cache_creation_input_tokens || 0,
            cacheRead: u.cache_read_input_tokens || 0,
            output: u.output_tokens || 0
          };
          addUsage(meta.usage, delta);
          stepUsage = finalizeUsage(delta);
          const mName = e.requestedModel || e.message.model || 'claude';
          if (!meta.modelUsage[mName]) meta.modelUsage[mName] = { ...emptyUsage(), turns: 0 };
          addUsage(meta.modelUsage[mName], delta);
          meta.modelUsage[mName].turns += 1;
        }
      }

      for (const b of e.message.content) {
        if (b.type === 'text' && b.text) {
          text += (text ? '\n' : '') + b.text.trim();
        } else if (b.type === 'thinking' && b.thinking) {
          thinking += (thinking ? '\n' : '') + b.thinking.trim();
        } else if (b.type === 'tool_use') {
          const norm = normalizeToolCall(b.name, b.input || {}, meta.cwd);
          norm.step = currentIdx;
          norm.resultStep = currentIdx;
          norm.truncated = false;

          ledger.call(b.id, norm, currentIdx);

          const skillName = detectSkillLoad(b.name, norm.args);
          if (skillName && !seenSkills.has(skillName)) {
            seenSkills.add(skillName);
            meta.skills.push({ name: skillName, step: currentIdx });
          }

          meta.toolCounts[norm.name] = (meta.toolCounts[norm.name] || 0) + 1;
          tools.push(norm);
        }
      }

      if (text || thinking || tools.length > 0) {
        // Merge consecutive single-block assistant lines that belong to the same logical step if previous step is assistant with no text and only thinking
        const prev = steps[steps.length - 1];
        if (thinking) meta.thinkingTurns += 1;
        if (prev && prev.kind === 'assistant' && !prev.text && prev.tools.length === 0 && !thinking && (text || tools.length > 0)) {
          prev.text = text;
          prev.endTimestamp = ts || prev.endTimestamp;
          const merged = { ...prev.usage };
          addUsage(merged, stepUsage);
          prev.usage = finalizeUsage(merged);
          for (const tc of tools) {
            tc.step = prev.index;
            tc.resultStep = prev.index;
            prev.tools.push(tc);
          }
          slimStep(prev, keep);
        } else {
          steps.push({
            index: stepCounter++,
            kind: 'assistant',
            timestamp: ts,
            endTimestamp: ts,
            text,
            thinking,
            usage: stepUsage,
            tools,
            truncated: false
          });
          slimStep(steps[steps.length - 1], keep);
        }
      }
    }
  }
  if (ledger.needsReplay()) {
    for await (const e of readRecords(sessionSummary.path)) readRowFacts(e);
  }

  ledger.finish();
  meta.stepCount = steps.length;
  return finalizeParsedSession(meta, steps, sessionSummary);
}

function foldToolRuns(toolCalls) {
  const runs = [];
  for (const tc of toolCalls) {
    const prev = runs[runs.length - 1];
    // Error, blocked, ask, subagent, and bash calls always stand on their own line
    const canFold = tc.status === 'ok' && !tc.ask && tc.name !== 'subagent' && tc.name !== 'bash';
    const isReadLike = tc.name === 'read' || tc.name === 'grep' || tc.name === 'glob';
    if (
      canFold &&
      prev &&
      prev.canFold &&
      prev.name === tc.name
    ) {
      prev.endStep = tc.step;
      const lastTarget = prev.targets[prev.targets.length - 1];
      if (lastTarget && lastTarget.target === tc.target) {
        lastTarget.count++;
        if (isReadLike && tc.step > lastTarget.startStep) {
          lastTarget.isLoop = true;
        }
      } else {
        prev.targets.push({ target: tc.target, count: 1, startStep: tc.step, endStep: tc.step, isLoop: false });
      }
      prev.count++;
    } else {
      runs.push({
        name: tc.name,
        startStep: tc.step,
        endStep: tc.step,
        status: tc.status,
        exitCode: tc.exitCode,
        errorSummary: tc.errorSummary,
        output: tc.output || '',
        excerpt: tc.excerpt,
        ask: tc.ask || null,
        canFold,
        count: 1,
        targets: [{ target: tc.target, count: 1, startStep: tc.step, endStep: tc.step, isLoop: false }]
      });
    }
  }
  return runs;
}

function finalizeParsedSession(meta, steps, sessionSummary) {
  // Detect consecutive identical tool+target loops across distinct steps (excluding multi-anchor edits)
  let currentStreak = null;
  const flushStreak = () => {
    if (currentStreak && currentStreak.count >= 2 && currentStreak.endStep > currentStreak.startStep) {
      meta.loops.push({ ...currentStreak });
    }
    currentStreak = null;
  };

  for (const s of steps) {
    if (s.kind !== 'assistant' || !Array.isArray(s.tools)) continue;
    for (const tc of s.tools) {
      if (tc.name === 'edit' || tc.name === 'write') {
        flushStreak();
        continue;
      }
      const sig = `${tc.name}(${tc.target})`;
      if (currentStreak && currentStreak.signature === sig) {
        currentStreak.endStep = tc.step;
        currentStreak.count++;
      } else {
        flushStreak();
        currentStreak = {
          signature: sig,
          tool: tc.name,
          target: tc.target,
          startStep: tc.step,
          endStep: tc.step,
          count: 1
        };
      }
    }
  }
  flushStreak();

  // Build conversational turns
  const turns = [];
  let userTurnNum = 0;
  let currentAssistant = null;

  const flushAssistant = () => {
    if (!currentAssistant) return;
    currentAssistant.toolRuns = foldToolRuns(currentAssistant.tools);
    currentAssistant.usage = finalizeUsage(currentAssistant.usageAcc);
    currentAssistant.durationMs = Math.max(
      0,
      toMs(currentAssistant.endTimestamp, 0) - toMs(currentAssistant.timestamp, 0)
    );
    turns.push(currentAssistant);
    currentAssistant = null;
  };

  for (const s of steps) {
    if (s.kind === 'ephemeral' || s.kind === 'tool_result') continue;

    if (s.kind === 'compaction') {
      flushAssistant();
      turns.push({
        kind: 'compaction',
        step: s.index,
        timestamp: s.timestamp
      });
      continue;
    }

    if (s.kind === 'user') {
      flushAssistant();
      userTurnNum++;
      turns.push({
        kind: 'user',
        turnNum: userTurnNum,
        step: s.index,
        timestamp: s.timestamp,
        text: s.text
      });
      continue;
    }

    if (s.kind === 'subagent') {
      if (!currentAssistant) {
        currentAssistant = {
          kind: 'assistant',
          turnNum: Math.max(1, userTurnNum),
          startStep: s.index,
          endStep: s.index,
          timestamp: s.timestamp,
          endTimestamp: s.timestamp,
          usageAcc: emptyUsage(),
          tools: [],
          subagentReplies: [],
          thinkings: [],
          texts: []
        };
      }
      currentAssistant.endStep = s.index;
      if (s.timestamp) currentAssistant.endTimestamp = s.timestamp;
      currentAssistant.subagentReplies.push({
        step: s.index,
        sender: s.sender,
        summary: oneLine(s.text, 120),
        text: s.text
      });
      continue;
    }

    if (s.kind === 'assistant') {
      if (!currentAssistant) {
        currentAssistant = {
          kind: 'assistant',
          turnNum: Math.max(1, userTurnNum),
          startStep: s.index,
          endStep: s.index,
          timestamp: s.timestamp,
          endTimestamp: s.endTimestamp || s.timestamp,
          usageAcc: emptyUsage(),
          tools: [],
          subagentReplies: [],
          thinkings: [],
          texts: []
        };
      }
      currentAssistant.endStep = s.index;
      if (s.endTimestamp || s.timestamp) currentAssistant.endTimestamp = s.endTimestamp || s.timestamp;
      if (s.usage) addUsage(currentAssistant.usageAcc, s.usage);
      for (const tc of s.tools) {
        currentAssistant.tools.push(tc);
      }
      if (s.thinking) {
        currentAssistant.thinkings.push({ step: s.index, thinking: s.thinking });
      }
      if (s.text) {
        currentAssistant.texts.push({ step: s.index, text: s.text });
      }
    }
  }
  flushAssistant();

  meta.turnCount = userTurnNum;
  meta.usage = finalizeUsage(meta.usage);
  for (const m of Object.keys(meta.modelUsage)) {
    meta.modelUsage[m] = { ...finalizeUsage(meta.modelUsage[m]), turns: meta.modelUsage[m].turns };
  }
  if (!meta.durationMs && meta.startedAt && meta.endedAt) {
    meta.durationMs = Math.max(0, toMs(meta.endedAt, 0) - toMs(meta.startedAt, 0));
  }

  // Synthesize Cold-Pickup Coordinates
  const touchedMap = new Map();
  for (const m of meta.mutations) {
    const prev = touchedMap.get(m.file) || { file: m.file, ops: [], lastStep: m.step };
    prev.ops.push(`${m.op}#${m.step}`);
    prev.lastStep = m.step;
    touchedMap.set(m.file, prev);
  }

  let lastCommand = null;
  let openQuestion = null;
  let lastStatusLine = null;

  for (const s of steps) {
    if (s.kind === 'user') {
      openQuestion = null;
      continue;
    }
    if (s.kind !== 'assistant') continue;
    if (s.text) {
      const firstLine = s.text.split('\n')[0].trim();
      if (firstLine.startsWith('Dex · ') || firstLine.startsWith('[Dexter |')) {
        lastStatusLine = firstLine;
      }
    }
    for (const tc of s.tools) {
      if (tc.name === 'bash') {
        lastCommand = {
          step: tc.step,
          command: tc.target,
          status: tc.status,
          exitCode: tc.exitCode
        };
      }
      if (tc.ask && tc.status === 'ok') {
        openQuestion = tc.ask.answer ? null : { step: tc.step, question: tc.ask.question, options: tc.ask.options };
      }
    }
  }

  const pickup = {
    touchedFiles: Array.from(touchedMap.values()),
    lastCommand,
    lastError: meta.errors.length > 0 ? meta.errors[meta.errors.length - 1] : null,
    openQuestion,
    lastStatusLine
  };

  return {
    meta,
    steps,
    turns,
    pickup,
    sessionSummary
  };
}


async function parseCodexTranscript(sessionSummary, keep) {
  const meta = {
    id: sessionSummary.id,
    shortId: sessionSummary.shortId,
    harness: 'codex',
    project: sessionSummary.project,
    cwd: sessionSummary.cwd,
    branch: sessionSummary.branch,
    title: sessionSummary.title,
    startedAt: sessionSummary.startedAt,
    endedAt: sessionSummary.endedAt,
    stepCount: 0,
    durationMs: sessionSummary.durationMs || 0,
    models: sessionSummary.model ? [sessionSummary.model] : [],
    usage: emptyUsage(),
    modelUsage: {},
    toolCounts: {},
    thinkingTurns: 0,
    anchors: [],
    compactions: [],
    skills: [],
    mutations: [],
    errors: [],
    hookBlocks: [],
    loops: []
  };

  const seenModels = new Set(meta.models);
  const ledger = createToolLedger(meta, keep);
  const readResult = (e) => {
    const p = e.payload;
    if (e.type !== 'response_item' || !p || !p.call_id) return;
    if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      ledger.result(p.call_id, extractCodexOutputText(p.output), false);
    }
  };

  const steps = [];
  let stepCounter = 0;
  let lastTotalTokensSeen = 0;
  const own = sessionSummary.usageFromRecords ? createCodexOwnUsage(extractCodexIdFromPath(sessionSummary.path)) : null;
  let lastCompactionTs = 0;

  const attachUsageToLatestAssistant = (delta, ts, endsTurn = true) => {
    addUsage(meta.usage, delta);
    const stepUsage = finalizeUsage(delta);
    const mName = meta.models[meta.models.length - 1] || 'codex';
    if (!meta.modelUsage[mName]) meta.modelUsage[mName] = { ...emptyUsage(), turns: 0 };
    addUsage(meta.modelUsage[mName], delta);
    meta.modelUsage[mName].turns += 1;

    const lastAssistant = [...steps].reverse().find(s => s.kind === 'assistant');
    if (lastAssistant) {
      const merged = { ...lastAssistant.usage };
      addUsage(merged, delta);
      lastAssistant.usage = finalizeUsage(merged);
      if (ts && endsTurn) lastAssistant.endTimestamp = ts;
    } else {
      steps.push({
        index: stepCounter++,
        kind: 'assistant',
        timestamp: ts,
        endTimestamp: ts,
        text: '',
        thinking: '',
        usage: stepUsage,
        tools: [],
        truncated: false
      });
    }
  };

  for await (const e of readRecords(sessionSummary.path)) {
    const ts = e.timestamp || null;
    const p = e.payload;
    if (!p || typeof p !== 'object') continue;

    if (e.type === 'session_meta') {
      if (!meta.cwd && p.cwd) {
        meta.cwd = p.cwd;
        meta.project = path.basename(p.cwd);
      }
      if (!meta.branch && p.git && p.git.branch) meta.branch = p.git.branch;
      if (p.parent_thread_id || p.thread_source === 'subagent' || (p.source && p.source.subagent)) {
        meta.isSubagent = true;
        meta.parentId = p.parent_thread_id || p.source?.subagent?.thread_spawn?.parent_thread_id || meta.parentId;
      }
      continue;
    }

    if (e.type === 'token_usage_record') {
      const delta = own && own.take(p);
      // Tokens only: a compaction's record would stretch the turn before it.
      if (delta) attachUsageToLatestAssistant(delta, ts, false);
      continue;
    }

    if (e.type === 'turn_context') {
      if (!meta.cwd && p.cwd) {
        meta.cwd = p.cwd;
        meta.project = path.basename(p.cwd);
      }
      if (p.model && !seenModels.has(p.model)) {
        seenModels.add(p.model);
        meta.models.push(p.model);
      }
      continue;
    }

    if (e.type === 'compacted' || (e.type === 'event_msg' && p.type === 'context_compacted')) {
      const tsMs = toMs(ts, 0);
      if (lastCompactionTs && Math.abs(tsMs - lastCompactionTs) < 5000) continue;
      lastCompactionTs = tsMs || Date.now();
      const idx = stepCounter++;
      meta.compactions.push({ step: idx, timestamp: ts });
      steps.push({
        index: idx,
        kind: 'compaction',
        timestamp: ts,
        text: p.message || 'Context compacted',
        tools: [],
        truncated: false
      });
      slimStep(steps[steps.length - 1], keep);
      continue;
    }

    if (e.type === 'event_msg') {
      if (p.type === 'user_message' && p.message) {
        const cleaned = cleanUserText(p.message);
        if (cleaned) {
          steps.push({
            index: stepCounter++,
            kind: 'user',
            timestamp: ts,
            text: cleaned,
            rawContent: p.message,
            tools: [],
            truncated: false
          });
          slimStep(steps[steps.length - 1], keep);
        }
      } else if (p.type === 'token_count' && p.info) {
        const tot = Number(p.info.total_token_usage?.total_tokens) || 0;
        if (tot > lastTotalTokensSeen && p.info.last_token_usage) {
          lastTotalTokensSeen = tot;
          const delta = codexUsageDelta(p.info.last_token_usage);
          if (own) {
            const lastAssistant = steps.findLast(s => s.kind === 'assistant');
            if (lastAssistant && ts) lastAssistant.endTimestamp = ts;
          } else if (delta) attachUsageToLatestAssistant(delta, ts);
        }
      } else if (p.type === 'patch_apply_end' && p.success && p.changes && typeof p.changes === 'object') {
        const refStep = Math.max(0, stepCounter - 1);
        for (const filePath of Object.keys(p.changes)) {
          const ch = p.changes[filePath];
          const op = ch && ch.type === 'add' ? 'write' : 'edit';
          ledger.mutation({ file: shortPath(filePath, meta.cwd), fullPath: filePath, op, step: refStep });
        }
      }
      continue;
    }

    if (e.type === 'response_item') {
      if (p.type === 'message' && p.role === 'assistant' && Array.isArray(p.content)) {
        const text = p.content
          .filter(b => b && b.text)
          .map(b => b.text.trim())
          .filter(Boolean)
          .join('\n');
        if (text) {
          steps.push({
            index: stepCounter++,
            kind: 'assistant',
            timestamp: ts,
            endTimestamp: ts,
            text,
            thinking: '',
            usage: emptyUsage(),
            tools: [],
            truncated: false
          });
        }
      } else if (p.type === 'agent_message' && Array.isArray(p.content)) {
        const text = p.content
          .filter(b => b && b.text)
          .map(b => b.text.trim())
          .filter(Boolean)
          .join('\n');
        if (meta.isSubagent && !steps.some(s => s.kind === 'user')) {
          steps.push({
            index: stepCounter++,
            kind: 'user',
            timestamp: ts,
            text: `[Parent #${(meta.parentId || 'root').slice(0, 8)}] ${text || p.recipient || 'subagent task'}`,
            rawContent: text,
            tools: [],
            truncated: false
          });
        } else if (!meta.isSubagent && p.recipient === '/root') {
          steps.push({
            index: stepCounter++,
            kind: 'subagent',
            timestamp: ts,
            sender: path.basename(p.author || 'subagent'),
            text,
            tools: [],
            truncated: false
          });
        }
      } else if (p.type === 'reasoning') {
        meta.thinkingTurns += 1;
        const summaryText = Array.isArray(p.summary)
          ? p.summary.map(s => (typeof s === 'string' ? s : s?.text || '')).filter(Boolean).join('\n')
          : '';
        if (summaryText) {
          steps.push({
            index: stepCounter++,
            kind: 'assistant',
            timestamp: ts,
            endTimestamp: ts,
            text: '',
            thinking: summaryText,
            usage: emptyUsage(),
            tools: [],
            truncated: false
          });
          slimStep(steps[steps.length - 1], keep);
        }
      } else if (p.type === 'custom_tool_call' || p.type === 'function_call') {
        let rawArgs = {};
        if (p.arguments) {
          if (typeof p.arguments === 'string') {
            try { rawArgs = JSON.parse(p.arguments); } catch (_) { rawArgs = { input: p.arguments }; }
          } else if (typeof p.arguments === 'object') {
            rawArgs = p.arguments;
          }
        } else if (p.input !== undefined) {
          rawArgs = typeof p.input === 'object' ? p.input : { input: String(p.input) };
        }
        const currentIdx = stepCounter;
        const norm = normalizeToolCall(p.name, rawArgs, meta.cwd);
        norm.step = currentIdx;
        norm.resultStep = currentIdx;
        norm.truncated = false;

        ledger.call(p.call_id, norm, currentIdx);
        meta.toolCounts[norm.name] = (meta.toolCounts[norm.name] || 0) + 1;

        steps.push({
          index: stepCounter++,
          kind: 'assistant',
          timestamp: ts,
          endTimestamp: ts,
          text: '',
          thinking: '',
          usage: emptyUsage(),
          tools: [norm],
          truncated: false
        });
        slimStep(steps[steps.length - 1], keep);
      } else {
        readResult(e);
      }
    }
  }
  if (ledger.needsReplay()) {
    for await (const e of readRecords(sessionSummary.path)) readResult(e);
  }

  ledger.finish();
  meta.stepCount = steps.length;
  return finalizeParsedSession(meta, steps, sessionSummary);
}

async function parseSession(sessionOrId, opts = {}) {
    const summary = typeof sessionOrId === 'object' && sessionOrId !== null && sessionOrId.path
    ? sessionOrId
    : await resolveSession(sessionOrId, opts);

  if (!summary) {
    throw new Error(`session not found: ${sessionOrId || 'latest'}`);
  }

  if (summary.harness === 'agy') {
    return parseAntigravityTranscript(summary, opts.keep);
  }
  if (summary.harness === 'codex') {
    return parseCodexTranscript(summary, opts.keep);
  }
  return parseClaudeTranscript(summary, opts.keep);
}

function fmtDateLocal(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    const m = /T(\d{2}:\d{2})/.exec(iso);
    return m ? m[1] : iso.slice(0, 16);
  }
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function fmtSpan(startIso, endIso) {
  if (!startIso) return '';
  const sDate = fmtDateLocal(startIso);
  const sTime = fmtTime(startIso);
  if (!endIso) return `${sDate} ${sTime}`;
  const eDate = fmtDateLocal(endIso);
  const eTime = fmtTime(endIso);
  if (sDate !== eDate) return `${sDate} ${sTime}..${eDate} ${eTime}`;
  return sTime && eTime && sTime !== eTime ? `${sDate} ${sTime}..${eTime}` : `${sDate} ${sTime}`;
}

function stepLabel(start, end) {
  return start === end ? `#${start}` : `#${start}..${end}`;
}

function formatToolRunLine(run) {
  const lbl = `[${stepLabel(run.startStep, run.endStep)}]`;

  if (run.status === 'error') {
    const t = run.targets[0]?.target || '';
    const exitStr = typeof run.exitCode === 'number' ? ` -> exit ${run.exitCode}` : '';
    return `- \`[${stepLabel(run.startStep, run.endStep)} · ERROR]\` \`${run.name}\` (${t})${exitStr}: ${run.errorSummary || 'failed'}`;
  }

  if (run.status === 'blocked') {
    const t = run.targets[0]?.target || '';
    return `- \`[${stepLabel(run.startStep, run.endStep)} · BLOCKED]\` \`${run.name}\` (${t}): ${run.errorSummary || 'blocked by hook/user'}`;
  }

  if (run.ask) {
    const lines = [`- **Ask (\`${run.name}\` [${stepLabel(run.startStep, run.endStep)}]):** ${run.ask.question}`];
    const options = Array.isArray(run.ask.options) ? run.ask.options.filter(Boolean) : [];
    const listOptions = opts => opts.map(o => `\`${oneLine(o, 60)}\``).join(', ');
    if (run.ask.answer) {
      // A typed-in answer matches no option; the list is then labelled neutrally, never as "not picked".
      // Longest match wins, so "Yes" is not taken for the pick when the answer was "Yes, later".
      const picked = options
        .filter(o => run.ask.answer.includes(oneLine(o, 300)))
        .sort((a, b) => b.length - a.length)[0];
      const description = picked ? (run.ask.optionDescriptions || [])[run.ask.options.indexOf(picked)] : '';
      lines.push(`  - \`-> [Answered]\` ${run.ask.answer}${description ? `: ${oneLine(description, 300)}` : ''}`);
      const rest = options.filter(o => o !== picked);
      if (rest.length > 0) {
        lines.push(`  - *${picked ? 'not picked' : 'options'}:* ${listOptions(rest)}`);
      }
    } else if (options.length > 0) {
      lines.push(`  - *options:* ${listOptions(options)}`);
    }
    return lines.join('\n');
  }

  if (run.name === 'bash') {
    const t = run.targets[0]?.target || '';
    const exitStr = typeof run.exitCode === 'number' ? ` -> exit ${run.exitCode}` : '';
    return `- \`${lbl}\` \`bash\` (${t}${exitStr})`;
  }

  const targetParts = run.targets.map(item => {
    if (item.count >= 2) {
      return `\`${item.target}\` ×${item.count}${item.isLoop ? ` **[LOOP ×${item.count}]**` : ''}`;
    }
    return `\`${item.target}\``;
  });

  return `- \`${lbl}\` \`${run.name}\` (${targetParts.join(', ')})`;
}

function formatMutationSummary(f) {
  if (f.ops.length <= 3) {
    return `\`${f.file}\` (${f.ops.join(', ')})`;
  }
  return `\`${f.file}\` (×${f.ops.length}, last #${f.lastStep})`;
}

function formatDigestMarkdown(parsed, opts = {}) {
  const { meta, turns, pickup } = parsed;
  const format = normalizeFormat(opts.format, 'compact');
  const lines = [];

  const branchInfo = meta.branch ? ` (${meta.branch})` : '';
  lines.push(
    `# Session ${meta.shortId} (${meta.harness} · ${meta.project}${branchInfo} · ${fmtSpan(meta.startedAt, meta.endedAt)} · ${meta.stepCount} steps · format: ${format})`
  );

  // Telemetry line
  const modelsStr = meta.models.length > 0 ? meta.models.join(', ') : 'unknown';
  const anchorsStr = meta.anchors.length > 0 ? meta.anchors.join(', ') : 'none';
  const compStr = meta.compactions.length > 0
    ? `${meta.compactions.length} (${meta.compactions.map(c => `#${c.step}`).join(', ')})`
    : '0';
  lines.push(`- **Telemetry:** model \`${modelsStr}\` · anchor \`${anchorsStr}\` · compactions: ${compStr}`);

  if (format !== 'compact') {
    // Skills loaded
    if (meta.skills.length > 0) {
      lines.push(`- **Skills loaded:** ${meta.skills.map(s => `\`${s.name}\` (#${s.step})`).join(', ')}`);
    } else {
      lines.push(`- **Skills loaded:** none`);
    }

    // Mutations (compact when many ops or many files)
    if (pickup.touchedFiles.length > 0) {
      const shownFiles = pickup.touchedFiles.slice(0, 12).map(formatMutationSummary);
      const extraCount = pickup.touchedFiles.length - shownFiles.length;
      const extraSuffix = extraCount > 0 ? `, +${extraCount} more in Pickup Coordinates` : '';
      lines.push(`- **Mutations (${pickup.touchedFiles.length} file${pickup.touchedFiles.length === 1 ? '' : 's'}):** ${shownFiles.join(', ')}${extraSuffix}`);
    } else {
      lines.push(`- **Mutations:** none (read-only)`);
    }
  }

  // Flags (errors, hook blocks, loops — capped for readability on 2,000+ step sessions)
  const flagParts = [];
  if (meta.errors.length > 0) {
    const errSteps = meta.errors.slice(0, 12).map(e => `#${e.step}`).join(', ');
    const moreErr = meta.errors.length > 12 ? `, +${meta.errors.length - 12} more` : '';
    flagParts.push(`${meta.errors.length} error(s) (${errSteps}${moreErr})`);
  }
  if (meta.hookBlocks.length > 0) {
    const blkSteps = meta.hookBlocks.slice(0, 10).map(b => `#${b.step}`).join(', ');
    const moreBlk = meta.hookBlocks.length > 10 ? `, +${meta.hookBlocks.length - 10} more` : '';
    flagParts.push(`${meta.hookBlocks.length} hook/user block(s) (${blkSteps}${moreBlk})`);
  }
  if (meta.loops.length > 0) {
    const topLoops = [...meta.loops].sort((a, b) => b.count - a.count).slice(0, 8);
    const loopStr = topLoops.map(l => `${l.signature} ×${l.count} [${stepLabel(l.startStep, l.endStep)}]`).join(', ');
    const moreLoops = meta.loops.length > 8 ? `, +${meta.loops.length - 8} more` : '';
    flagParts.push(`${meta.loops.length} loop(s) (${loopStr}${moreLoops})`);
  }
  lines.push(`- **Flags:** ${flagParts.length > 0 ? flagParts.join(' · ') : 'clean (0 errors, 0 blocks, 0 loops)'}`);

  lines.push('');
  lines.push('## Timeline');

  const tailCount = Number(opts.tail) > 0 ? Number(opts.tail) : null;
  let visibleTurns = turns;
  if (tailCount) {
    // Keep last N user+assistant pairs
    const userIndices = [];
    for (let i = 0; i < turns.length; i++) {
      if (turns[i].kind === 'user') userIndices.push(i);
    }
    if (userIndices.length > tailCount) {
      const startIdx = userIndices[userIndices.length - tailCount];
      const omittedUsers = userIndices.length - tailCount;
      lines.push(`*(... ${omittedUsers} earlier turn(s) omitted via --tail ${tailCount}; run without --tail for full spine ...)*`);
      lines.push('');
      visibleTurns = turns.slice(startIdx);
    }
  }

  for (const t of visibleTurns) {
    if (t.kind === 'compaction') {
      lines.push(`--- **[COMPACTION at step #${t.step} · ${fmtTime(t.timestamp)}]** ---`);
      lines.push('');
      continue;
    }

    if (t.kind === 'user') {
      lines.push(`### [U #${t.turnNum} · step #${t.step}${t.timestamp ? ` · ${fmtTime(t.timestamp)}` : ''}]`);
      if (format === 'compact') {
        lines.push(truncateSandwich(t.text, { headLines: 4, tailLines: 3, maxChars: 500, step: t.step, shortId: meta.shortId }));
      } else if (format === 'standard') {
        lines.push(truncateSandwich(t.text, { headLines: 14, tailLines: 8, maxChars: 1600, step: t.step, shortId: meta.shortId }));
      } else {
        lines.push(t.text);
      }
      lines.push('');
      continue;
    }

    if (t.kind === 'assistant') {
      const askRuns = t.toolRuns.filter(r => Boolean(r.ask));
      if (format === 'compact' && askRuns.length === 0 && t.texts.length === 0) {
        continue;
      }

      const durSuffix = t.durationMs >= 1000 ? ` (${fmtDuration(t.durationMs)})` : '';
      lines.push(
        `### [A #${t.turnNum} · steps ${stepLabel(t.startStep, t.endStep)}${t.timestamp ? ` · ${fmtTime(t.timestamp)}${durSuffix}` : ''}]`
      );

      // 1. Thinking blocks (only in 'full' format)
      if (format === 'full' && Array.isArray(t.thinkings) && t.thinkings.length > 0) {
        for (const th of t.thinkings) {
          lines.push(`**[thinking #${th.step}]:**`);
          lines.push(`> ${th.thinking.replace(/\r?\n/g, '\n> ')}`);
          lines.push('');
        }
      }

      // 2. Tool runs (full tool spine in 'standard'/'extended'/'full'; 'compact' shows only Ask
      //    question & response, placed among the messages in step 4)
      if (format !== 'compact') {
        const runs = t.toolRuns;
        const appendRunWithOptionalOutput = (run) => {
          lines.push(formatToolRunLine(run));
          if ((format === 'extended' || format === 'full') && !run.ask) {
            const boundedOut = run.excerpt ?? renderOutputExcerpt(run.output, run.startStep, meta.shortId);
            if (boundedOut) {
              lines.push('  ```text');
              for (const ol of boundedOut.split(/\r?\n/)) {
                lines.push(`  ${ol}`);
              }
              lines.push('  ```');
            }
          }
        };

        if (runs.length <= 32 || format === 'extended' || format === 'full') {
          for (const run of runs) {
            appendRunWithOptionalOutput(run);
          }
        } else {
          // Bound marathon autonomous turns (>32 tool runs) in standard format
          const headRuns = runs.slice(0, 8);
          const midRuns = runs.slice(8, runs.length - 12);
          const tailRuns = runs.slice(runs.length - 12);
          for (const run of headRuns) appendRunWithOptionalOutput(run);
          let omittedRoutine = 0;
          const midStart = midRuns[0]?.startStep;
          const midEnd = midRuns[midRuns.length - 1]?.endStep;
          for (const run of midRuns) {
            if (run.status !== 'ok' || run.ask) {
              appendRunWithOptionalOutput(run);
            } else {
              omittedRoutine++;
            }
          }
          if (omittedRoutine > 0) {
            lines.push(
              `- *(... ${omittedRoutine} routine exit-0 tool runs in steps ${stepLabel(midStart, midEnd)} omitted; run \`crunes -p run session inspect ${meta.shortId} ${midStart}..${midEnd}\` to expand ...)*`
            );
          }
          for (const run of tailRuns) appendRunWithOptionalOutput(run);
        }

        // 3. Subagent returns (hidden in 'compact'; 1-line summary in 'standard'; full text in 'extended'/'full')
        for (const sub of t.subagentReplies) {
          if (format === 'standard') {
            lines.push(`- \`[#${sub.step} · SUBAGENT ${sub.sender}]\` ${sub.summary}`);
          } else {
            lines.push(`- \`[#${sub.step} · SUBAGENT ${sub.sender}]:\``);
            for (const sl of (sub.text || sub.summary).split(/\r?\n/)) {
              lines.push(`  > ${sl}`);
            }
          }
        }
      }

      // 4. Assistant messages (sandwich-truncated in 'compact' & 'standard', full in 'extended' & 'full')
      const texts = t.texts;
      const renderAiText = (txt) => {
        if (format === 'compact') {
          // Wide enough that the middle of a plan or offer survives: the reply that follows it
          // ("ok do") only means something next to what it answered.
          return truncateSandwich(txt.text, { headLines: 12, tailLines: 12, maxChars: 4000, step: txt.step, shortId: meta.shortId });
        }
        if (format === 'standard') {
          return truncateSandwich(txt.text, { headLines: 10, tailLines: 8, maxChars: 1400, step: txt.step, shortId: meta.shortId });
        }
        return txt.text;
      };

      if (format === 'compact') {
        // On multi-message marathon turns keep the first and final AI messages; questions sit at
        // their own step between them, so an answer reads after the message that led to it.
        const shown = texts.length > 2 ? [texts[0], texts[texts.length - 1]] : texts;
        const items = [
          ...shown.map(txt => ({ step: txt.step, txt })),
          ...askRuns.map(run => ({ step: run.startStep, run }))
        ].sort((a, b) => a.step - b.step);
        let omitted = texts.length - shown.length;
        for (const item of items) {
          if (item.run) {
            lines.push(formatToolRunLine(item.run));
            continue;
          }
          if (omitted > 0 && item.txt !== texts[0]) {
            lines.push(`\n*(... ${omitted} intermediate assistant message(s) omitted ...)*`);
            omitted = 0;
          }
          if (texts.length > 1) {
            lines.push(`\n**[step #${item.txt.step}]:**`);
          }
          lines.push(renderAiText(item.txt));
        }
      } else if (texts.length <= 6 || format === 'extended' || format === 'full') {
        for (const txt of texts) {
          if (texts.length > 1) {
            lines.push(`\n**[step #${txt.step}]:**`);
          }
          lines.push(renderAiText(txt));
        }
      } else {
        // Bound intermediate status chatter on marathon turns in standard mode
        lines.push(`\n**[step #${texts[0].step}]:**`);
        lines.push(renderAiText(texts[0]));
        lines.push(`\n*(... ${texts.length - 4} intermediate progress messages omitted ...)*`);
        for (const txt of texts.slice(-3)) {
          lines.push(`\n**[step #${txt.step}]:**`);
          lines.push(renderAiText(txt));
        }
      }
      lines.push('');
    }
  }

  lines.push('## Pickup Coordinates');
  if (pickup.touchedFiles.length > 0) {
    if ((format === 'compact' || format === 'standard') && pickup.touchedFiles.length > 10) {
      const recentTouched = [...pickup.touchedFiles].sort((a, b) => b.lastStep - a.lastStep).slice(0, 10);
      const extraTouched = pickup.touchedFiles.length - recentTouched.length;
      lines.push(
        `- **Touched files (${pickup.touchedFiles.length} total, latest 10):** ${recentTouched.map(f => `\`${f.file}\` (last: #${f.lastStep})`).join(', ')}, +${extraTouched} earlier`
      );
    } else {
      lines.push(
        `- **Touched files:** ${pickup.touchedFiles.map(f => `\`${f.file}\` (last: #${f.lastStep})`).join(', ')}`
      );
    }
  } else {
    lines.push('- **Touched files:** none');
  }
  if (pickup.lastCommand) {
    const c = pickup.lastCommand;
    const exitPart = typeof c.exitCode === 'number' ? ` -> exit ${c.exitCode}` : ` (${c.status})`;
    lines.push(`- **Last command [#${c.step}]:** ${c.command}${exitPart}`);
  }
  if (pickup.lastStatusLine) {
    lines.push(`- **Last status:** ${pickup.lastStatusLine}`);
  }
  if (pickup.openQuestion) {
    lines.push(`- **Open question [#${pickup.openQuestion.step}]:** ${pickup.openQuestion.question}`);
  }

  return lines.join('\n');
}

function parseStepRanges(spec) {
  const normalized = Array.isArray(spec) ? spec.join(',') : String(spec || '');
  const ranges = [];
  for (const p of normalized.split(/[\s,]+/).filter(Boolean)) {
    const m = /^#?(\d+)(?:(?:\.\.|-|:)(\d+))?$/.exec(p);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    ranges.push([Math.min(a, b), Math.max(a, b)]);
  }
  return ranges;
}

function parseStepRangeSpec(spec, maxStep) {
  const wanted = new Set();
  const normalized = Array.isArray(spec) ? spec.join(',') : String(spec || '');
  const parts = normalized.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
  for (const p of parts) {
    const clean = p.replace(/^#/, '');
    const rangeMatch = /^(\d+)(?:\.\.|-|:)(\d+)$/.exec(clean);
    if (rangeMatch) {
      const a = Number(rangeMatch[1]);
      const b = Number(rangeMatch[2]);
      const lo = Math.min(a, b);
      const hi = Math.min(maxStep, Math.max(a, b));
      for (let i = lo; i <= hi; i++) wanted.add(i);
    } else if (/^\d+$/.test(clean)) {
      wanted.add(Number(clean));
    }
  }
  return Array.from(wanted).sort((a, b) => a - b);
}

async function loadFullAntigravityEntries(fullPath, wanted) {
  if (!fullPath || !(await fs.exists(fullPath))) return null;
  const map = new Map();
  let i = -1;
  for await (const line of fs.readLinesStream(fullPath)) {
    if (!line) continue;
    i += 1;
    try {
      const o = JSON.parse(line);
      const idx = typeof o.step_index === 'number' ? o.step_index : i;
      if (wanted.has(idx)) map.set(idx, o);
    } catch (_) {}
  }
  return map;
}

function resolveInspectSteps(steps, targetIndices) {
  const targetSet = new Set(targetIndices);
  // If a requested index is an Antigravity GENERIC tool_result, automatically include its parent assistant step
  for (const s of steps) {
    if (s.kind === 'assistant' && Array.isArray(s.tools)) {
      for (const tc of s.tools) {
        if (targetSet.has(tc.resultStep)) {
          targetSet.add(s.index);
        }
      }
    }
  }
  // Filter out standalone tool_result steps whose parent assistant step is already in targetSet (since assistant step prints the tool output)
  const coveredResultSteps = new Set();
  for (const s of steps) {
    if (s.kind === 'assistant' && targetSet.has(s.index) && Array.isArray(s.tools)) {
      for (const tc of s.tools) {
        if (tc.resultStep !== s.index) coveredResultSteps.add(tc.resultStep);
      }
    }
  }
  return steps.filter(s => targetSet.has(s.index) && !coveredResultSteps.has(s.index));
}

async function formatInspectMarkdown(parsed, stepSpec, opts = {}) {
  const { meta, steps, sessionSummary } = parsed;
  const format = normalizeFormat(opts.format, 'extended');
  const maxStep = steps.reduce((m, s) => Math.max(m, s.index), 0);
  const specLabel = Array.isArray(stepSpec) ? stepSpec.join(', ') : String(stepSpec);
  const targetIndices = parseStepRangeSpec(stepSpec, maxStep);
  if (targetIndices.length === 0) {
    throw new Error(`invalid step specification "${specLabel}" (expected e.g. 14, 14..18, or 14 22)`);
  }

  const foundSteps = resolveInspectSteps(steps, targetIndices);

  // If Antigravity and any requested step (or its paired result step) is truncated, load transcript_full.jsonl
  let fullAgyMap = null;
  if (meta.harness === 'agy' && sessionSummary.fullPath) {
    const needsFull = foundSteps.some(
      s => s.truncated || (Array.isArray(s.tools) && s.tools.some(tc => tc.truncated))
    );
    if (needsFull) {
      fullAgyMap = await loadFullAntigravityEntries(
        sessionSummary.fullPath,
        new Set(foundSteps.flatMap(s => [s.index, ...s.tools.map(tc => tc.resultStep)]))
      );
    }
  }

  const lines = [
    `# Inspect Session ${meta.shortId} (${meta.harness} · ${meta.project} · steps ${specLabel} · format: ${format})`,
    ''
  ];

  if (foundSteps.length === 0) {
    lines.push(`*(No steps matching ${specLabel}; session has steps 0..${maxStep})*`);
    return lines.join('\n');
  }

  for (const s of foundSteps) {
    const fullEntry = fullAgyMap ? fullAgyMap.get(s.index) : null;
    lines.push(`## Step #${s.index} [${s.kind.toUpperCase()}]${s.timestamp ? ` · ${s.timestamp}` : ''}`);

    const thinkingText = (fullEntry && fullEntry.thinking) ? fullEntry.thinking.trim() : s.thinking;
    if (thinkingText && format === 'full') {
      lines.push('### Thinking');
      lines.push(thinkingText);
      lines.push('');
    }

    const bodyText = (fullEntry && fullEntry.content && s.kind !== 'user') ? fullEntry.content : s.text;
    if (bodyText) {
      lines.push('### Content');
      if (format === 'compact') {
        lines.push(truncateSandwich(bodyText, { headLines: 6, tailLines: 6, maxChars: 700, step: s.index, shortId: meta.shortId }));
      } else {
        lines.push(bodyText);
      }
      lines.push('');
    }

    if (Array.isArray(s.tools) && s.tools.length > 0) {
      const visibleTools = format === 'compact' ? s.tools.filter(tc => Boolean(tc.ask)) : s.tools;
      if (visibleTools.length > 0) {
        lines.push('### Tool Calls');
        for (const tc of visibleTools) {
          if (format === 'compact' && tc.ask) {
            lines.push(`- **Ask (\`${tc.rawName}\`):** ${tc.ask.question}`);
            if (tc.ask.answer) lines.push(`  - \`-> [Answered]\` ${tc.ask.answer}`);
            lines.push('');
            continue;
          }

          const statusBadge = tc.status === 'ok' ? 'OK' : tc.status.toUpperCase();
          const exitBadge = typeof tc.exitCode === 'number' ? ` (exit ${tc.exitCode})` : '';
          lines.push(`#### \`${tc.rawName}\` [${statusBadge}${exitBadge}]`);
          lines.push('```json');
          lines.push(JSON.stringify(tc.args, null, 2));
          lines.push('```');

          if (format === 'extended' || format === 'full') {
            let toolOut = tc.output || '';
            if (fullAgyMap && tc.resultStep !== tc.step) {
              const fullRes = fullAgyMap.get(tc.resultStep);
              if (fullRes && fullRes.content) toolOut = fullRes.content;
            }
            if (toolOut) {
              lines.push('**Output:**');
              lines.push('```text');
              lines.push(toolOut.trim());
              lines.push('```');
            }
          }
          lines.push('');
        }
      }
    }
  }

  return lines.join('\n');
}

function formatStatMarkdown(parsed) {
  const { meta, turns } = parsed;
  const lines = [];
  const branchInfo = meta.branch ? ` (${meta.branch})` : '';
  const durStr = fmtDuration(meta.durationMs);
  lines.push(
    `# Stat ${meta.shortId} (${meta.harness} · ${meta.project}${branchInfo} · ${fmtSpan(meta.startedAt, meta.endedAt)} · ${durStr} · ${fmtTok(meta.usage)})`
  );
  lines.push(
    `- **Tokens:** \`${fmtTok(meta.usage)}\` (in ${fmtCompactNum(meta.usage.input)}, cacheWrite ${fmtCompactNum(meta.usage.cacheCreate)}, cacheRead ${fmtCompactNum(meta.usage.cacheRead)}, out ${fmtCompactNum(meta.usage.output)})`
  );

  const modelEntries = Object.entries(meta.modelUsage || {}).sort((a, b) => b[1].total - a[1].total);
  if (modelEntries.length > 0) {
    const mStr = modelEntries
      .map(([m, u]) => {
        const pct = meta.usage.total > 0 ? Math.round((u.total / meta.usage.total) * 100) : 0;
        return `\`${m}\` (${u.turns} turns, ${pct}%, ${fmtTok(u)})`;
      })
      .join(', ');
    lines.push(`- **Models:** ${mStr}`);
  }

  const compStr = meta.compactions.length > 0
    ? `${meta.compactions.length} (${meta.compactions.map(c => `#${c.step}`).join(', ')})`
    : '0';
  lines.push(`- **Compactions / Thinking:** ${compStr} compactions · ${meta.thinkingTurns || 0} thinking turns`);

  const toolEntries = Object.entries(meta.toolCounts || {}).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (toolEntries.length > 0) {
    lines.push(`- **Top tools:** ${toolEntries.map(([name, cnt]) => `\`${name}\` (${cnt})`).join(', ')}`);
  }

  const hotTurns = turns
    .filter(t => t.kind === 'assistant' && t.usage && t.usage.total > 0)
    .sort((a, b) => b.usage.total - a.usage.total)
    .slice(0, 5);

  if (hotTurns.length > 0) {
    lines.push('');
    lines.push('## Hot turns');
    for (const t of hotTurns) {
      const dur = t.durationMs >= 1000 ? ` · ${fmtDuration(t.durationMs)}` : '';
      const stepsStr = stepLabel(t.startStep, t.endStep);
      const inspectRange = t.startStep === t.endStep ? `${t.startStep}` : `${t.startStep}..${t.endStep}`;
      lines.push(
        `- \`#${t.turnNum}\` [steps ${stepsStr}${dur}] \`${fmtTok(t.usage)}\` → \`crunes -p run session inspect ${meta.shortId} ${inspectRange}\``
      );
    }
  }

  return lines.join('\n');
}


function compileSearchMatcher(query) {
  const q = String(query || '').trim();
  if (!q) throw new Error('search query is required');
  const reMatch = /^\/(.+)\/([gimsuy]*)$/.exec(q);
  if (reMatch) {
    const flags = reMatch[2].replace(/g/g, '');
    const re = new RegExp(reMatch[1], flags || 'i');
    return text => re.test(text);
  }
  const needle = q.toLowerCase();
  return text => text.toLowerCase().includes(needle);
}

async function searchSessions(query, opts = {}) {
  const matches = compileSearchMatcher(query);
  const keep = keepForSearch(matches);
  const limit = Number(opts.limit) > 0 ? Number(opts.limit) : 20;
  const sessions = await listSessions({
    ...opts,
    query: null,
    limit: 50,
  });

  const hits = [];
  for (const s of sessions) {
    if (hits.length >= limit) break;
    let parsed;
    try {
      let mayMatch = false;
      for await (const line of readLines(s.path)) {
        if (matches(line)) {
          mayMatch = true;
          break;
        }
      }
      if (!mayMatch) continue;
      parsed = await parseSession(s, { ...opts, keep });
    } catch (err) {
      if (opts.onSkip) opts.onSkip(s, err);
      continue;
    }

    for (const t of parsed.turns) {
      if (hits.length >= limit) break;
      if (t.kind === 'user' && t.text && matches(t.text)) {
        hits.push({
          id: parsed.meta.id,
          shortId: parsed.meta.shortId,
          harness: parsed.meta.harness,
          project: parsed.meta.project,
          turnNum: t.turnNum,
          step: t.step,
          kind: 'user',
          snippet: oneLine(t.text, 120),
        });
      } else if (t.kind === 'assistant') {
        for (const txt of t.texts || []) {
          if (hits.length >= limit) break;
          if (txt.text && matches(txt.text)) {
            hits.push({
              id: parsed.meta.id,
              shortId: parsed.meta.shortId,
              harness: parsed.meta.harness,
              project: parsed.meta.project,
              turnNum: t.turnNum,
              step: txt.step,
              kind: 'assistant',
              snippet: oneLine(txt.text, 120),
            });
          }
        }
        for (const tc of t.tools || []) {
          if (hits.length >= limit) break;
          if (tc.matched ?? matches(toolHaystack(tc))) {
            hits.push({
              id: parsed.meta.id,
              shortId: parsed.meta.shortId,
              harness: parsed.meta.harness,
              project: parsed.meta.project,
              turnNum: t.turnNum,
              step: tc.step,
              kind: `tool:${tc.name}`,
              snippet: oneLine(`${tc.name}(${tc.target || ''})`, 120),
            });
          }
        }
      }
    }
  }
  return hits;
}

export {
  listSessions,
  searchSessions,
  resolveSession,
  parseSession,
  keepForDigest,
  keepForInspect,
  formatDigestMarkdown,
  formatInspectMarkdown,
  formatStatMarkdown,
  cleanUserText,
  parseStepRangeSpec,
  normalizeFormat,
  truncateSandwich,
  fmtTok,
  fmtDuration
}
