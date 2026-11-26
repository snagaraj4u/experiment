export type Refinement = {
  original: string
  refined: string
  model: string
  at: number
  inputTokens: number
  outputTokens: number
}

declare module 'claude-code' {
  interface PluginState {
    'prompt-refiner': { last: Refinement | null; count: number }
  }
}
