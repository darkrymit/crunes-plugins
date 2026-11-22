import { shell, section } from '@utils'

export async function run() {
  const res = await shell.exec('node --test test/qdev.test.js', { throw: false })
  if (res.exitCode !== 0) {
    throw new Error(`qdev tests failed (exit ${res.exitCode}):\n${res.stderr || res.stdout}`)
  }
  return [
    section.create('qdev:check', {
      type: 'markdown',
      content: res.stdout.trim(),
    }),
  ]
}
