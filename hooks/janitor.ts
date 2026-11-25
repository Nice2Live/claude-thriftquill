import type { PluginOptions, SessionMessage } from 'claude-code'

import { clipHead } from './text'

// off: tool results are left whole. shadow: the trace says what would be cut. active: a result over the cap keeps its start and end.
export type OutputMode = 'off' | 'shadow' | 'active'

// summary: every compaction makes a summary. hybrid: when the stubs alone cut enough, the conversation is kept as it is with the stubs in it.
export type CompactionStyle = 'summary' | 'hybrid'

// session: the engine compacts with the session's model. compare: it still does, and the small model writes its own summary
// of the same conversation on the side, for cost and coverage. small: the small model writes the summary (the engine only
// where it gives no answer).
export type CompactionModel = 'session' | 'compare' | 'small'

export type Mode = 'shadow' | 'active'

export type JanitorOptions = {
  mode: Mode
  thresholdTokens: number
  keepRecentMessages: number
  stubMinChars: number
  isHandoff: boolean
  idleMode: Mode
  idleMinutes: number
  idleMinTokens: number
  ownTriggers: boolean
  outputMode: OutputMode
  outputCapChars: number
  compactionStyle: CompactionStyle
  maskMinCut: number
  handoffRewrite: boolean
  anchors: string
  snapshotOnCompact: boolean
  snapshotMemory: boolean
  compactionModel: CompactionModel
}

export const DEFAULTS: JanitorOptions = {
  mode: 'shadow',
  thresholdTokens: 300000,
  keepRecentMessages: 12,
  stubMinChars: 2000,
  isHandoff: true,
  idleMode: 'shadow',
  idleMinutes: 50,
  idleMinTokens: 150000,
  ownTriggers: false,
  outputMode: 'shadow',
  outputCapChars: 30000,
  compactionStyle: 'summary',
  maskMinCut: 40,
  handoffRewrite: true,
  anchors: '',
  snapshotOnCompact: true,
  snapshotMemory: true,
  compactionModel: 'session',
}

const num = (v: unknown, fallback: number, min: number, max: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback

// Plugin options are whatever settings hold: a value of the wrong kind or outside its range falls back to the default.
export const readOptions = (o: PluginOptions): JanitorOptions => ({
  mode: o.mode === 'active' ? 'active' : 'shadow',
  thresholdTokens: num(o.threshold_tokens, DEFAULTS.thresholdTokens, 100000, 900000),
  keepRecentMessages: num(o.keep_recent_messages, DEFAULTS.keepRecentMessages, 4, 60),
  stubMinChars: num(o.stub_min_chars, DEFAULTS.stubMinChars, 500, 20000),
  isHandoff: o.handoff !== false,
  idleMode: o.idle_mode === 'active' ? 'active' : 'shadow',
  idleMinutes: num(o.idle_minutes, DEFAULTS.idleMinutes, 20, 58),
  idleMinTokens: num(o.idle_min_tokens, DEFAULTS.idleMinTokens, 50000, 900000),
  ownTriggers: o.own_triggers === true,
  outputMode: o.output_mode === 'off' ? 'off' : o.output_mode === 'active' ? 'active' : 'shadow',
  outputCapChars: num(o.output_cap_chars, 30000, 5000, 200000),
  compactionStyle: o.compaction_style === 'hybrid' ? 'hybrid' : 'summary',
  maskMinCut: num(o.mask_min_cut, 40, 20, 80),
  handoffRewrite: o.handoff_rewrite !== false,
  anchors: typeof o.anchors === 'string' ? o.anchors.slice(0, 4000) : '',
  snapshotOnCompact: o.snapshot_on_compact !== false,
  snapshotMemory: o.snapshot_memory !== false,
  compactionModel: o.compaction_model === 'compare' ? 'compare' : o.compaction_model === 'small' ? 'small' : 'session',
})

export const tokens = (chars: number) => Math.ceil(chars / 4)

export const k = (n: number) => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(Math.round(n)))

export type Archive = { id: string; tool: string; field: string; chars: number; text: string }

export type Plan = {
  messages: SessionMessage[]
  archives: Archive[]
  savedTokens: number
  isChanged: boolean
}

// What stands in place of a big text: size, where the whole of it went, and its first line to tell what it was.
export const stubText = (tool: string, field: string, text: string, path: string) => {
  const head = clipHead(text.trim().split('\n')[0] ?? '', 140)

  return `[archived: ${tool}.${field} ~${k(tokens(text.length))} tok.; full: ${path}${head === '' ? '' : `; start: ${head}`}]`
}

export const archivePath = (dir: string, id: string, field: string) => `${dir}/${id}.${field}.txt`

