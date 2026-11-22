import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Dual-harness session reader for Claude Code (~/.claude/projects/<project>/<id>.jsonl)
 * and Antigravity (~/.gemini/antigravity/brain/<id>/.system_generated/logs/transcript.jsonl).
 *
 * Converts raw JSONL transcripts (85-95% tool-result payloads and telemetry envelopes)
 * into three progressive lenses:
 *   1. list    — fast head/tail discovery across harnesses by workspace or query
 *   2. digest  — compact FDR/CVR Markdown spine with 1-line tool target signatures,
 *                loop/error/hook-block flags, and cold-pickup tail coordinates
 *   3. inspect — full un-truncated step drill-down (with transcript_full.jsonl fallback)
 */

const HEAD_READ_BYTES = 32768;
const TAIL_READ_BYTES = 32768;

function defaultDirs(opts = {}) {
  const home = opts.homeDir || os.homedir();
  return {
    claudeDir: opts.claudeDir || path.join(home, '.claude', 'projects'),
    agyDir: opts.agyDir || path.join(home, '.gemini', 'antigravity', 'brain')
  };
}

function readHeadAndTailLines(filePath, size) {
  const fd = fs.openSync(filePath, 'r');
  try {
    if (size <= HEAD_READ_BYTES + TAIL_READ_BYTES) {
      const buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, 0);
      const lines = buf.toString('utf8').split('\n').map(l => l.trim()).filter(Boolean);
      return { headLines: lines, tailLines: lines, allRead: true };
    }
    const headBuf = Buffer.alloc(HEAD_READ_BYTES);
    fs.readSync(fd, headBuf, 0, HEAD_READ_BYTES, 0);
    const tailBuf = Buffer.alloc(TAIL_READ_BYTES);
    fs.readSync(fd, tailBuf, 0, TAIL_READ_BYTES, size - TAIL_READ_BYTES);

    const headRaw = headBuf.toString('utf8').split('\n');
    headRaw.pop(); // drop potentially partial last line of head chunk
    const tailRaw = tailBuf.toString('utf8').split('\n');
    tailRaw.shift(); // drop potentially partial first line of tail chunk

    return {
      headLines: headRaw.map(l => l.trim()).filter(Boolean),
      tailLines: tailRaw.map(l => l.trim()).filter(Boolean),
      allRead: false
    };
  } finally {
    fs.closeSync(fd);
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
    ? `; run \`rig session inspect ${shortId} ${step}\` for full step`
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
  if (lower === 'bash' || lower === 'run_command') {
    let cmd = args.command || args.CommandLine || '';
    // Strip outer Git Bash wrapper if present for cleaner display
    const bashWrap = /^&\s*"[^"]*bash\.exe"\s*-l?c\s*(['"])([\s\S]*)\1$/.exec(cmd.trim());
    if (bashWrap) cmd = bashWrap[2];
    return { name: 'bash', rawName, target: `"${oneLine(cmd, 72)}"`, command: cmd, args };
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
  if (lower === 'askuserquestion' || lower === 'ask_question') {
    const qList = Array.isArray(args.questions) ? args.questions : [];
    const q0 = qList[0] || {};
    const qText = q0.question || args.question || '';
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
  if (lower === 'agent' || lower === 'invoke_subagent') {
    const role = args.Role || args.description || args.subagent_type || args.TypeName || 'subagent';
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

function summarizeClaudeFile(filePath, stat) {
  const rawBase = path.basename(filePath, '.jsonl');
  const inSubagentsDir = path.basename(path.dirname(filePath)) === 'subagents';
  let id = inSubagentsDir ? rawBase.replace(/^agent-/, '') : rawBase;
  const { headLines, tailLines } = readHeadAndTailLines(filePath, stat.size);

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
      if (fs.existsSync(metaPath)) {
        const metaObj = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
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

  for (const l of headLines) inspectLine(l);
  for (const l of tailLines) inspectLine(l);

  const projDirPath = inSubagentsDir ? path.dirname(path.dirname(path.dirname(filePath))) : path.dirname(filePath);
  const project = cwd ? path.basename(cwd) : path.basename(projDirPath).split('-').pop();
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
    startedAt: startedAt || stat.birthtime.toISOString(),
    endedAt: endedAt || stat.mtime.toISOString(),
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    path: filePath
  };
}

function summarizeAgyFile(filePath, stat) {
  const logsDir = path.dirname(filePath);
  const sysGenDir = path.dirname(logsDir);
  const brainFolder = path.dirname(sysGenDir);
  const id = path.basename(brainFolder);
  const fullPath = path.join(logsDir, 'transcript_full.jsonl');

  const { headLines, tailLines } = readHeadAndTailLines(filePath, stat.size);

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

  for (const l of headLines) inspectLine(l);
  for (const l of tailLines) inspectLine(l);

  const isSubagent = Boolean(step0Sender && !hasUserInput);

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
    startedAt: startedAt || stat.birthtime.toISOString(),
    endedAt: endedAt || stat.mtime.toISOString(),
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    path: filePath,
    fullPath: fs.existsSync(fullPath) ? fullPath : null
  };
}

function discoverSessionStubs(opts = {}) {
  const { claudeDir, agyDir } = defaultDirs(opts);
  const wantHarness = opts.harness ? opts.harness.toLowerCase() : null;
  const includeSubagents = Boolean(opts.includeSubagents || opts.subagents);
  const stubs = [];

  if ((!wantHarness || wantHarness === 'claude') && fs.existsSync(claudeDir)) {
    try {
      for (const projDir of fs.readdirSync(claudeDir)) {
        const fullProjDir = path.join(claudeDir, projDir);
        let dirStat;
        try {
          dirStat = fs.statSync(fullProjDir);
        } catch (_) {
          continue;
        }
        if (!dirStat.isDirectory()) continue;

        for (const f of fs.readdirSync(fullProjDir)) {
          const fullFile = path.join(fullProjDir, f);
          try {
            const st = fs.statSync(fullFile);
            if (st.isFile() && f.endsWith('.jsonl') && st.size > 0) {
              const id = path.basename(fullFile, '.jsonl');
              stubs.push({ id, harness: 'claude', path: fullFile, stat: st, mtimeMs: st.mtimeMs });
            } else if (includeSubagents && st.isDirectory()) {
              const saDir = path.join(fullFile, 'subagents');
              if (fs.existsSync(saDir)) {
                for (const sf of fs.readdirSync(saDir)) {
                  if (!sf.endsWith('.jsonl')) continue;
                  const saFile = path.join(saDir, sf);
                  try {
                    const saSt = fs.statSync(saFile);
                    if (saSt.isFile() && saSt.size > 0) {
                      const rawId = path.basename(saFile, '.jsonl').replace(/^agent-/, '');
                      stubs.push({ id: rawId, rawId: path.basename(saFile, '.jsonl'), harness: 'claude', isSubagent: true, path: saFile, stat: saSt, mtimeMs: saSt.mtimeMs });
                    }
                  } catch (_) {}
                }
              }
            }
          } catch (_) {}
        }
      }
    } catch (_) {}
  }

  if ((!wantHarness || wantHarness === 'agy' || wantHarness === 'antigravity') && fs.existsSync(agyDir)) {
    try {
      for (const convId of fs.readdirSync(agyDir)) {
        const tFile = path.join(agyDir, convId, '.system_generated', 'logs', 'transcript.jsonl');
        try {
          if (!fs.existsSync(tFile)) continue;
          const st = fs.statSync(tFile);
          if (st.isFile() && st.size > 0) {
            stubs.push({ id: convId, harness: 'agy', path: tFile, stat: st, mtimeMs: st.mtimeMs });
          }
        } catch (_) {}
      }
    } catch (_) {}
  }

  stubs.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return stubs;
}

function hydrateStub(stub) {
  return stub.harness === 'claude'
    ? summarizeClaudeFile(stub.path, stub.stat)
    : summarizeAgyFile(stub.path, stub.stat);
}

function listSessions(opts = {}) {
  const stubs = discoverSessionStubs(opts);
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

  // Lazy hydration: only read file headers in mtime order until limit is reached
  const results = [];
  const hydratedCache = [];
  const activeProjNeedle = explicitProject || cwdBase;

  for (const stub of stubs) {
    const s = hydrateStub(stub);
    hydratedCache.push(s);
    if (matchesFilter(s, activeProjNeedle)) {
      results.push(s);
      if (results.length >= limit) return results;
    }
  }

  // Fallback: if implicit cwd project filter matched nothing, return top recent non-subagent sessions
  if (results.length === 0 && cwdBase && !explicitProject && !query) {
    return hydratedCache.filter(s => includeSubagents || !s.isSubagent).slice(0, limit);
  }

  return results;
}

function resolveSession(idOrLatest, opts = {}) {
  if (idOrLatest && fs.existsSync(idOrLatest) && fs.statSync(idOrLatest).isFile()) {
    const st = fs.statSync(idOrLatest);
    const firstLine = fs.readFileSync(idOrLatest, 'utf8').split('\n')[0] || '{}';
    let parsed = {};
    try {
      parsed = JSON.parse(firstLine);
    } catch (_) {}
    if (typeof parsed.step_index === 'number' || parsed.source === 'USER_EXPLICIT' || parsed.type === 'PLANNER_RESPONSE' || parsed.type === 'SYSTEM_MESSAGE') {
      return summarizeAgyFile(idOrLatest, st);
    }
    return summarizeClaudeFile(idOrLatest, st);
  }

  if (!idOrLatest || idOrLatest === 'latest') {
    const scoped = listSessions({ ...opts, limit: 1 });
    if (scoped[0]) return scoped[0];
    const topStubs = discoverSessionStubs(opts);
    return topStubs[0] ? hydrateStub(topStubs[0]) : null;
  }

  const stubs = discoverSessionStubs({ ...opts, includeSubagents: true });
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
    const s = hydrateStub(st);
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
  if (agyExit) {
    tc.exitCode = Number(agyExit[1]);
  } else if (claudeExit) {
    tc.exitCode = Number(claudeExit[1]);
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

function parseAntigravityTranscript(sessionSummary) {
  const rawLines = fs.readFileSync(sessionSummary.path, 'utf8').trim().split('\n').filter(Boolean);
  const entries = [];
  for (const l of rawLines) {
    try {
      entries.push(JSON.parse(l));
    } catch (_) {}
  }

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
    stepCount: entries.length,
    models: sessionSummary.model ? [sessionSummary.model] : [],
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

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
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
      steps.push({
        index: stepIdx,
        kind: 'ephemeral',
        timestamp: ts,
        text: e.content || '',
        tools: [],
        truncated: Array.isArray(e.truncated_fields) && e.truncated_fields.length > 0
      });
      continue;
    }

    if (e.type === 'USER_INPUT') {
      const mMatch = /changed setting `Model Selection` from [^\r\n]+? to ([^\r\n.]+)/.exec(e.content || '');
      if (mMatch && !seenModels.has(mMatch[1].trim())) {
        seenModels.add(mMatch[1].trim());
        meta.models.push(mMatch[1].trim());
      }
      steps.push({
        index: stepIdx,
        kind: 'user',
        timestamp: ts,
        text: cleanUserText(e.content || ''),
        rawContent: e.content || '',
        tools: [],
        truncated: Array.isArray(e.truncated_fields) && e.truncated_fields.length > 0
      });
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

      for (let k = 0; k < rawCalls.length; k++) {
        const rc = rawCalls[k];
        const tName = rc.name || rc.tool_name || 'tool';
        const tArgs = rc.args || rc.parameters || {};
        const norm = normalizeToolCall(tName, tArgs, meta.cwd);
        const resultEntry = entries[i + 1 + k];
        const resultStepIdx = resultEntry && resultEntry.type === 'GENERIC'
          ? (typeof resultEntry.step_index === 'number' ? resultEntry.step_index : i + 1 + k)
          : stepIdx;

        norm.step = stepIdx;
        norm.resultStep = resultStepIdx;
        norm.truncated = Boolean(
          (Array.isArray(e.truncated_fields) && e.truncated_fields.length > 0) ||
          (resultEntry && Array.isArray(resultEntry.truncated_fields) && resultEntry.truncated_fields.length > 0)
        );

        if (resultEntry && resultEntry.type === 'GENERIC') {
          applyResultToToolCall(norm, resultEntry.content || '', resultEntry.status === 'ERROR');
        } else {
          norm.status = e.status === 'ERROR' ? 'error' : 'ok';
          norm.output = '';
        }

        const skillName = detectSkillLoad(tName, norm.args);
        if (skillName && !seenSkills.has(skillName)) {
          seenSkills.add(skillName);
          meta.skills.push({ name: skillName, step: stepIdx });
        }

        if (norm.mutation && norm.status === 'ok') {
          meta.mutations.push({ file: norm.target, fullPath: norm.file, op: norm.mutation, step: stepIdx });
        }
        if (norm.status === 'error') {
          meta.errors.push({ step: stepIdx, resultStep: resultStepIdx, tool: norm.name, target: norm.target, summary: norm.errorSummary });
        } else if (norm.status === 'blocked') {
          meta.hookBlocks.push({ step: stepIdx, resultStep: resultStepIdx, tool: norm.name, target: norm.target, reason: norm.errorSummary });
        }

        tools.push(norm);
      }

      steps.push({
        index: stepIdx,
        kind: 'assistant',
        timestamp: ts,
        text: (e.content || '').trim(),
        thinking: (e.thinking || '').trim(),
        tools,
        truncated: Array.isArray(e.truncated_fields) && e.truncated_fields.length > 0
      });
      continue;
    }

    if (e.type === 'GENERIC') {
      steps.push({
        index: stepIdx,
        kind: 'tool_result',
        timestamp: ts,
        status: e.status,
        text: e.content || '',
        tools: [],
        truncated: Array.isArray(e.truncated_fields) && e.truncated_fields.length > 0
      });
    }
  }

  return finalizeParsedSession(meta, steps, sessionSummary);
}

function parseClaudeTranscript(sessionSummary) {
  const rawLines = fs.readFileSync(sessionSummary.path, 'utf8').trim().split('\n').filter(Boolean);
  const entries = [];
  for (const l of rawLines) {
    try {
      entries.push(JSON.parse(l));
    } catch (_) {}
  }

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
    models: sessionSummary.model ? [sessionSummary.model] : [],
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

  // First pass: collect tool_result blocks by tool_use_id
  const toolResultsById = new Map();
  for (const e of entries) {
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
          toolResultsById.set(b.tool_use_id, {
            content: textOut,
            isError: Boolean(b.is_error),
            agentId: rowAgentId
          });
        }
      }
    }
  }

  const steps = [];
  let stepCounter = 0;

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

  for (const e of entries) {
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
          steps.push({
            index: idx,
            kind: 'compaction',
            timestamp: ts,
            text: rawPart,
            tools: [],
            truncated: false
          });
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
          steps.push({
            index: stepCounter++,
            kind: 'user',
            timestamp: ts,
            text: cleaned,
            rawContent: rawPart,
            tools: [],
            truncated: false
          });
        }
      }
      continue;
    }

    if (e.type === 'assistant' && e.message && Array.isArray(e.message.content)) {
      let text = '';
      let thinking = '';
      const tools = [];
      const currentIdx = stepCounter;

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

          const tr = b.id ? toolResultsById.get(b.id) : null;
          if (tr) {
            applyResultToToolCall(norm, tr.content, tr.isError);
          } else {
            norm.status = 'ok';
            norm.output = '';
          }

          const skillName = detectSkillLoad(b.name, norm.args);
          if (skillName && !seenSkills.has(skillName)) {
            seenSkills.add(skillName);
            meta.skills.push({ name: skillName, step: currentIdx });
          }

          if (norm.mutation && norm.status === 'ok') {
            meta.mutations.push({ file: norm.target, fullPath: norm.file, op: norm.mutation, step: currentIdx });
          }
          if (norm.status === 'error') {
            meta.errors.push({ step: currentIdx, tool: norm.name, target: norm.target, summary: norm.errorSummary });
          } else if (norm.status === 'blocked') {
            meta.hookBlocks.push({ step: currentIdx, tool: norm.name, target: norm.target, reason: norm.errorSummary });
          }

          tools.push(norm);
        }
      }

      if (text || thinking || tools.length > 0) {
        // Merge consecutive single-block assistant lines that belong to the same logical step if previous step is assistant with no text and only thinking
        const prev = steps[steps.length - 1];
        if (prev && prev.kind === 'assistant' && !prev.text && prev.tools.length === 0 && !thinking && (text || tools.length > 0)) {
          prev.text = text;
          for (const tc of tools) {
            tc.step = prev.index;
            tc.resultStep = prev.index;
            prev.tools.push(tc);
          }
        } else {
          steps.push({
            index: stepCounter++,
            kind: 'assistant',
            timestamp: ts,
            text,
            thinking,
            tools,
            truncated: false
          });
        }
      }
    }
  }

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
          tools: [],
          subagentReplies: [],
          thinkings: [],
          texts: []
        };
      }
      currentAssistant.endStep = s.index;
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
          tools: [],
          subagentReplies: [],
          thinkings: [],
          texts: []
        };
      }
      currentAssistant.endStep = s.index;
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

