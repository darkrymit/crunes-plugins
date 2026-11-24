import { shell, section } from '@utils'

export async function run() {
  const res = await shell.exec('node --test test/signal.test.js', { throw: false, timeout: 120000 })
  if (res.exitCode !== 0) {
    throw new Error(`signal tests failed (exit ${res.exitCode}):\n${res.stderr || res.stdout}`)
  }
  return [
    section.create('signal:check', {
      type: 'markdown',
      content: res.stdout.trim(),
    }),
  ]
}
