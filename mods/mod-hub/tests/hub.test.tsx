import { expect, mock, test } from 'claude-code/testing'

const fakeDisk = (on: any, files: Record<string, string>) => {
  mock.store(on)
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '/home/me\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.read', (_: unknown, e: { path: string }) => {
    const hit = Object.keys(files).find(k => e.path === k || e.path.endsWith(k))
    return { value: hit === undefined ? '{}' : files[hit] }
  })
  on('fs.write', (_: unknown, e: { path: string; text: string }) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('fs.list', () => ({
    value: [
      { name: 'mod-hub', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
      { name: 'undo-point', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
    ],
  }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
}

const manifests = (root: string) => ({
  [`${root}/mod-hub/.claude-plugin/plugin.json`]: JSON.stringify({ name: 'mod-hub', description: 'hub' }),
  [`${root}/undo-point/.claude-plugin/plugin.json`]: JSON.stringify({ name: 'undo-point', description: 'snapshots' }),
})

test('/mods lists the mods and /mods off switches one off', async ($, on) => {
  const files: Record<string, string> = manifests('')
  fakeDisk(on, files)

  const listed = await $.command.run({ command: 'mods', args: '' })
  expect(listed.text).toMatch(/undo-point/)

  const off = await $.command.run({ command: 'mods', args: 'off undo-point' })
  expect(off.text).toMatch(/switched off/)
  expect(JSON.parse(files['/home/me/.claude/mod-switches.json'] ?? '{}')).toEqual({ 'undo-point': false })

  const unknown = await $.command.run({ command: 'mods', args: 'off nope' })
  expect(unknown.text).toMatch(/No mod named/)
})
