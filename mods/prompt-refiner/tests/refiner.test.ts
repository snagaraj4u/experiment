import { expect, mock, test } from 'claude-code/testing'

// Answers the engine calls the refiner makes, from memory.
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
}

test('/refine off writes the shared switch, /refine on restores it', async ($, on) => {
  const files: Record<string, string> = {}
  fakeDisk(on, files)
  const off = await $.command.run({ command: 'refine', args: 'off' })
  expect(off.text).toMatch(/off/)
  expect(JSON.parse(files['/home/me/.claude/mod-switches.json'] ?? '{}')).toEqual({ 'prompt-refiner': false })

  const back = await $.command.run({ command: 'refine', args: 'on' })
  expect(back.text).toMatch(/on/)
  expect(JSON.parse(files['/home/me/.claude/mod-switches.json'] ?? '{}')).toEqual({ 'prompt-refiner': true })
})

test('/refine model rejects an unknown model and keeps a known one', async ($, on) => {
  fakeDisk(on, {})
  const bad = await $.command.run({ command: 'refine', args: 'model gpt' })
  expect(bad.text).toMatch(/Pick one of/)
  await $.command.run({ command: 'refine', args: 'model sonnet' })
  const status = await $.command.run({ command: 'refine', args: 'status' })
  expect(status.text).toMatch(/model sonnet/)
})

test('a prompt a plugin sends is not refined (no model call)', async ($, on) => {
  fakeDisk(on, {})
  let calls = 0
  on('model.complete', () => {
    calls++
    return { value: { isAnswered: true, text: 'x', usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }
  })
  on('prompt.submit', (_: unknown, e: unknown) => e)
  await $.prompt.submit({ text: 'please refactor the auth module so the login flow is easier to test' })
  expect(calls).toBe(0)
})
