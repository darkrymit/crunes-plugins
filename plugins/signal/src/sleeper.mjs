// Background sleeper for the signal plugin: `node sleeper.mjs <token> <ms>`.
//
// Waits, then fires the signal that still holds <token> in the registry. A cancelled or
// re-armed signal no longer holds it, so a stale sleeper exits without firing. Runs as a
// plain Node process (outside the rune isolate), so it reads the registry itself.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseRegistry, takeDue } from './signal.js'

const [token, ms] = process.argv.slice(2)
const registryPath = path.join(os.homedir(), '.signal', 'signals.json')

setTimeout(() => {
  if (!fs.existsSync(registryPath)) return
  const reg = parseRegistry(fs.readFileSync(registryPath, 'utf8'))
  const name = Object.keys(reg.signals).find(n => reg.signals[n].token === token)
  const sig = name && takeDue(reg, { name, token })
  if (!sig) return
  fs.writeFileSync(registryPath, JSON.stringify(reg, null, 2))
  // Shortcut: the command runs as plain argv, no shell features (pipes, &&); upgrade: store a shell flag per signal.
  const child = spawn(sig.cmd[0], sig.cmd.slice(1), { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
}, Number(ms))
