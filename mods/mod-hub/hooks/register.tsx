import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ModInfo } from '../types'

type $T = EngineInterface

const NAME = 'mod-hub'
const PANE = 'mod-hub'
const RELOAD_COMMAND = 'reload-plugins'

const mods = atom({ plugin: 'mod-hub', key: 'mods' } as const, [], { shape: 'mods-1' })
const switchesAtom = atom({ plugin: 'mod-hub', key: 'switches' } as const, {})
const canReload = atom({ plugin: 'mod-hub', key: 'canReload' } as const, false)

// Plugins the engine announced while loading (those loaded after this one).
const seen = new Map<string, ModInfo>()
let homeDir: string | undefined

// ------------------------------------------------------ the switch file
// ~/.claude/mod-switches.json: { "<mod>": false } turns a mod off.
// Mods that read it (prompt-refiner, undo-point) obey at once; for any other
// mod this hub refuses to load it on the next reload or session start.

const switchesPath = async ($: $T) => {
  if (homeDir === undefined) homeDir = (await $.process.run(['printenv', 'HOME'])).stdout.trim()
  return `${homeDir}/.claude/mod-switches.json`
}

const readSwitches = async ($: $T): Promise<Record<string, boolean>> => {
  const text = await $.fs.read(await switchesPath($)).catch(() => '{}')
  try {
    const parsed: unknown = JSON.parse(typeof text === 'string' ? text : '{}')
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, boolean>) : {}
  } catch {
    return {}
  }
}

const writeSwitches = async ($: $T, switches: Record<string, boolean>) => {
  await $.fs.write(await switchesPath($), JSON.stringify(switches, null, 2))
  await update($, switchesAtom, () => switches)
  await showStatus($)
}

const setMod = async ($: $T, name: string, on: boolean) => {
  if (name === NAME) return
  await writeSwitches($, { ...(await readSwitches($)), [name]: on })
}

const setAll = async ($: $T, on: boolean) => {
  const switches = await readSwitches($)
  for (const m of await read($, mods)) if (m.name !== NAME) switches[m.name] = on
  await writeSwitches($, switches)
}

// ------------------------------------------------------------ discovery

const readManifest = async ($: $T, root: string): Promise<ModInfo | undefined> => {
  const text = await $.fs.read(`${root}/.claude-plugin/plugin.json`).catch(() => undefined)
  if (typeof text !== 'string') return undefined
  try {
    const m = JSON.parse(text) as { name?: unknown; description?: unknown; version?: unknown }
    if (typeof m.name !== 'string') return undefined
    return {
      name: m.name,
      description: typeof m.description === 'string' ? m.description : '',
      version: typeof m.version === 'string' ? m.version : undefined,
      root,
    }
  } catch {
    return undefined
  }
}

// The mods folder this hub sits in, plus every plugin the engine announced.
const discover = async ($: $T) => {
  const found = new Map<string, ModInfo>()
  const parent = $.plugin.root.replace(/\/[^/]+\/?$/, '')
  for (const entry of await $.fs.list(parent).catch(() => [])) {
    if (entry.kind !== 'dir') continue
    const info = await readManifest($, `${parent}/${entry.name}`)
    if (info) found.set(info.name, info)
  }
  for (const [name, info] of seen) if (!found.has(name)) found.set(name, info)
  const list = [...found.values()].sort((a, b) =>
    a.name === NAME ? -1 : b.name === NAME ? 1 : a.name.localeCompare(b.name),
  )
  await update($, mods, () => list)
  const switches = await readSwitches($)
  await update($, switchesAtom, () => switches)
  await showStatus($)
  return list
}

const showStatus = async ($: $T) => {
  const list = (await read($, mods)).filter(m => m.name !== NAME)
  const switches = await read($, switchesAtom)
  const onCount = list.filter(m => switches[m.name] !== false).length
  $.ui.status(`⚙ mods ${onCount}/${list.length} on`)
}

