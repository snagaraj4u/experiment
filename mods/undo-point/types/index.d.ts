export type Snapshot = {
  id: string
  createdAt: number
  reason: string
  paths: string[]
  created: string[]
  gitStash?: string
}

declare module 'claude-code' {
  interface PluginState {
    'undo-point': { snapshots: Shaped<Snapshot[]>; command: string }
  }
}
