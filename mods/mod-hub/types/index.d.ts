export type ModInfo = {
  name: string
  description: string
  version?: string
  root: string
}

declare module 'claude-code' {
  interface PluginState {
    'mod-hub': {
      mods: Shaped<ModInfo[]>
      switches: Record<string, boolean>
      canReload: boolean
      isBandOpen: boolean
    }
  }
}