const reload = async ($: $T) => {
  if (!(await read($, canReload))) {
    $.ui.toast('Start a new session to load or unload mods that ignore the switch')
    return
  }
  await $.command.run({ command: RELOAD_COMMAND })
}

const NOTE =
  'Mods that read the switch (prompt-refiner, undo-point) change at once; ' +
  'others are loaded or refused on the next reload or session start.'

// ---------------------------------------------------------------- hooks

const runHub = async ($: $T, e: { args: string }) => {
  const list = await discover($)
  const [verb = '', target = ''] = e.args.trim().split(/\s+/)

  if ((verb === 'on' || verb === 'off') && target !== '') {
    if (!list.some(m => m.name === target)) {
      return { text: `No mod named "${target}". Mods: ${list.map(m => m.name).join(', ')}` }
    }
    if (target === NAME) return { text: 'The hub stays on; remove its folder to drop it.' }
    await setMod($, target, verb === 'on')
    return { text: `${target} switched ${verb}. ${NOTE}` }
  }
  if (verb === 'all' && (target === 'on' || target === 'off')) {
    await setAll($, target === 'on')
    return { text: `All mods switched ${target}. ${NOTE}` }
  }

  await $.ui.open({ id: PANE, title: 'Mod hub' })
  const switches = await read($, switchesAtom)
  const rows = list.map(
    m => `${m.name === NAME ? '•' : switches[m.name] === false ? '○ off' : '● on '}  ${m.name}  ${m.description}`,
  )
  return { text: `Mods (toggle in the pane, or /mods on|off <name>):\n${rows.join('\n')}` }
}

export const register: Register = on => {
  // Note every plugin as it loads, and keep out the ones switched off.
  on('plugin.register', async ($, e, next) => {
    seen.set(e.name, { name: e.name, description: '', version: e.version, root: e.root })
    const isUserMod = e.tier === 'user' && e.requiredByOrganization !== true
    if (isUserMod && e.name !== NAME) {
      const switches = await readSwitches($)
      if (switches[e.name] === false) return { refuse: `switched off in ${NAME} (/mods on ${e.name})` }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'mods',
      description: 'Open the mod hub: see your mods and switch them on or off',
      argumentHint: '[on|off <mod> | all on|off]',
      aliases: ['jarvis'],
      immediate: true,
    })
    const names = (await $.command.list()).map(c => c.name)
    await update($, canReload, () => names.includes(RELOAD_COMMAND))
    await discover($).catch(() => undefined)
    return started
  })

  on('command.run', { command: 'mods' }, ($, e) => runHub($, e))
  on('command.run', { command: 'jarvis' }, ($, e) => runHub($, e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, mods)
    const switches = await read($, switchesAtom)
    const hasReload = await read($, canReload)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1}>
          <Button key="all-on" label="All on" onPress={() => void setAll($, true)} />
          <Button key="all-off" label="All off" onPress={() => void setAll($, false)} />
          <Button key="refresh" label="Refresh" onPress={() => void discover($)} />
          {hasReload && <Button key="reload" label="Reload mods" onPress={() => void reload($)} />}
        </Box>
        {list.length === 0 && <Text dimColor>No mods found.</Text>}
        {list.map(m => {
          const isHub = m.name === NAME
          const isOn = switches[m.name] !== false
          return (
            <Box key={m.name} flexDirection="row" gap={1}>
              {isHub ? (
                <Text dimColor>[ hub ]</Text>
              ) : (
                <Button
                  key={`toggle-${m.name}`}
                  label={isOn ? 'On ' : 'Off'}
                  variant={isOn ? 'primary' : 'secondary'}
                  onPress={() => void setMod($, m.name, !isOn)}
                />
              )}
              <Text>
                {m.name}
                {m.version ? ` ${m.version}` : ''} <Text dimColor>{m.description}</Text>
              </Text>
            </Box>
          )
        })}
        <Text dimColor>{NOTE}</Text>
      </Box>
    )
  })
}
