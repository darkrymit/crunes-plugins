import { shell, section } from '@utils'

export async function run() {
  const res = await shell.exec('node --test test/outline.test.js', { throw: false })
  if (res.exitCode !== 0) {
    throw new Error(`outline tests failed (exit ${res.exitCode}):\n${res.stderr || res.stdout}`)
  }
  return [
    section.create('outline:check', {
      type: 'markdown',
      content: res.stdout.trim(),
    }),
  ]
}
