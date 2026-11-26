import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Snapshot } from '../types'

type $T = EngineInterface

// ---------------------------------------------------------------- settings

const PANE = 'undo-points'
const MAX_KEEP = 50 // oldest undo points beyond this are pruned
const MAX_KB = 1024 * 1024 // refuse (and so block) snapshots over 1 GiB
const TURN_FILE_LIMIT = 5 // a turn touching more files than this gets an undo point
const PREFERRED_COMMAND = 'restore'
const FALLBACK_COMMAND = 'undo-restore'

// ------------------------------------------------------------------- state

const snapshots = atom({ plugin: 'undo-point', key: 'snapshots' } as const, [], {
  shape: 'snapshots-1',
})
const commandName = atom({ plugin: 'undo-point', key: 'command' } as const, PREFERRED_COMMAND)

// Per-turn bookkeeping (a reload starts it over, which only means the next
// risky action opens a fresh undo point).
let turnSnap: Snapshot | undefined
let turnSaved = new Set<string>()
let turnCreated = new Set<string>()
let turnTouched = new Set<string>()
let homeDir: string | undefined

const resetTurn = () => {
  turnSnap = undefined
  turnSaved = new Set()
  turnCreated = new Set()
  turnTouched = new Set()
}

// Snapshot work runs one at a time, so parallel tool calls can't interleave.
let chain: Promise<unknown> = Promise.resolve()
const locked = <T,>(fn: () => Promise<T>): Promise<T> => {
  const run = chain.then(fn)
  chain = run.catch(() => undefined)
  return run
}

// ----------------------------------------------------------------- helpers

const sh = async ($: $T, script: string, args: string[] = [], cwd?: string) => {
  const ran = await $.process.run(['sh', '-c', script, 'sh', ...args], {
    cwd,
    timeoutMs: 120_000,
  })
  if (ran.exitCode !== 0) {
    throw new Error(ran.stderr.trim().split('\n').slice(-1)[0] || `exit ${ran.exitCode}`)
  }
  return ran.stdout
}

const lines = (text: string) => text.split('\n').filter(l => l !== '')

const home = async ($: $T) => {
  homeDir ??= (await sh($, 'printf %s "$HOME"')).trim()
  if (!homeDir) throw new Error('$HOME is not set')
  return homeDir
}

const rootDir = async ($: $T) => `${await home($)}/.undo-snapshots`

const absolute = async ($: $T, cwd: string, path: string) => {
  const p = path.startsWith('~/') ? `${await home($)}${path.slice(1)}` : path
  return p.startsWith('/') ? normalize(p) : normalize(`${cwd}/${p}`)
}

const normalize = (path: string) => {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return `/${out.join('/')}`
}

const basename = (path: string) => path.replace(/\/+$/, '').split('/').pop() ?? path

const exists = ($: $T, path: string) => $.fs.exists(path).catch(() => false)

const isDir = async ($: $T, path: string) =>
  (await $.fs.stat(path).catch(() => undefined))?.kind === 'dir'

// Expands a glob pattern safely (no command substitution) against cwd.
const expandGlob = async ($: $T, cwd: string, pattern: string) =>
  lines(
    await sh(
      $,
      'cd "$1" || exit 1; for f in $2; do if [ -e "$f" ] || [ -L "$f" ]; then printf "%s\\n" "$f"; fi; done',
      [cwd, pattern],
    ),
  )

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')

const when = (ms: number) => new Date(ms).toISOString().slice(5, 16).replace('T', ' ')

// --------------------------------------------------------- snapshot store

const loadSnapshots = async ($: $T): Promise<Snapshot[]> => {
  const root = await rootDir($)
  if (!(await exists($, root))) return []
  const entries = await $.fs.list(root)
  const found: Snapshot[] = []
  for (const entry of entries) {
    if (entry.kind !== 'dir') continue
    const text = await $.fs.read(`${root}/${entry.name}/manifest.json`).catch(() => undefined)
    if (typeof text !== 'string') continue
    try {
      found.push(JSON.parse(text) as Snapshot)
    } catch {
      // a half-written manifest is skipped
    }
  }
  return found.sort((a, b) => b.createdAt - a.createdAt)
}

