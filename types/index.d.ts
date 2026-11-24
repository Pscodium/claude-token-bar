export type CacheInfo = { at: number; ttlMs: number; hitPct: number }
export type ToolStat = { calls: number; tokens: number }
export type BigOutput = { tool: string; label: string; tokens: number }
export type Stats = { byTool: Record<string, ToolStat>; biggest: BigOutput[] }
export type ToolOut = { title: string; text: string; ok: boolean }

declare module 'claude-code' {
  interface PluginState {
    'token-bar': { cache: CacheInfo | null; tick: number; busy: boolean; stats: Stats; toolOut: ToolOut | null }
  }
}
