import { section, shell, fs } from '@utils'

export async function args(b) {
  return b
    .positional('[path]', 'Optional path to a specific git repository. If provided, auto-discovery is skipped.')
    .build()
}

export async function use(args) {
  const targetPath = args._[0]

  let gitDirs = []
  if (targetPath) {
    // Targeted scanning
    gitDirs = [targetPath]
  } else {
    // Auto-discovery
    const matches = await fs.glob('**/.git', { onlyDirectories: true, dot: true })
    gitDirs = matches.map(m => {
      // Remove trailing slash if present
      const safeM = m.replace(/[/\\]$/, '')
      if (safeM === '.git') return '.'
      return safeM.replace(/[/\\]\.git$/, '')
    })
    if (gitDirs.length === 0) {
      gitDirs = ['.'] // Fallback if we are in a bare repo or .git is at root but not matched
    }
  }

  // Deduplicate and filter paths (basic)
  gitDirs = [...new Set(gitDirs)]

  const sections = []

  for (const dir of gitDirs) {
    const safeDir = dir.replace(/[/\\]$/, '')
    try {
      // Test if it's actually a git repo
      await shell.exec(`git -C "${safeDir}" rev-parse --abbrev-ref HEAD`, { throw: true })
    } catch (e) {
      if (targetPath) {
        sections.push(section.create('error', { type: 'markdown', content: `Not a git repository: ${safeDir}` }))
      }
      continue
    }

    const branch = await shell.exec(`git -C "${safeDir}" rev-parse --abbrev-ref HEAD`, { throw: false })

    let upstream = ''
    try {
      const ahead = await shell.exec(`git -C "${safeDir}" rev-list --count HEAD @{u}`, { throw: true })
      const behind = await shell.exec(`git -C "${safeDir}" rev-list --count @{u} HEAD`, { throw: true })
      upstream = ` (↑${ahead} ahead, ↓${behind} behind)`
    } catch {
      // No upstream set, omit ahead/behind
    }

    const status = await shell.exec(`git -C "${safeDir}" status --porcelain`, { throw: false })
    const lines = status.split('\n').filter(Boolean)
    const staged = lines.filter(l => l[0] !== ' ' && l[0] !== '?')
    const unstaged = lines.filter(l => l[1] !== ' ' && l[1] !== '?')
    const untracked = lines.filter(l => l.startsWith('??'))

    const log = await shell.exec(`git -C "${safeDir}" log --oneline -10`, { throw: false })

    const stashStr = await shell.exec(`git -C "${safeDir}" stash list`, { throw: false })
    const stashCount = stashStr ? stashStr.split('\n').filter(Boolean).length : 0

    const absPath = await fs.resolve(safeDir)
    const parts = absPath.split(/[/\\]/)
    const repoName = parts[parts.length - 1]

    const content = `Branch: ${branch}${upstream}

Staged (${staged.length}): ${staged.map(s => s.slice(3)).join(', ')}
Unstaged (${unstaged.length}): ${unstaged.map(s => s.slice(3)).join(', ')}
Untracked (${untracked.length})

Recent commits:
${log.split('\n').map(l => '  ' + l).join('\n')}

Stashes: ${stashCount}
`
    sections.push(section.create(`status:${repoName}`, { type: 'markdown', path: absPath, content }))
  }

  if (sections.length === 0) {
    if (!targetPath) {
      return [section.create('error', { type: 'markdown', content: 'No git repositories found in this workspace.' })]
    }
  }

  return sections
}
