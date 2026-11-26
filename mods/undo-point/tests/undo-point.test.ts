import { expect, test } from 'claude-code/testing'

const startSession = async ($: any, on: any, builtins: string[]) => {
  const registered: string[] = []
  on('command.list', () => ({
    value: builtins.map(name => ({ name, description: '', source: 'builtin' })),
  }))
  on('command.register', (_: unknown, e: { name: string }) => {
    registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  return registered
}

test('uses /restore when it is free', async ($, on) => {
  const registered = await startSession($, on, ['help', 'rewind'])
  expect(registered).toEqual(['restore'])
})

test('picks /undo-restore when /restore is already a built-in', async ($, on) => {
  const registered = await startSession($, on, ['help', 'restore'])
  expect(registered).toEqual(['undo-restore'])
})

test('blocks a delete whose files cannot be known up front', async ($, on) => {
  on('session.cwd', () => ({ value: '/work' }))
  on('tool.call', () => ({ result: {} }))
  const ran = await $.tool.call({ tool: 'Bash', command: 'find . -name "*.log" | xargs rm' })
  expect(ran.deny).toMatch(/undo-point: blocked/)
})

test('fails closed: an Edit is blocked when the snapshot cannot be saved', async ($, on) => {
  on('session.cwd', () => ({ value: '/work' }))
  on('fs.exists', () => ({ value: true }))
  on('process.run', () => {
    throw new Error('disk full')
  })
  on('tool.call', () => ({ result: {} }))
  const ran = await $.tool.call({
    tool: 'Edit',
    file_path: '/work/a.txt',
    old_string: 'a',
    new_string: 'b',
  })
  expect(ran.deny).toMatch(/undo-point: blocked/)
})

test('a harmless command runs untouched', async ($, on) => {
  on('session.cwd', () => ({ value: '/work' }))
  on('tool.call', () => ({ result: {} }))
  const ran = await $.tool.call({ tool: 'Bash', command: 'ls -la && git status' })
  expect(ran.deny).toBeUndefined()
})
