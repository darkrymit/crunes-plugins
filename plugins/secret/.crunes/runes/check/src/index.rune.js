import { shell, section } from '@utils'

export async function run() {
  const res = await shell.exec('node --test test/secret.test.js', { throw: false })
  if (res.exitCode !== 0) {
    throw new Error(`secret tests failed (exit ${res.exitCode}):\n${res.stderr || res.stdout}`)
  }
  return [
    section.create('secret:check', {
      type: 'markdown',
      content: res.stdout.trim(),
    }),
  ]
}