const refresh = async ($: $T) => {
  const list = await loadSnapshots($)
  await update($, snapshots, () => list)
  $.ui.status(`↺ ${list.length} undo point${list.length === 1 ? '' : 's'}`)
  return list
}

const writeManifest = async ($: $T, snap: Snapshot) => {
  await $.fs.write(`${await rootDir($)}/${snap.id}/manifest.json`, JSON.stringify(snap, null, 2))
}

const prune = async ($: $T, list: Snapshot[]) => {
  const root = await rootDir($)
  const old = list.slice(MAX_KEEP).filter(s => /^[0-9TZ-]+$/.test(s.id))
  if (old.length === 0) return
  await sh($, 'r="$1"; shift; for id; do rm -rf -- "$r/$id"; done', [root, ...old.map(s => s.id)])
}

// Copies each existing absolute path to <dir>/files/<path>, keeping modes.
const copyInto = async ($: $T, dir: string, paths: string[]) => {
  if (paths.length === 0) return
  await sh(
    $,
    'set -e; d="$1/files"; shift; for p; do if [ -e "$p" ] || [ -L "$p" ]; then ' +
      'parent=$(dirname -- "$p"); mkdir -p -- "$d$parent"; cp -a -- "$p" "$d$parent/"; fi; done',
    [dir, ...paths],
  )
}

const sizeKb = async ($: $T, paths: string[]) => {
  if (paths.length === 0) return 0
  const out = await sh($, 'du -skc -- "$@" 2>/dev/null | tail -n 1', paths).catch(() => '0')
  return Number.parseInt(out, 10) || 0
}

type SaveOptions = {
  reason: string
  paths: string[] // absolute
  created?: string[] // absolute paths the action will create (deleted on restore)
  gitRepo?: string // a repo whose working-tree changes to record with `git stash create`
  fresh?: boolean // a snapshot of its own, outside the turn's
}

// Saves an undo point. Throws when it can't: the caller then blocks the action.
const save = ($: $T, opts: SaveOptions) =>
  locked(async () => {
    const root = await rootDir($)
    const want = [...new Set(opts.paths)].filter(
      p => opts.fresh || (!turnSaved.has(p) && !turnCreated.has(p)),
    )
    const present: string[] = []
    for (const p of want) if (await exists($, p)) present.push(p)
    for (const p of opts.created ?? []) if (!opts.fresh) turnCreated.add(p)

    const kb = await sizeKb($, present)
    if (kb > MAX_KB) {
      throw new Error(
        `the files come to ${(kb / 1024).toFixed(0)} MB, over the ${MAX_KB / 1024} MB limit for an undo point`,
      )
    }

    let snap = opts.fresh ? undefined : turnSnap
    const isNew = snap === undefined
    if (snap === undefined) {
      snap = { id: stamp(), createdAt: Date.now(), reason: opts.reason, paths: [], created: [] }
    }
    if (isNew && present.length === 0 && (opts.created ?? []).length === 0 && !opts.gitRepo) {
      return false // nothing on disk to protect
    }

    const dir = `${root}/${snap.id}`
    await copyInto($, dir, present)

    if (opts.gitRepo && snap.gitStash === undefined) {
      const sha = (await sh($, 'git stash create', [], opts.gitRepo)).trim()
      if (sha) {
        await sh($, 'git update-ref "refs/undo-point/$1" "$2"', [snap.id, sha], opts.gitRepo)
        snap.gitStash = `${opts.gitRepo} ${sha}`
      }
    }

    snap.paths = [...new Set([...snap.paths, ...present])]
    snap.created = opts.fresh ? [...(opts.created ?? [])] : [...turnCreated]
    if (!isNew && !snap.reason.includes(opts.reason)) {
      snap.reason = `${snap.reason}; ${opts.reason}`.slice(0, 300)
    }
    await writeManifest($, snap)

    if (!opts.fresh) {
      turnSnap = snap
      for (const p of present) turnSaved.add(p)
    }
    const list = await refresh($)
    await prune($, list).then(() => refresh($)).catch(() => undefined)
    if (present.length > 0 || isNew) $.ui.toast('Undo point saved')
    return true
  })

