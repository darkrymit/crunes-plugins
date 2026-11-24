import { section, shell } from '@utils'

export function args(b) {
  return b.option('-h, --help', 'Show help')
}

export async function run() {
  const res = await shell.exec('node --test test/tla.test.js', { throw: false })
  if (res.exitCode !== 0) {
    throw new Error((res.stderr || res.stdout || '').trim())
  }
  return [section.create('tla:plugin-check', { type: 'markdown', content: res.stdout.trim() })]
}