function parseSession(sessionOrId, opts = {}) {
  const summary = typeof sessionOrId === 'object' && sessionOrId !== null && sessionOrId.path
    ? sessionOrId
    : resolveSession(sessionOrId, opts);

  if (!summary) {
    throw new Error(`session not found: ${sessionOrId || 'latest'}`);
  }

  if (summary.harness === 'agy') {
    return parseAntigravityTranscript(summary);
  }
  return parseClaudeTranscript(summary);
}

function fmtTime(iso) {
  if (!iso) return '';
  const m = /T(\d{2}:\d{2})/.exec(iso);
  return m ? m[1] : iso.slice(0, 16);
}

function fmtSpan(startIso, endIso) {
  if (!startIso) return '';
  const datePart = startIso.slice(0, 10);
  const sTime = fmtTime(startIso);
  const eTime = fmtTime(endIso);
  return sTime && eTime && sTime !== eTime ? `${datePart} ${sTime}..${eTime}` : `${datePart} ${sTime}`;
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

      lines.push(
        `### [A #${t.turnNum} · steps ${stepLabel(t.startStep, t.endStep)}${t.timestamp ? ` · ${fmtTime(t.timestamp)}` : ''}]`
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
          if ((format === 'extended' || format === 'full') && run.output && !run.ask) {
            const cleanOut = run.output
              .replace(/^Created At:[^\r\n]*\r?\n/gm, '')
              .replace(/^Completed At:[^\r\n]*\r?\n/gm, '')
              .trim();
            if (cleanOut) {
              const boundedOut = truncateSandwich(cleanOut, {
                headLines: 10,
                tailLines: 8,
                maxChars: 1200,
                step: run.startStep,
                shortId: meta.shortId
              });
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
              `- *(... ${omittedRoutine} routine exit-0 tool runs in steps ${stepLabel(midStart, midEnd)} omitted; run \`rig session inspect ${meta.shortId} ${midStart}..${midEnd}\` to expand ...)*`
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

function loadFullAntigravityEntries(fullPath) {
  if (!fullPath || !fs.existsSync(fullPath)) return null;
  const map = new Map();
  const lines = fs.readFileSync(fullPath, 'utf8').trim().split('\n').filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    try {
      const o = JSON.parse(lines[i]);
      const idx = typeof o.step_index === 'number' ? o.step_index : i;
      map.set(idx, o);
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

function formatInspectMarkdown(parsed, stepSpec, opts = {}) {
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
      fullAgyMap = loadFullAntigravityEntries(sessionSummary.fullPath);
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

export {
  listSessions,
  resolveSession,
  parseSession,
  formatDigestMarkdown,
  formatInspectMarkdown,
  cleanUserText,
  parseStepRangeSpec,
  normalizeFormat,
  truncateSandwich
}