// Keeps the turn's undo point in step with files Write creates.
const noteCreated = ($: $T, path: string) =>
  locked(async () => {
    turnCreated.add(path)
    if (turnSnap) {
      turnSnap.created = [...turnCreated]
      await writeManifest($, turnSnap)
    }
  })

const restore = async ($: $T, snap: Snapshot) => {
  const root = await rootDir($)
  const dir = `${root}/${snap.id}`
  // Restoring is itself risky: save what is there now first.
  await save($, {
    reason: `before restoring ${snap.id}`,
    paths: [...snap.paths, ...snap.created],
    fresh: true,
  })
  await sh(
    $,
    'set -e; d="$1"; shift; for p; do rm -rf -- "$p"; done; ' +
      'if [ -d "$d/files" ]; then cp -a -- "$d/files/." /; fi',
    [dir, ...snap.created.filter(p => p !== '/' && p.length > 1)],
  )
  await refresh($)
  $.ui.toast(`Restored undo point from ${when(snap.createdAt)}`)
}

// ------------------------------------------------- reading a shell command

type BashPlan = { paths: string[]; created: string[]; gitRepos: string[]; reasons: string[] }

class Unplannable extends Error {}

const tokenize = (segment: string) => {
  const out: string[] = []
  for (const m of segment.matchAll(/"((?:\\.|[^"])*)"|'([^']*)'|(\S+)/g)) {
    out.push(m[1] ?? m[2] ?? m[3] ?? '')
  }
  return out
}