// Walks the messages older than the last `keepRecentMessages` and replaces what is big in them (a tool's result, a
// long argument such as a file a Write put down) with a stub, collecting the originals to archive. A message left
// alone keeps its engine handle and stays whole; one rewritten loses it and is built from what it holds.
export const planStubs = (messages: readonly SessionMessage[], o: JanitorOptions, dir: string): Plan => {
  const cut = messages.length - o.keepRecentMessages
  const archives: Archive[] = []
  let saved = 0

  const out = messages.map((m, i): SessionMessage => {
    if (i >= cut) {
      return m
    }

    let isChanged = false

    const stub = (id: string, tool: string, field: string, text: string): string => {
      if (text.length < o.stubMinChars || text.startsWith('[archived:')) {
        return text
      }

      const path = archivePath(dir, id, field)
      const replaced = stubText(tool, field, text, path)

      archives.push({ id, tool, field, chars: text.length, text })
      saved += tokens(text.length) - tokens(replaced.length)
      isChanged = true

      return replaced
    }

    const toolUses = m.toolUses.map(u => {
      const input: Record<string, unknown> = {}

      for (const [key, value] of Object.entries(u.input)) {
        input[key] = typeof value === 'string' ? stub(u.tool_use_id, u.tool, `in-${key}`, value) : value
      }

      const text = u.text === undefined ? undefined : stub(u.tool_use_id, u.tool, 'out', u.text)
      const hasOut = text !== undefined && text !== u.text

      return { ...u, input, ...(hasOut ? { text, result: undefined } : {}) }
    })

    const toolResults = m.toolResults?.map(r => {
      const text = stub(r.tool_use_id, 'result', 'out', r.text)

      return text === r.text ? r : { ...r, text, result: undefined }
    })

    if (!isChanged) {
      return m
    }

    return { role: m.role, text: m.text, toolUses, ...(toolResults === undefined ? {} : { toolResults }) }
  })

  // One result is reachable twice (the assistant's tool use and the user's tool result): archive each id once.
  const seen = new Set<string>()
  const unique = archives.filter(a => {
    const key = `${a.id}.${a.field}`

    if (seen.has(key)) {
      return false
    }

    seen.add(key)

    return true
  })

  return { messages: out, archives: unique, savedTokens: Math.max(0, saved), isChanged: out.some((m, i) => m !== messages[i]) }
}

// What the summary is told to keep. The person's own `/compact` text, when there is one, goes first.
export const instructionsFor = (own: string | undefined) =>
  [
    own?.trim() ?? '',
    'Compaction priorities: (1) keep every request of the user and every decision with its reason; (2) keep the current task state, open TODOs, the files touched and why; (3) keep errors met and how they were fixed; (4) lines like "[archived: … full: <path>]" mark tool output stored on disk: keep the path of any output that may be needed again; (5) drop exploration noise, repeated listings and anything a file or the repository already holds.',
  ]
    .filter(Boolean)
    .join('\n\n')

export type Gate = { lastAttemptTokens?: number; isForced: boolean }

// The next step at the end of a main-loop turn: a compaction (active), a log of what it would cut (shadow) or nothing.
// Retries wait for 40k more tokens, so a compaction that does not shrink the window cannot loop.
export const decide = (contextTokens: number | undefined, o: JanitorOptions, gate: Gate): 'compact' | 'shadow' | 'none' => {
  if (!o.ownTriggers || contextTokens === undefined || contextTokens < o.thresholdTokens) {
    return 'none'
  }

  if (gate.lastAttemptTokens !== undefined && contextTokens < gate.lastAttemptTokens + 40000) {
    return 'none'
  }

  return o.mode === 'active' ? 'compact' : 'shadow'
}

// Silent for idleMinutes under a big context: warm (under the cache's hour) the compaction reads the context at the
// cached price; cold, the next message would re-write the whole context anyway, so it compacts too.
export const idleStep = (idleMin: number, contextTokens: number, o: JanitorOptions): 'compact' | 'shadow' | 'none' => {
  if (!o.ownTriggers || idleMin < o.idleMinutes || contextTokens < o.idleMinTokens) {
    return 'none'
  }

  return o.idleMode === 'active' ? 'compact' : 'shadow'
}

// Hybrid compaction: keep the conversation with the stubs in it, and make no summary, when the stubs alone take at least
// `maskMinCut` percent off the context; otherwise a summary is made as usual.
export const maskDecision = (contextTokens: number | undefined, savedTokens: number, o: Pick<JanitorOptions, 'compactionStyle' | 'maskMinCut'>): 'mask' | 'summary' =>
  o.compactionStyle === 'hybrid' && contextTokens !== undefined && contextTokens > 0 && (savedTokens / contextTokens) * 100 >= o.maskMinCut ? 'mask' : 'summary'

export const describePlan = (plan: Plan, contextTokens: number | undefined) => {
  const top = [...plan.archives]
    .sort((a, b) => b.chars - a.chars)
    .slice(0, 4)
    .map(a => `${a.tool}.${a.field} ${k(tokens(a.chars))}`)
    .join(' · ')

  return plan.archives.length === 0
    ? `janitor: nothing to trim${contextTokens === undefined ? '' : ` (context ${k(contextTokens)})`}`
    : `janitor: can trim ~${k(plan.savedTokens)} tokens, ${plan.archives.length} fragments (${top})${contextTokens === undefined ? '' : `; context ${k(contextTokens)}`}`
}
