import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Refinement } from '../types'

type $T = EngineInterface

const NAME = 'prompt-refiner'
const MODELS = ['haiku', 'sonnet', 'opus'] as const
const DEFAULT_MODEL = 'haiku'
const MIN_WORDS = 8 // shorter prompts ("yes", "do it") pass through untouched
const SKIP_PREFIX = 'raw:' // start a prompt with raw: to send it as typed
const ORIGINS = ['composer', 'bridge', 'sdk'] // prompts a person typed

const SYSTEM = `You turn a developer's request to an AI coding agent into a clear, well-specified prompt.

Rules:
- Keep every requirement, name, file path, number, command and constraint exactly as given.
- Do not invent requirements, pick technologies, or answer or carry out the request.
- Make implicit goals explicit only where the request clearly implies them.
- Where something is genuinely ambiguous, list it under "Open questions" instead of guessing.
- If the request is already clear, return it almost unchanged.

Output only the rewritten prompt, in this shape (omit empty sections):
Goal: <one sentence>
Requirements:
- ...
Constraints:
- ...
Done when:
- ...
Open questions:
- ...`

const last = atom({ plugin: 'prompt-refiner', key: 'last' } as const, null)
const count = atom({ plugin: 'prompt-refiner', key: 'count' } as const, 0)

// ------------------------------------------------ shared on/off switch
// mod-hub writes ~/.claude/mod-switches.json; every mod reads it.

let homeDir: string | undefined
let cached: { at: number; switches: Record<string, boolean> } | undefined

const switchesPath = async ($: $T) => {
  if (homeDir === undefined) {
    const ran = await $.process.run(['printenv', 'HOME'])
    homeDir = ran.stdout.trim()
  }
  return `${homeDir}/.claude/mod-switches.json`
}

const readSwitches = async ($: $T): Promise<Record<string, boolean>> => {
  if (cached && Date.now() - cached.at < 2000) return cached.switches
  const text = await $.fs.read(await switchesPath($)).catch(() => '{}')
  let switches: Record<string, boolean> = {}
  try {
    switches = JSON.parse(typeof text === 'string' ? text : '{}') as Record<string, boolean>
  } catch {
    switches = {}
  }
  cached = { at: Date.now(), switches }
  return switches
}

const isOn = async ($: $T) => (await readSwitches($))[NAME] !== false

const setOn = async ($: $T, on: boolean) => {
  const switches = { ...(await readSwitches($)), [NAME]: on }
  await $.fs.write(await switchesPath($), JSON.stringify(switches, null, 2))
  cached = { at: Date.now(), switches }
  await showStatus($)
}

// ------------------------------------------------------------ settings

const getModel = async ($: $T) => {
  const m = await $.store.get('model')
  return typeof m === 'string' && m !== '' ? m : DEFAULT_MODEL
}

const getMode = async ($: $T): Promise<'context' | 'replace'> =>
  (await $.store.get('mode')) === 'replace' ? 'replace' : 'context'

const showStatus = async ($: $T) => {
  const on = await isOn($)
  $.ui.status(on ? `✎ refine: ${await getModel($)}` : '✎ refine: off')
}

const short = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`)

// --------------------------------------------------------------- hooks

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'refine',
      description: 'Prompt refiner: on | off | status | show | model <haiku|sonnet|opus> | mode <context|replace>',
      argumentHint: '[on|off|status|show|model|mode]',
      immediate: true,
    })
    await showStatus($).catch(() => undefined)
    return started
  })

  on('prompt.submit', async ($, e, next) => {
    // Commands, hidden prompts, prompts no person typed: untouched.
    if (e.command || e.isMeta || !ORIGINS.includes(e.origin.kind)) return next(e)

    const text = e.text.trim()
    if (text.toLowerCase().startsWith(SKIP_PREFIX)) {
      return next({ ...e, text: text.slice(SKIP_PREFIX.length).trimStart() })
    }
    if (text.split(/\s+/).length < MIN_WORDS) return next(e)
    if (!(await isOn($))) return next(e)

    const model = await getModel($)
    const reply = await $.model.complete(
      { model, system: SYSTEM, prompt: text, maxTokens: 1500, timeoutMs: 20_000 },
    )
    // An optimisation, not a guard: on any failure the prompt goes as typed.
    if (!reply.isAnswered || !reply.text.trim()) {
      $.ui.toast(`Prompt refiner skipped (${reply.isAnswered ? 'empty reply' : reply.reason}); sent as typed`)
      return next(e)
    }

    const refined = reply.text.trim()
    const record: Refinement = {
      original: text,
      refined,
      model,
      at: Date.now(),
      inputTokens: reply.usage.input_tokens,
      outputTokens: reply.usage.output_tokens,
    }
    await update($, last, () => record)
    await update($, count, n => n + 1)
    $.ui.toast(`Prompt refined by ${model} (${short(record.inputTokens + record.outputTokens)} tokens)`)

    if ((await getMode($)) === 'replace') {
      return next({ ...e, text: `${refined}\n\n(Original request, verbatim: ${text})` })
    }
    const brief =
      `A cheaper model (${model}) restated the user's request above as a structured brief. ` +
      `Use it to plan, but the user's own words win wherever the two differ, ` +
      `and raise any "Open questions" with the user only if they block the work.\n\n` +
      `<refined_prompt>\n${refined}\n</refined_prompt>`
    return next({ ...e, context: [...(e.context ?? []), brief] })
  }).catch(($, e, next) => next(e)) // never lose a prompt over the refiner

  on('command.run', { command: 'refine' }, async ($, e) => {
    const [verb = 'status', arg = ''] = e.args.trim().split(/\s+/)
    switch (verb) {
      case 'on':
        await setOn($, true)
        return { text: `Prompt refiner on (model: ${await getModel($)}).` }
      case 'off':
        await setOn($, false)
        return { text: 'Prompt refiner off: prompts go to the main model as typed.' }
      case 'model': {
        const m = arg.toLowerCase()
        if (!(MODELS as readonly string[]).includes(m) && !m.startsWith('claude-')) {
          return { text: `Pick one of: ${MODELS.join(', ')} (or a full claude-… model id).` }
        }
        await $.store.set('model', m)
        await showStatus($)
        return { text: `Refining with ${m}.${m === 'opus' ? ' Note: opus costs the most; haiku is the cheap choice.' : ''}` }
      }
      case 'mode': {
        if (arg !== 'context' && arg !== 'replace') {
          return { text: 'mode context: keep your words, add the brief beside them (default). mode replace: send the brief instead, your words appended.' }
        }
        await $.store.set('mode', arg)
        return { text: `Mode: ${arg}.` }
      }
      case 'show': {
        const r = await read($, last)
        if (!r) return { text: 'Nothing refined yet this session.' }
        return {
          text: `Last refinement (${r.model}, ${short(r.inputTokens)} in / ${short(r.outputTokens)} out):\n\n${r.refined}`,
        }
      }
      default: {
        const n = await read($, count)
        return {
          text:
            `Prompt refiner is ${(await isOn($)) ? 'on' : 'off'}; model ${await getModel($)}, mode ${await getMode($)}; ` +
            `${n} prompt${n === 1 ? '' : 's'} refined this session. Prompts under ${MIN_WORDS} words, slash commands ` +
            `and prompts starting with "${SKIP_PREFIX}" are sent as typed.`,
        }
      }
    }
  })
}