const isDynamic = (arg: string) => /[$`]/.test(arg)
const isGlob = (arg: string) => /[*?[]/.test(arg)

const operands = (args: string[], valued: string[] = []) => {
  const out: string[] = []
  let rest = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? ''
    if (rest) out.push(a)
    else if (a === '--') rest = true
    else if (valued.includes(a)) i++
    else if (!a.startsWith('-') || a === '-') out.push(a)
  }
  return out
}

const planBash = async ($: $T, command: string, startCwd: string): Promise<BashPlan> => {
  const plan: BashPlan = { paths: [], created: [], gitRepos: [], reasons: [] }
  let cwd = startCwd

  const target = async (arg: string): Promise<string[]> => {
    if (isDynamic(arg)) throw new Unplannable(`can't tell which files "${arg}" names`)
    if (isGlob(arg)) {
      return Promise.all((await expandGlob($, cwd, arg)).map(f => absolute($, cwd, f)))
    }
    return [await absolute($, cwd, arg)]
  }

  for (const raw of command.split(/&&|\|\||;|\n|\|/)) {
    let words = tokenize(raw.trim())
    while (words[0] !== undefined && /^(sudo|command|nohup|time|\w+=.*)$/.test(words[0])) {
      words = words.slice(1)
    }
    const [cmd, ...args] = words
    if (cmd === undefined) continue

    // Truncating redirects: `> file` overwrites an existing file.
    for (let i = 0; i < words.length; i++) {
      const w = words[i] ?? ''
      const m = /^(?:1)?>(?![>&])(.*)$/.exec(w)
      if (!m) continue
      const file = m[1] || words[i + 1]
      if (!file || file.startsWith('/dev/') || file.startsWith('&')) continue
      for (const p of await target(file)) {
        if (await exists($, p)) plan.paths.push(p)
      }
      plan.reasons.push(`overwrite ${basename(file)}`)
    }

    if (cmd === 'cd') {
      const to = args[0]
      if (to && !isDynamic(to)) cwd = await absolute($, cwd, to)
      continue
    }

    if (cmd === 'xargs' && args.some(a => /^(rm|mv|unlink|shred)$/.test(a))) {
      throw new Unplannable('files piped to xargs are not known until it runs')
    }
    if (cmd === 'find' && args.some(a => a === '-delete' || /^(rm|mv)$/.test(a))) {
      throw new Unplannable('files that find deletes are not known until it runs')
    }

    if (['rm', 'rmdir', 'unlink', 'shred', 'truncate'].includes(cmd)) {
      for (const a of operands(args, ['-s', '--size', '-n', '--iterations'])) {
        plan.paths.push(...(await target(a)))
      }
      plan.reasons.push(`${cmd} ${operands(args).slice(0, 3).join(' ')}`)
      continue
    }

    if (cmd === 'mv') {
      const ops = operands(args, ['-t', '-S', '--suffix'])
      const tIndex = args.indexOf('-t')
      const dest = tIndex >= 0 ? args[tIndex + 1] : ops.pop()
      if (!dest) continue
      const destAbs = (await target(dest))[0] ?? ''
      const destIsDir = await isDir($, destAbs)
      for (const src of ops) {
        for (const s of await target(src)) {
          plan.paths.push(s)
          const lands = destIsDir ? `${destAbs}/${basename(s)}` : destAbs
          if (await exists($, lands)) plan.paths.push(lands)
          else plan.created.push(lands)
        }
      }
      plan.reasons.push(`mv ${ops.slice(0, 2).join(' ')} → ${dest}`)
      continue
    }

    if (cmd === 'git') {
      let i = 0
      let gitCwd = cwd
      while (args[i]?.startsWith('-')) {
        if (args[i] === '-C' && args[i + 1]) {
          gitCwd = await absolute($, cwd, args[i + 1] ?? '')
          i += 2
        } else i++
      }
      const sub = args[i]
      const rest = args.slice(i + 1)
      const flags = rest.filter(a => a.startsWith('-')).join(' ')

      if (sub === 'clean' && !/(^|\s)(-\w*n|--dry-run)/.test(flags)) {
        const short = rest.filter(a => /^-[^-]/.test(a)).join('')
        const dry = ['-n']
        if (short.includes('d')) dry.push('-d')
        if (short.includes('x')) dry.push('-x')
        if (short.includes('X')) dry.push('-X')
        const pathspec = operands(rest, ['-e', '--exclude'])
        const out = await sh($, 'git clean "$@"', [...dry, '--', ...pathspec], gitCwd)
        for (const l of lines(out)) {
          const m = /^Would remove (.*)$/.exec(l)
          if (m?.[1]) plan.paths.push(await absolute($, gitCwd, m[1]))
        }
        plan.reasons.push('git clean')
        continue
      }

      const isHardReset = sub === 'reset' && rest.includes('--hard')
      const isCheckoutFiles = sub === 'checkout' && (rest.includes('--') || rest.includes('.'))
      const isRestore = sub === 'restore' && !(rest.includes('--staged') && !rest.includes('--worktree'))
      if (isHardReset || isCheckoutFiles || isRestore) {
        const top = (await sh($, 'git rev-parse --show-toplevel', [], gitCwd)).trim()
        const changed = lines(await sh($, 'git diff --name-only HEAD', [], top))
        for (const f of changed) plan.paths.push(`${top}/${f}`)
        plan.gitRepos.push(top)
        plan.reasons.push(`git ${sub}${isHardReset ? ' --hard' : ''}`)
      }
    }
  }
  return plan
}

// ------------------------------------------------------------------ hooks

const blocked = (why: unknown) => ({
  deny:
    `undo-point: blocked because an undo point could not be saved first — ` +
    `${why instanceof Error ? why.message : String(why)}. ` +
    `Fix that (or name the files explicitly) and try again.`,
})

