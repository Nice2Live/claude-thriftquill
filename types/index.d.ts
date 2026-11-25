export type SnapRow = { file: string; project: string; name: string; at: string }

export type TqTab = 'snaps' | 'report'

// What the Thriftquill pane draws: the snapshots with their buttons, and the janitor's and the tools' reports.
export type TqPane = {
  tab: TqTab
  snaps: SnapRow[]
  loadedAt?: number
  preview?: { file: string; text: string }
  // The snapshot that goes with the next message.
  restoreOwed?: string
  busy?: string
  report?: { title: string; text: string; at: number }
}

declare module 'claude-code' {
  interface PluginState {
    thriftquill: { pane: Shaped<TqPane> }
  }
}