// Edit / Write / NotebookEdit: save an existing file before it is overwritten,
// and save the turn's work once it touches more than TURN_FILE_LIMIT files.
const onFileChange = async ($: $T, rawPath: string, tool: string) => {
  const cwd = await $.session.cwd()
  const path = await absolute($, cwd, rawPath)
  turnTouched.add(path)
  const isBigTurn = turnTouched.size > TURN_FILE_LIMIT
  if (await exists($, path)) {
    await save($, { reason: isBigTurn ? `turn edits ${turnTouched.size} files` : `${tool} ${basename(path)}`, paths: [path] })
  } else if (isBigTurn) {
    await save($, { reason: `turn edits ${turnTouched.size} files`, paths: [], created: [path] })
  } else {
    await noteCreated($, path)
  }
}


export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const taken = (await $.command.list()).some(
      c => c.name === PREFERRED_COMMAND && c.plugin !== $.plugin.name,
    )
    const name = taken ? FALLBACK_COMMAND : PREFERRED_COMMAND
    await update($, commandName, () => name)
    await $.command.register({
      name,
      description: 'List recent undo points and restore one with a click',
      argumentHint: '[number]',
    })
    await refresh($).catch(() => $.ui.status('↺ undo points unavailable'))
    return started
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) resetTurn()
    return next(e)
  })

  on('command.run', async ($, e, next) => {
    const name = await read($, commandName)
    if (e.command !== name) return next(e)

    const list = await refresh($)
    const pick = Number.parseInt(e.args.trim(), 10)
    if (Number.isInteger(pick)) {
      const snap = list[pick - 1]
      if (!snap) return { text: `No undo point #${pick}. There are ${list.length}.` }
      try {
        await restore($, snap)
        return { text: `Restored undo point #${pick} (${when(snap.createdAt)}: ${snap.reason}).` }
      } catch (err) {
        return { text: `Restore failed: ${err instanceof Error ? err.message : String(err)}` }
      }
    }

    await $.ui.open({ id: PANE, title: 'Undo points' })
    if (list.length === 0) return { text: 'No undo points yet.' }
    const rows = list
      .slice(0, 10)
      .map((s, i) => `${i + 1}. ${when(s.createdAt)}  ${s.reason}  (${s.paths.length} files)`)
    return {
      text: `Undo points (newest first) — press Restore in the pane, or run /${name} <number>:\n${rows.join('\n')}`,
    }
  })

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    try {
      await onFileChange($, e.file_path, 'Edit')
    } catch (err) {
      return blocked(err)
    }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : blocked('its guard failed unexpectedly')))

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    try {
      await onFileChange($, e.file_path, 'Write')
    } catch (err) {
      return blocked(err)
    }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : blocked('its guard failed unexpectedly')))

  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) => {
    try {
      await onFileChange($, e.notebook_path, 'NotebookEdit')
    } catch (err) {
      return blocked(err)
    }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : blocked('its guard failed unexpectedly')))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    try {
      const plan = await planBash($, e.command, await $.session.cwd())
      const isRisky = plan.reasons.length > 0
      if (isRisky) {
        await save($, {
          reason: plan.reasons.join(', ').slice(0, 200),
          paths: plan.paths,
          created: plan.created,
          gitRepo: plan.gitRepos[0],
        })
      }
    } catch (err) {
      return blocked(err)
    }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : blocked('its guard failed unexpectedly')))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, snapshots)
    const room = Math.max(1, Math.floor(((e.viewport?.rows ?? 24) - 3) / 2))

    return (
      <Box flexDirection="column">
        {list.length === 0 && <Text dimColor>No undo points yet.</Text>}
        {list.slice(0, room).map((snap, i) => (
          <Box key={snap.id} flexDirection="row" gap={1}>
            <Button
              key={`restore-${snap.id}`}
              label="Restore"
              variant={i === 0 ? 'primary' : 'secondary'}
              onPress={() => {
                void restore($, snap).catch(err =>
                  $.ui.toast(`Restore failed: ${err instanceof Error ? err.message : String(err)}`),
                )
              }}
            />
            <Text>
              {i + 1}. {when(snap.createdAt)} <Text dimColor>{snap.reason} · {snap.paths.length} files</Text>
            </Text>
          </Box>
        ))}
      </Box>
    )
  })
}
