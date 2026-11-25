import { atom, read, update } from 'claude-code'
import type { CoreEngineInterface, Register, SessionUsage } from 'claude-code'

import { archivePath, decide, describePlan, idleStep, instructionsFor, k, maskDecision, planStubs, readOptions, tokens } from './janitor'
import type { Gate, JanitorOptions } from './janitor'
import { fmtSaved, LEDGER_ROWS, ledgerRow, summarizeLedger } from './ledger'
import { applyShape, charsCut, planShape } from './shape'
import { TQ_PANE_ID, registerTqPane } from './pane'
import { EMPTY_TQ_PANE, listSnapshots, localStamp, parseSnapArgs, pickSnapshot, pressOf, projectTag, restoreBlock, SNAPSHOT_SYSTEM, snapshotDoc, snapshotFile, transcriptOf } from './snapshot'
import type { SnapMessage, TqPane, TqTab } from './snapshot'
import { suggestRules } from './suggest'
import { clipHead, clipTail } from './text'
import type { LedgerKind, LedgerRow } from './ledger'

export type Snap = { five?: number; seven?: number; ctx?: number; fiveReset?: string; sevenReset?: string }

export type Spent = { five: number; seven: number }

type Block = { type: string; text?: string }

type Mcp = {
  mcp: { call: (server: string, tool: string, args?: Record<string, unknown>) => Promise<{ content: readonly Block[]; isError: boolean }> }
}

type Llm = {
  model: {
    complete: (r: {
      model: string
      prompt: string
      system?: string
      maxTokens?: number
      effort?: 'low'
      timeoutMs?: number
    }) => Promise<{
      isAnswered: boolean
      text?: string
      reason?: string
      usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
    }>
  }
}

const MOD_VERSION = '0.4.0'

const SERVER = 'mcp-memory-service'

// The one model the mod's memory work runs on: the English recall query, the per-answer extraction and the handoff note.
// Thinking tokens count against maxTokens on it, hence the room the calls leave.
const MEMORY_MODEL = 'claude-haiku-5-5'

const MEMORY_EFFORT = 'low'

// What the five-hour ("session") and seven-day ("week") windows and the context window read now.
// Rate-limit windows are empty off a subscription: every figure then stays undefined.
export const toSnap = (u: SessionUsage): Snap => {
  const five = u.rateLimits.find(r => r.kind === 'five_hour')
  const seven = u.rateLimits.find(r => r.kind === 'seven_day')

  return {
    five: five?.percentUsed,
    seven: seven?.percentUsed,
    ctx: u.context.percent,
    fiveReset: five?.resetsAt,
    sevenReset: seven?.resetsAt,
  }
}

// Growth of a window between two readings; a lower reading means the window reset in between.
export const rise = (a?: number, b?: number): number | undefined =>
  a === undefined || b === undefined ? undefined : b >= a ? b - a : b

// 11 -> "11%", 3.04 -> "3%", 0.46 -> "0.5%": a decimal only where it says something.
const p = (n?: number) => (n === undefined ? '–' : `${Math.round(n * 10) / 10}%`)

const d = (n?: number) => (n === undefined ? '–' : `+${Math.round(n * 10) / 10}%`)

// The line after each answer: what it cost, and the running total.
export const fmtTurn = (turn: { five?: number; seven?: number }, spent: Spent) =>
  `answer: ${d(turn.five)} session · ${d(turn.seven)} week  (total since start: ${d(spent.five)} / ${d(spent.seven)})`

// Keys and tokens by what they say and by their shape. A long run of letters, digits and dashes is no secret by itself
// (a tool name, a session id, a path): it counts only when it mixes digits with both cases, and a slash ends it.
const SECRET_KEYED = /(api[_-]?key|secret|token|passw(or)?d|private[_ ]key)\s*[:=]/i

const SECRET_SHAPE =
  /BEGIN [A-Z ]*KEY|\bsk-[A-Za-z0-9]{16,}|\b(?:gh[pousr]_|xox[abp]-|AKIA|AIza)[A-Za-z0-9_-]{16,}|\b[A-Fa-f0-9]{32,}\b|\b(?=[A-Za-z0-9+=_-]*\d)(?=[A-Za-z0-9+=_-]*[a-z])(?=[A-Za-z0-9+=_-]*[A-Z])[A-Za-z0-9+=_-]{40,}\b/

// A handoff is long and wide: what looks like a secret is blanked out and the rest is still stored.
export const redact = (text: string) =>
  text
    .replace(new RegExp(`${SECRET_KEYED.source}\\s*\\S*`, 'gi'), '[redacted]')
    .replace(new RegExp(SECRET_SHAPE.source, 'g'), '[redacted]')

// Share of Cyrillic among the letters of a text: the notes are stored in English, a Russian one is found poorly.
export const cyrillicShare = (text: string) => {
  const letters = text.match(/\p{L}/gu)?.length ?? 0

  return letters === 0 ? 0 : (text.match(/\p{Script=Cyrillic}/gu)?.length ?? 0) / letters
}

const textOf = (r: { content: readonly Block[] }) => r.content.map(b => (b.type === 'text' ? (b.text ?? '') : '')).join('\n')

const flat = (s: string) => s.replace(/\s+/g, ' ').trim()

// What the mod's own model calls cost. Every call goes through `callModel`: it is added to the turn's tally, shown after
// the answer, and written to a file by kind, so that the day's total can be read back (/janitor stats).
export type Spend = { calls: number; inTok: number; outTok: number; ms: number }

export type SpendRow = { t: string; kind: string; inTok: number; outTok: number; ms: number }

export const noSpend = (): Spend => ({ calls: 0, inTok: 0, outTok: 0, ms: 0 })

const plus = (a: Spend, b: { inTok: number; outTok: number; ms: number }): Spend => ({
  calls: a.calls + 1,
  inTok: a.inTok + b.inTok,
  outTok: a.outTok + b.outTok,
  ms: a.ms + b.ms,
})

export const fmtSpend = (x: Spend) => `mod: calls ${x.calls} · in ${k(x.inTok)} · out ${k(x.outTok)} tok · ${(x.ms / 1000).toFixed(1)} s`

const dayOf = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`

// The file's rows read back: today (the local day), the last seven days, and today by kind.
export const summarizeSpend = (lines: readonly string[], now: Date): { today: Spend; week: Spend; byKind: Record<string, Spend> } => {
  const out = { today: noSpend(), week: noSpend(), byKind: {} as Record<string, Spend> }

  for (const line of lines) {
    let row: SpendRow

    try {
      row = JSON.parse(line) as SpendRow
    } catch {
      continue
    }

    if (row === null || typeof row !== 'object') {
      continue
    }

    const when = new Date(row.t)
    const age = now.getTime() - when.getTime()

    if (Number.isNaN(age) || age < 0 || age > 7 * 86400000) {
      continue
    }

    out.week = plus(out.week, row)

    if (dayOf(when) === dayOf(now)) {
      out.today = plus(out.today, row)
      out.byKind[row.kind] = plus(out.byKind[row.kind] ?? noSpend(), row)
    }
  }

  return out
}

let turnSpend = noSpend()

const unsavedSpend: SpendRow[] = []

const callModel = async ($: Llm, kind: string, req: Parameters<Llm['model']['complete']>[0]) => {
  const started = Date.now()
  const r = await $.model.complete(req)
  const u = r.usage
  const row = {
    t: `${new Date().toISOString().slice(0, 19)}Z`,
    kind,
    inTok: (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0),
    outTok: u?.output_tokens ?? 0,
    ms: Date.now() - started,
  }

  turnSpend = plus(turnSpend, row)
  unsavedSpend.push(row)

  return r
}

const SPEND_ROWS = 15000

let spendQueue: Promise<void> = Promise.resolve()

const spendFile = async ($: Pick<EnvFs, 'env'>) => `${await claudeHome($)}/thriftquill/overhead.jsonl`

const unsavedLedger: LedgerRow[] = []

const noteSaving = (kind: LedgerKind, tokens: number, note?: string) => {
  if (tokens > 0) {
    unsavedLedger.push(ledgerRow(kind, tokens, new Date(), note))
  }
}

const ledgerFile = async ($: Pick<EnvFs, 'env'>) => `${await claudeHome($)}/thriftquill/savings.jsonl`

let ledgerQueue: Promise<void> = Promise.resolve()

const flushLedger = ($: EnvFs): Promise<void> => {
  const rows = unsavedLedger.splice(0)

  if (rows.length === 0) {
    return ledgerQueue
  }

  ledgerQueue = ledgerQueue.then(async () => {
    try {
      const path = await ledgerFile($)
      const old = (await $.fs.exists(path)) ? await $.fs.read(path) : ''

      await $.fs.write(path, `${[...old.split('\n').filter(Boolean), ...rows.map(r => JSON.stringify(r))].slice(-LEDGER_ROWS).join('\n')}\n`)
    } catch {
      // the ledger must never break a hook; the rows wait for the next flush
      unsavedLedger.unshift(...rows.slice(-500))
    }
  })

  return ledgerQueue
}

const flushSpend = ($: EnvFs): Promise<void> => {
  const rows = unsavedSpend.splice(0)

  if (rows.length === 0) {
    return spendQueue
  }

  spendQueue = spendQueue.then(async () => {
    try {
      const path = await spendFile($)
      const old = (await $.fs.exists(path)) ? await $.fs.read(path) : ''

      await $.fs.write(path, `${[...old.split('\n').filter(Boolean), ...rows.map(r => JSON.stringify(r))].slice(-SPEND_ROWS).join('\n')}\n`)
    } catch {
      // the counter must never break a hook; the rows wait for the next flush
      unsavedSpend.unshift(...rows.slice(-500))
    }
  })

  return spendQueue
}

type McpReply = { content: readonly Block[]; isError: boolean }

// A store call that came back is not yet a stored memory: the tool may answer a duplicate or a refusal without
// flagging an error. The wording is the service's own, so a miss here shows in the trace, which keeps the raw text.
export const storeVerdict = (r: McpReply): string => {
  const t = flat(textOf(r))

  if (r.isError) {
    return `error: ${t.slice(0, 100)}`
  }

  return /duplicate|already exists|not stored|rejected|quarantin|"success"\s*:\s*false|success:\s*false/i.test(t) ? `not stored: ${t.slice(0, 100)}` : 'ok'
}

// What the engine hands back after a compaction is the summary as one user message, behind a standard preface.
export const summaryOf = (messages: readonly { role: string; text: string }[]): string => {
  const m =
    messages.find(x => x.role === 'user' && x.text.startsWith('This session is being continued')) ??
    messages.find(x => x.role === 'user' && x.text.length > 200)
  const at = m === undefined ? -1 : m.text.indexOf('Summary:')

  return m === undefined ? '' : at >= 0 && at < 500 ? m.text.slice(at + 'Summary:'.length).trim() : m.text
}

// What the hooks know about the memory service. In a desktop session the service belongs to the app, and the engine's
// `$.mcp.call` may not see it ("no connected MCP tool"): then the hooks stop calling and hand what is to be stored to
// the model, which has the tools, as a block in the next prompt.
export type Relay = { mcpDown: boolean; items: string[] }

export const isUnreachable = (err: unknown) => /no connected MCP tool/i.test(String(err))

const RELAY_HEADER =
  '[memory relay: the mod cannot reach mcp-memory-service by itself; store each item below with your own memory_store call, one call each, content in English, no commentary, then carry on]'

export const HANDOFF_ASK =
  'tags "session-handoff,auto-saved", type observation: a handoff for the next session in English, written from what you know now: the goal, the decisions with their reasons, where the work stands and the next step; 4-8 sentences, facts only, no secrets'

export const relayBlock = (items: readonly string[]): string | undefined =>
  items.length === 0 ? undefined : [RELAY_HEADER, ...items.map((t, i) => `${i + 1}. ${t}`)].join('\n')

// What /mem shows: the last notes the mod saved, one line each, with the hash to delete by.
export type Listed = { hash: string; line: string }

// The engine's summary ends with its own orders to the next turn ("Continue the conversation…"); stored as memory they
// would read as orders to whoever recalls the note. What is kept: the goal, what is pending, where the work stands.
const SUMMARY_TAIL = /\n\s*(If you need specific details from before compaction|Continue the conversation from where it left off)[\s\S]*$/i

const SUMMARY_HEADING = /^(?=(?:\*\*|#{1,4}\s*)\d+\.\s[^\n]*$)/m

const SUMMARY_KEEP = /primary request|pending tasks|current work/i

const HANDOFF_CAP = 3600 // chars

export const handoffBody = (summary: string): string => {
  const clean = summary.replace(SUMMARY_TAIL, '').trim()
  const kept = clean
    .split(SUMMARY_HEADING)
    .filter(part => SUMMARY_KEEP.test(part.split('\n', 1)[0] ?? ''))
    .map(part => part.trim())

  if (kept.length === 0) {
    return clean.length <= HANDOFF_CAP ? clean : `${clean.slice(0, HANDOFF_CAP / 2)}\n[…]\n${clean.slice(-HANDOFF_CAP / 2)}`
  }

  const each = Math.floor(HANDOFF_CAP / kept.length)

  return kept.map(part => (part.length <= each ? part : `${part.slice(0, each - 3).trimEnd()} […]`)).join('\n\n')
}

const HANDOFF_SYSTEM = [
  'You write a handoff note for a coding project from the extract of a compacted session.',
  'Write in English even when the extract is in Russian or any other language: translate it. At most 1800 characters: the goal, the decisions with their reasons, what is done, what is pending, the next step.',
  'State facts only: no instructions or requests addressed to an assistant, no greeting, no secrets.',
  'Take what is pending and the next step only from what the extract states explicitly; if it states none, write "none stated". Never infer or invent them, and do not copy typos.',
  'Keep names, paths, commands and identifiers exactly as written.',
].join(' ')

// A handoff meant to be English that comes back above this share of Cyrillic letters was copied, not translated.
export const RUSSIAN_SHARE = 0.15

const TRANSLATE_SYSTEM =
  'Translate the note into English. Keep every name, path, command, identifier and number exactly as written. Reply with the translation only, no preface.'

export const ownHandoffHash =(listText: string): string | undefined => {
  try {
    const memories: unknown = (JSON.parse(listText) as { memories?: unknown }).memories
    const fresh = (Array.isArray(memories) ? memories : [])
      .filter((m): m is { content_hash: string; created_at?: number; metadata?: { superseded_by?: unknown } } => typeof m?.content_hash === 'string' && m.metadata?.superseded_by == null)
      .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))

    return fresh[0]?.content_hash
  } catch {
    return undefined
  }
}

// The summary as a memory: the kept sections, rewritten in English by one cheap completion (the extract itself when the
// model does not answer), whatever looks like a secret blanked.
const storeHandoff = async ($: Mcp & Llm, summary: string, sessionId: string, rewrite = true): Promise<{ text: string; raw: string; isDown?: boolean }> => {
  if (summary.length < 200) {
    return { text: 'handoff not stored: no summary found', raw: 'no summary' }
  }

  let note = handoffBody(summary)
  let via = 'extract'

  // Thinking tokens count against maxTokens on this model, hence the room; the extract is stored when the call fails.
  try {
    const r = rewrite
      ? await callModel($, 'handoff', { model: MEMORY_MODEL, system: HANDOFF_SYSTEM, prompt: note, maxTokens: 2500, effort: MEMORY_EFFORT, timeoutMs: 40000 })
      : { isAnswered: false, text: '', reason: 'no model call, handoff_rewrite is off', usage: undefined }
    const text = r.isAnswered ? (r.text ?? '').trim() : ''

    if (text.length >= 200) {
      note = text
      via = `${MEMORY_MODEL} ${MEMORY_EFFORT}`

      // Written in Russian all the same: one more pass that only translates; the Russian text is kept when that fails too.
      if (cyrillicShare(note) > RUSSIAN_SHARE) {
        const t = await callModel($, 'handoff', { model: MEMORY_MODEL, system: TRANSLATE_SYSTEM, prompt: note, maxTokens: 2500, effort: MEMORY_EFFORT, timeoutMs: 40000 })
        const english = t.isAnswered ? (t.text ?? '').trim() : ''
        const isEnglish = english.length >= 200 && cyrillicShare(english) <= RUSSIAN_SHARE

        via += isEnglish ? ', translated' : ', still Russian'
        note = isEnglish ? english : note
      }
    } else {
      via = `extract (${MEMORY_MODEL}: ${r.isAnswered ? `reply of ${text.length} chars` : r.reason})`
    }
  } catch (err) {
    via = `extract (${MEMORY_MODEL} threw: ${flat(String(err)).slice(0, 80)})`
  }

  try {
    const content = redact(`Session handoff ${new Date().toISOString().slice(0, 10)}: ${note}`)
    const tags = `session-handoff,auto-saved,sid:${sessionId.slice(0, 8)}`
    let r: McpReply | undefined

    // One handoff per session: a later compaction of the same session is a new version of it, not one more note.
    try {
      const own = await $.mcp.call(SERVER, 'memory_list', { tags: ['session-handoff', `sid:${sessionId.slice(0, 8)}`], tag_match: 'all', page_size: 10 })
      const hash = own.isError ? undefined : ownHandoffHash(textOf(own))

      if (hash !== undefined) {
        const updated = await $.mcp.call(SERVER, 'memory_update', { content_hash: hash, versioned: true, updates: { content, tags } })

        r = updated.isError ? undefined : updated
      }
    } catch {
      // the look-up or the update failed: the handoff is stored as a new note, as before
    }

    r ??= await $.mcp.call(SERVER, 'memory_store', {
      content,
      conversation_id: `handoff-${sessionId}`,
      metadata: { tags, type: 'observation' },
    })
    const verdict = storeVerdict(r)

    return {
      text: verdict === 'ok' ? 'handoff stored in memory (session-handoff)' : `handoff not stored in memory — ${verdict}`,
      raw: `via ${via}, ${note.length} chars | ${flat(textOf(r)).slice(0, 160)}`,
    }
  } catch (err) {
    return { text: `handoff not stored in memory — ${String(err).slice(0, 100)}`, raw: String(err).slice(0, 200), isDown: isUnreachable(err) }
  }
}

// The engine re-announces the whole skill listing and the deferred-tool names whenever the set changes (a plugin
// added, an MCP server reconnected). Every copy rides each later request, so only what the model has not been told
// since the last compaction is let through; a tool that went away and came back is told again.
export type Seen = { skills: Set<string>; tools: Set<string> }

const SKILL_START = /^- /

const TOOLS_NOW = /^The following deferred tools are now available/

const TOOLS_GONE = /^The following deferred tools are no longer available/

const TOOL_NAME = /^[A-Za-z0-9_.:-]+$/

export const skillBlocks = (text: string): { head: string; blocks: string[] } => {
  const lines = text.split('\n')
  const first = lines.findIndex(l => SKILL_START.test(l))

  if (first === -1) {
    return { head: text, blocks: [] }
  }

  const blocks: string[] = []

  for (const line of lines.slice(first)) {
    if (SKILL_START.test(line)) {
      blocks.push(line)
    } else {
      blocks[blocks.length - 1] += `\n${line}`
    }
  }

  return { head: lines.slice(0, first).join('\n'), blocks }
}

// The listing with the skills already announced taken out: the text itself when all are new, null when none is.
export const dedupeSkills = (text: string, seen: Set<string>): string | null => {
  const { head, blocks } = skillBlocks(text)
  const fresh = blocks.filter(b => !seen.has(b.trim()))

  for (const b of blocks) {
    seen.add(b.trim())
  }

  if (blocks.length === 0 || fresh.length === blocks.length) {
    return text
  }

  return fresh.length === 0 ? null : `${head}\n${fresh.join('\n')}`
}

// The same for the deferred-tool notice: names already announced and not withdrawn since are cut from "now
// available"; "no longer available" is kept whole and forgets its names. Text that does not parse passes as it is.
export const dedupeDeferred = (text: string, known: Set<string>): string | null => {
  const out: string[] = []
  let mode: 'now' | 'gone' | undefined
  let header = ''
  let names: string[] = []
  let isTouched = false
  let isKept = false

  const flush = () => {
    if (mode === 'now') {
      const fresh = names.filter(n => !known.has(n))

      names.forEach(n => known.add(n))

      if (fresh.length !== names.length) {
        isTouched = true
      }

      if (fresh.length > 0) {
        out.push(header, ...fresh)
        isKept = true
      }
    } else if (mode === 'gone') {
      names.forEach(n => known.delete(n))
      out.push(header, ...names)
      isKept = true
    }

    mode = undefined
    names = []
  }

  for (const line of text.split('\n')) {
    if (mode !== undefined && TOOL_NAME.test(line)) {
      names.push(line)
      continue
    }

    flush()

    if (TOOLS_NOW.test(line) || TOOLS_GONE.test(line)) {
      mode = TOOLS_NOW.test(line) ? 'now' : 'gone'
      header = line
    } else {
      out.push(line)
    }
  }

  flush()

  if (!isTouched) {
    return text
  }

  return isKept ? out.join('\n') : null
}

// Tool compression: thriftquill/tool-defer.txt holds one rule per line, "defer <name|prefix|*>" or "keep <name|prefix>"
// (# starts a comment). A tool is moved behind ToolSearch (its schema leaves the prompt) when a defer rule matches and
// no keep rule does. A tool called in at least HOT_SESSIONS of the last HOT_WINDOW EARLIER sessions is never deferred; what is
// called in this session changes nothing until the next one, because moving a tool that was already sent drops the prompt cache.
// No file means no change.
export type DeferRules = { defer: string[]; keep: string[] }

export const HOT_SESSIONS = 3

export const HOT_WINDOW = 10

export const parseDeferRules = (text: string): DeferRules => {
  const rules: DeferRules = { defer: [], keep: [] }

  for (const raw of text.split('\n')) {
    const m = /^(defer|keep)\s+(\S+)/.exec(raw.replace(/#.*$/, '').trim())

    if (m !== null) {
      rules[m[1] as 'defer' | 'keep'].push(m[2]!)
    }
  }

  return rules
}

const ruleHit = (rule: string, name: string) => rule === '*' || name === rule || (rule.endsWith('*') ? name.startsWith(rule.slice(0, -1)) : rule.endsWith('__') && name.startsWith(rule))

// undefined: leave the engine's own placement. true: move behind ToolSearch. false: keep the schema in the prompt.
export const deferralFor = (name: string, rules: DeferRules, hot: ReadonlySet<string>): boolean | undefined => {
  if (rules.keep.length + rules.defer.length === 0) {
    return undefined
  }

  if (name === 'ToolSearch' || hot.has(name) || rules.keep.some(r => ruleHit(r, name))) {
    return false
  }

  return rules.defer.some(r => ruleHit(r, name)) ? true : undefined
}

// Tools used in at least HOT_SESSIONS of the last HOT_WINDOW sessions (each entry: the session id, then the tool names it called).
export const hotTools = (history: readonly (readonly string[])[]): Set<string> => {
  const counts = new Map<string, number>()

  for (const used of history.slice(-HOT_WINDOW)) {
    for (const name of new Set(used.slice(1))) {
      counts.set(name, (counts.get(name) ?? 0) + 1)
    }
  }

  return new Set([...counts].filter(([, n]) => n >= HOT_SESSIONS).map(([name]) => name))
}

export const asHistory = (v: unknown): string[][] => (Array.isArray(v) ? v.filter((x): x is string[] => Array.isArray(x)) : [])

// `real` holds the engine's own token counts for tools whose schema it measured (the MCP ones); every other tool is
// estimated from its description, which the tool list cuts at 300 characters, so those sizes are lower bounds.
export const fmtToolSizes = (tools: readonly { name: string; description: string; mcp: boolean }[], rules: DeferRules, hot: ReadonlySet<string>, real: ReadonlyMap<string, number> = new Map()) => {
  const rows = tools
    .map(t => ({ name: t.name, chars: t.description.length, tokens: real.get(t.name) ?? t.description.length / 4, mcp: t.mcp, deferred: deferralFor(t.name, rules, hot) === true }))
    .sort((a, b) => b.tokens - a.tokens)
  const sum = (xs: typeof rows) => xs.reduce((n, r) => n + r.tokens, 0)
  const k = (tokens: number) => `${(tokens / 1000).toFixed(1)}k`
  const builtIn = rows.filter(r => !r.mcp)
  const mcp = rows.filter(r => r.mcp)
  const lines = [
    `Tools: ${rows.length} (built-in ${builtIn.length}, MCP ${mcp.length}). Descriptions ≈ ${k(sum(rows))} tokens (parameter schemas not counted, the real figure is higher).`,
    `Rules defer ${rows.filter(r => r.deferred).length}: descriptions ≈ −${k(sum(rows.filter(r => r.deferred)))} (built-in ${k(sum(builtIn.filter(r => r.deferred)))}, MCP ${k(sum(mcp.filter(r => r.deferred)))}).`,
    `Hot (always in the pool): ${hot.size === 0 ? 'none' : [...hot].join(', ')}.`,
    'Largest:',
    ...rows.slice(0, 15).map(r => `  ${r.deferred ? '↓' : '•'} ${r.name} ${k(r.tokens)}${real.has(r.name) ? '' : '+'}`)
  ]

  return { text: lines.join('\n'), rows }
}

// B0 experiment: names of deferred tools whose prefix is listed (thriftquill/hide-tools.txt, one per line, e.g.
// "mcp__acme__") are cut from the "now available" notice and replaced by one line saying how many and how to find
// them. The tools stay callable: ToolSearch reads the engine's registry, not this notice.
export const hideTools = (text: string, prefixes: readonly string[]): string => {
  if (prefixes.length === 0) {
    return text
  }

  const hidden = new Map<string, number>()
  const out: string[] = []
  let isNow = false

  for (const line of text.split('\n')) {
    if (isNow && TOOL_NAME.test(line)) {
      const hit = prefixes.find(p => line.trim().startsWith(p))

      if (hit !== undefined) {
        hidden.set(hit, (hidden.get(hit) ?? 0) + 1)
        continue
      }
    } else if (isNow) {
      for (const [p, n] of hidden) {
        out.push(`(${n} tools "${p}*" are not listed to save context; find them with ToolSearch "${p.replace(/^mcp__|__$/g, '')}")`)
      }

      hidden.clear()
      isNow = false
    }

    if (TOOLS_NOW.test(line)) {
      isNow = true
    }

    out.push(line)
  }

  for (const [p, n] of hidden) {
    out.push(`(${n} tools "${p}*" are not listed to save context; find them with ToolSearch "${p.replace(/^mcp__|__$/g, '')}")`)
  }

  return out.join('\n')
}

// Where the full text of what a compaction stubs goes: one folder per session under the user's Claude folder.
type EnvFs = {
  env: { get: (name: string) => Promise<string | undefined> }
  fs: { read: (path: string) => Promise<string>; write: (path: string, text: string) => Promise<void>; exists: (path: string) => Promise<boolean> }
}

const claudeHome = async ($: Pick<EnvFs, 'env'>) => {
  const configured = await $.env.get('CLAUDE_CONFIG_DIR')

  if (configured !== undefined && configured !== '') {
    return configured.replace(/\\/g, '/')
  }

  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '.'

  return `${home.replace(/\\/g, '/')}/.claude`
}

const archiveDir = async ($: Pick<EnvFs, 'env'> & { session: { id: () => Promise<string> } }) =>
  `${await claudeHome($)}/thriftquill/${await $.session.id()}`

// What the hooks did and why they failed, as a file to read afterwards. A line sent to the debug log is lost when no
// debug log runs, and a transcript line is gone once a compaction clears the screen. Newest last, bounded; the writes
// queue so that two hooks tracing at once do not lose each other's rows.
const TRACE_ROWS = 150

let traceQueue: Promise<void> = Promise.resolve()

export const traceFile = async ($: Pick<EnvFs, 'env'>) => `${await claudeHome($)}/thriftquill/trace.log`

const trace = ($: EnvFs, line: string): Promise<void> => {
  const row = `${new Date().toISOString().slice(0, 19)}Z ${flat(line).slice(0, 700)}`

  traceQueue = traceQueue.then(async () => {
    try {
      const path = await traceFile($)
      const old = (await $.fs.exists(path)) ? await $.fs.read(path) : ''

      await $.fs.write(path, `${[...old.split('\n').filter(Boolean), row].slice(-TRACE_ROWS).join('\n')}\n`)
    } catch {
      // tracing must never break a hook
    }
  })

  return traceQueue
}

// One call to each memory tool's reading side: tells at once whether `$.mcp.call` reaches the service from a hook.
const probe = async ($: Mcp): Promise<{ ok: boolean; text: string }> => {
  try {
    const r = await $.mcp.call(SERVER, 'memory_search', { query: 'selftest', limit: 1, max_response_chars: 200 })

    return { ok: !r.isError, text: `search isError=${r.isError} blocks=${r.content.length} text="${flat(textOf(r)).slice(0, 120)}"` }
  } catch (err) {
    return { ok: false, text: `search threw: ${String(err).slice(0, 450)}` }
  }
}

type Compactor = {
  session: { compact: (args?: { instructions?: string }) => Promise<{ skip?: string }> }
  command: { run: (input: { command: string; args?: string }) => Promise<unknown> }
}

// A desktop or SDK session has no `$.session.compact` yet and says so: there compaction is the person's /compact,
// which a plugin can run as a command; it is queued and starts once the session is idle.
const compactNow = async ($: Compactor): Promise<string> => {
  try {
    const r = await $.session.compact({})

    return r.skip === undefined ? 'compaction done' : `skipped — ${r.skip}`
  } catch (err) {
    if (!/headless|SDK/i.test(String(err))) {
      throw err
    }

    await $.command.run({ command: 'compact' })

    return 'compaction started by /compact'
  }
}

// What a compaction left to report: the hook fills it in, and the next prompt shows it (a line logged inside the
// compaction itself is not reliably on screen once the conversation is replaced).
type Pending = { trigger: string; archived: number; saved: number; before?: number; after?: number; summary?: string; usageLine?: string; masked?: boolean }

// The report is owed across a reload of the mod (any edit of it, a change of folder): it is kept in the store with the
// session it belongs to, and a later load takes it back unless it is stale.
type Keep = {
  store: { get: (key: string) => Promise<unknown>; set: (key: string, value: unknown) => Promise<void>; delete: (key: string) => Promise<void> }
  session: { id: () => Promise<string> }
}

// One key per session: several sessions share the store, and each owes its own report.
const PENDING_TTL_MS = 6 * 60 * 60 * 1000

const pendingKey = async ($: Keep) => `pending:${(await $.session.id()).slice(0, 8)}`

export const keepPending = async ($: Keep, p: Pending) => {
  await $.store.set(await pendingKey($), { at: Date.now(), p })
}

export const dropPending = async ($: Keep) => {
  await $.store.delete(await pendingKey($))
}

export const takePending = async ($: Keep): Promise<Pending | undefined> => {
  const kept = (await $.store.get(await pendingKey($))) as { at?: number; p?: Pending } | undefined

  if (kept === undefined) {
    return undefined
  }

  if (typeof kept.at !== 'number' || Date.now() - kept.at >= PENDING_TTL_MS) {
    await dropPending($)

    return undefined
  }

  return kept.p
}

type Flush = Mcp &
  Llm &
  EnvFs & {
    ui: { log: (text: string, options?: { to: 'debug' | 'transcript' }) => void }
    session: { id: () => Promise<string>; messages: () => Promise<unknown>; usage: () => Promise<SessionUsage> }
  }

// A failure the person should hear of once per session and kind; the trace has every one of them.
const warnOnce = ($: Flush, warned: Set<string>, kind: string, text: string) => {
  if (!warned.has(kind)) {
    warned.add(kind)
    $.ui.log(`${text} (details: /janitor trace)`)
  }
}

// After a compaction: tell what it did and put the summary into memory, from the next prompt rather than from inside
// the compaction. When the hook never saw the result, the figures and the summary are read from what the engine left.
const reportCompaction = async ($: Flush, jo: JanitorOptions, state: Relay, p: Pending) => {
  const list: readonly { role: string; text: string }[] = await $.session.messages().then(
    all => (Array.isArray(all) ? (all as { role: string; text: string }[]) : []),
    () => [],
  )
  const summary = p.summary !== undefined && p.summary !== '' ? p.summary : summaryOf(list)
  const after = p.after ?? (await $.session.usage()).context.tokens
  let memory: { text: string; raw: string } = { text: 'handoff to memory: off', raw: 'off' }

  if (p.masked === true) {
    memory = { text: 'handoff to memory: not needed (nothing was summarized)', raw: 'masked' }
  } else if (jo.isHandoff && state.mcpDown) {
    memory = { text: 'handoff to memory: handed to the model (the mod cannot reach the service)', raw: 'handed to the model' }
  } else if (jo.isHandoff) {
    const stored = await storeHandoff($, summary, await $.session.id(), jo.handoffRewrite)

    memory = stored

    if (stored.isDown) {
      state.mcpDown = true
      state.items.push(HANDOFF_ASK)
      memory = { text: 'handoff to memory: handed to the model (the mod cannot reach the service)', raw: stored.raw }
    }
  }

  const size = `${p.before === undefined ? '' : `${k(p.before)} → `}${after === undefined ? '?' : k(after)} tokens`

  $.ui.log(`janitor: compaction (${p.trigger}): ${size}; stubs ${p.archived} (≈ −${k(p.saved)} in the summary input); ${memory.text}`)

  await trace($, `report: ${size}, stubs ${p.archived}, summary ${summary.length} chars, hook-saw-result=${p.after !== undefined}, handoff: ${memory.text} | ${memory.raw}`)
}

// ---- context snapshots (/snap, /restore, and one before every compaction)
type Snapper = Flush & {
  fs: { list: (path?: string) => Promise<readonly { name: string; kind: string }[]> }
  session: { cwd: () => Promise<string> }
}

const snapshotDir = async ($: Pick<EnvFs, 'env'>) => `${await claudeHome($)}/thriftquill/snapshots`

const projectHere = async ($: Pick<Snapper, 'env' | 'session'>) =>
  projectTag(await $.session.cwd().catch(() => undefined), (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')))

const snapshotsIn = async ($: Snapper) =>
  listSnapshots(
    (await $.fs.list(await snapshotDir($)).catch(() => []))
      .filter(x => x.kind === 'file')
      .map(x => x.name),
  )

// The conversation pressed into a snapshot file by the small model (a raw extract when it gives no answer), and a copy in
// memory when that is on. Resolves the line for the person.
const takeSnapshot = async ($: Snapper, jo: JanitorOptions, state: Relay, messages: readonly SnapMessage[], name: string): Promise<string> => {
  if (messages.length < 2) {
    return 'snapshot: nothing to keep yet, the conversation is empty'
  }

  const now = new Date()
  const cwd = await $.session.cwd().catch(() => '')
  const project = await projectHere($)
  const transcript = transcriptOf(messages)
  let body = ''
  let source: 'model' | 'extract' = 'extract'

  try {
    const r = await callModel($, 'snapshot', { model: MEMORY_MODEL, system: SNAPSHOT_SYSTEM, prompt: transcript, maxTokens: 6000, effort: MEMORY_EFFORT, timeoutMs: 90000 })
    const text = r.isAnswered ? (r.text ?? '').trim() : ''

    if (text.length >= 200) {
      body = text
      source = 'model'
    }
  } catch {
    // the raw extract below stands in
  }

  body = redact(body === '' ? `## Raw extract (the end of the conversation)\n\n${clipTail(transcript, 12000)}` : body)

  const file = snapshotFile(now, project, name)
  const doc = snapshotDoc({ name, project, cwd, sessionId: await $.session.id(), at: now, messages: messages.length, source }, body)

  await $.fs.write(`${await snapshotDir($)}/${file}`, doc)

  let memory = 'memory copy off'

  if (jo.snapshotMemory && state.mcpDown) {
    memory = 'memory copy skipped: the mod cannot reach the service'
  } else if (jo.snapshotMemory) {
    try {
      const r = await $.mcp.call(SERVER, 'memory_store', {
        content: clipHead(`Context snapshot "${name}" of ${project ?? 'no project'}, taken ${localStamp(now)}, file thriftquill/snapshots/${file}:\n${body}`, 3000),
        metadata: { tags: ['snapshot', 'thriftquill', ...(project === undefined ? [] : [project])].join(','), type: 'observation' },
      })

      memory = `memory copy ${storeVerdict(r)}`
    } catch (err) {
      state.mcpDown = state.mcpDown || isUnreachable(err)
      memory = `memory copy failed: ${flat(String(err)).slice(0, 80)}`
    }
  }

  await trace($, `snapshot ${file}: ${source}, ${doc.length} chars; ${memory}`)

  return `snapshot saved: ${file} (${source === 'model' ? 'summary' : 'raw extract, the model gave no answer'}, ~${k(tokens(doc.length))} tok; ${memory}). Restore it in any chat: /restore ${name}`
}

// What the mod adds to the system prompt: the memory-relay rule (only while the handoff is on) and the text of the
// "anchors" setting, if the person wrote one. Nothing else: the mod has no opinions about language or tools.
const RELAY_ANCHOR = [
  '# Memory relay (always applies, also after context compaction)',
  'When a message carries a block starting "[memory relay", store each listed item with your own memory_store call exactly as listed, one call each and without commentary, then carry on.',
].join('\n')

// Whether a section composed beneath this mod (mnemovale's) already tells the model how to handle a relay block.
export const hasRelayRule = (sections: readonly unknown[]): boolean =>
  sections.some(s => typeof s === 'object' && s !== null && typeof (s as { text?: unknown }).text === 'string' && (s as { text: string }).text.includes('block starting "[memory relay"'))

// `hasRelay`: the rule is in the prompt already, so it is not sent twice.
export const anchorsFor = (jo: Pick<JanitorOptions, 'isHandoff' | 'anchors'>, hasRelay = false) => {
  const text = [jo.isHandoff && !hasRelay ? RELAY_ANCHOR : '', jo.anchors].filter(part => part.trim() !== '').join('\n\n')

  return text === '' ? undefined : ({ id: 'thriftquill:protocol', scope: 'session', text } as const)
}

// What /janitor does, for the command and the pane's buttons alike (the engine hands $ to top-level functions only).
type JanitorLive = { jo: JanitorOptions; gate: Gate; relay: Relay; fired: { submit: number; compose: number } & Record<string, number> }

const janitorCommand = async ($: CoreEngineInterface, live: JanitorLive, rawArgs: string): Promise<{ text?: string }> => {
  const { jo, gate, relay, fired } = live
  // One screen that says whether the mod can work here: which hooks ran, the rules, the service, the engine's threshold.
  if (rawArgs.trim() === 'doctor') {
    const rulesText = await $.fs.read(`${await claudeHome($)}/thriftquill/tool-defer.txt`).catch(() => undefined)
    const rules = rulesText === undefined ? undefined : parseDeferRules(rulesText)
    const version = await $.session.version().then(v => v.version, () => '?')
    const usage = await $.session.usage({ breakdown: 'summary' }).catch(() => undefined)
    const threshold = usage?.context.breakdown?.autoCompactThreshold
    let service = 'not needed (handoff is off)'
    let model = 'not needed (handoff is off)'

    if (jo.isHandoff) {
      const started = Date.now()
      const reading = await probe($)

      service = `${reading.ok ? 'reachable' : 'NOT reachable'} (${Date.now() - started} ms)${reading.ok ? '' : ` — ${reading.text.slice(0, 140)}`}`
      relay.mcpDown = !reading.ok
      model = await callModel($, 'probe', { model: MEMORY_MODEL, system: 'Reply with the single word OK.', prompt: 'ping', maxTokens: 500, effort: MEMORY_EFFORT, timeoutMs: 8000 }).then(
        r => (r.isAnswered ? 'answers' : `no answer: ${r.reason ?? '?'}`),
        err => `threw: ${flat(String(err)).slice(0, 100)}`,
      )
    }

    const bypassed = fired.submit > 0 && fired.compose === 0

    return {
      text: [
        `thriftquill v${MOD_VERSION} · Claude Code ${version} · mode ${jo.mode} · own triggers ${jo.ownTriggers ? 'on' : 'off'} · handoff ${jo.isHandoff ? 'on' : 'off'} · output ${jo.outputMode} (cap ${jo.outputCapChars}) · compaction ${jo.compactionStyle}`,
        `tool rules: ${rules === undefined ? 'no tool-defer.txt (no tool compression)' : `${rules.defer.length} defer, ${rules.keep.length} keep`}`,
        `memory service ${SERVER}: ${service}`,
        `model ${MEMORY_MODEL}: ${model}`,
        `hooks that ran this session: prompt.compose ${fired.compose}, prompt.submit ${fired.submit}, prompt.attachment ${fired.attachment}, tool.describe ${fired.describe}, session.append ${fired.append}, tool.call ${fired.toolCall}, turn.complete ${fired.complete}, session.compact ${fired.compact}`,
        bypassed
          ? 'WARNING: prompt.submit ran but prompt.compose never did. Another plugin may be bypassing user mods (a managed sec-default); run claude --debug and look for "bypassed by cc-plugin-sec-default".'
          : 'hooks: no sign of a bypass',
        threshold === undefined ? 'engine auto-compact: off or unknown' : `engine auto-compact threshold: ${threshold} tokens`,
        `files: ${await claudeHome($)}/thriftquill/`,
      ].join('\n'),
    }
  }

  // The tail of the trace file: what the hooks did last, for the person and for whoever debugs the mod.
  if (rawArgs.trim() === 'trace') {
    const text = await $.fs.read(await traceFile($)).catch(() => '')

    return { text: text === '' ? 'trace.log is empty so far' : text.split('\n').filter(Boolean).slice(-25).join('\n') }
  }

  // What the mod's own model calls cost: today, the last seven days, and today by kind.
  if (rawArgs.trim() === 'stats') {
    await flushSpend($)

    const rows = (await $.fs.read(await spendFile($)).catch(() => '')).split('\n').filter(Boolean)
    const { today, week, byKind } = summarizeSpend(rows, new Date())
    const kinds = Object.entries(byKind)
      .sort((a, b) => b[1].inTok + b[1].outTok - (a[1].inTok + a[1].outTok))
      .map(([kind, x]) => `${kind} ${x.calls} (${k(x.inTok)}/${k(x.outTok)})`)

    await flushLedger($)

    const saved = summarizeLedger((await $.fs.read(await ledgerFile($)).catch(() => '')).split('\n').filter(Boolean), new Date())

    return {
      text: [
        `saved today: ${fmtSaved(saved.today)}`,
        `saved in 7 days: ${fmtSaved(saved.week)}`,
        saved.deferred === undefined ? 'tool schema out of the prompt: no reading today' : `tool schema out of the prompt now: ${k(saved.deferred)} (the engine's own tool search is in that figure; not added to the totals)`,
        'what it cost (small-model calls; the saved figures are tokens the main model did not read):',
        `today: ${fmtSpend(today).replace('mod: ', '')}`,
        `last 7 days: ${fmtSpend(week).replace('mod: ', '')}`,
        kinds.length === 0 ? 'by kind: no data yet' : `by kind today (calls, in/out): ${kinds.join(' · ')}`,
      ].join('\n'),
    }
  }

  // One tiny call to the janitor's model: whether the alias and the effort are accepted, what it answers and what it costs.
  if (rawArgs.trim() === 'probe') {
    const started = Date.now()
    const r = await callModel($, 'probe', { model: MEMORY_MODEL, system: 'Reply with the single word OK.', prompt: 'ping', maxTokens: 500, effort: MEMORY_EFFORT, timeoutMs: 8000 })
    const took = `${Math.round((Date.now() - started) / 100) / 10} s`

    return {
      text: r.isAnswered
        ? `janitor: ${MEMORY_MODEL} ${MEMORY_EFFORT} answers "${flat(r.text ?? '').slice(0, 40)}" in ${took}; in ${(r.usage?.input_tokens ?? 0) + (r.usage?.cache_read_input_tokens ?? 0) + (r.usage?.cache_creation_input_tokens ?? 0)}, out ${r.usage?.output_tokens ?? 0} tok.`
        : `janitor: ${MEMORY_MODEL} ${MEMORY_EFFORT} no answer in ${took}: ${r.reason}`,
    }
  }

  if (rawArgs.trim() === 'run') {
    gate.isForced = true

    // The engine refuses a compaction raised under the command's own dispatch: it runs a moment later, on its own.
    $.clock.after(300, async () => {
      try {
        $.ui.log(`janitor: ${await compactNow($)}`)
      } catch (err) {
        gate.isForced = false
        $.ui.log(`janitor: failed — ${String(err).slice(0, 200)}`)
      }
    })

    return { text: 'janitor: compaction starting (stubs for old big outputs, handoff to memory)…' }
  }

  const usage = await $.session.usage()
  const messages = await $.session.messages()
  const plan = planStubs(Array.isArray(messages) ? messages : [], jo, await archiveDir($))

  return {
    text: [
      describePlan(plan, usage.context.tokens),
      `mode: ${jo.mode} · own triggers: ${jo.ownTriggers ? 'yes' : 'no'} · threshold ${k(jo.thresholdTokens)} · recent messages left whole ${jo.keepRecentMessages} · stubs from ${tokens(jo.stubMinChars)} tok. · handoff to memory: ${jo.isHandoff ? 'yes' : 'no'}`,
      '/janitor run — compact now (with stubs), even in shadow mode; /janitor probe — check the janitor model',
    ].join('\n'),
  }
}

// What /tools does, for the command and the pane alike.
const toolsCommand = async ($: CoreEngineInterface, usedNow: ReadonlySet<string>, rawArgs: string): Promise<{ text?: string }> => {
  // Rules for tool-defer.txt from what is actually called, written to a file for the person to review.
  if (rawArgs.trim() === 'suggest') {
    const breakdown = await $.session.usage({ breakdown: 'summary' }).then(u => u.context.breakdown, () => undefined)
    const real = new Map((breakdown?.mcpTools ?? []).map(t => [t.name, t.tokens] as const))
    const tools = (await $.tool.list()).map(t => ({ name: t.name, tokens: real.get(t.name) ?? t.description.length / 4, mcp: t.mcp }))
    const hot = new Set([...hotTools(asHistory(await $.store.get('toolUse').catch(() => undefined))), ...usedNow])
    const s = suggestRules(tools, hot)

    await $.fs.write(`${await claudeHome($)}/thriftquill/tool-defer.suggested.txt`, `${s.lines.join('\n')}\n`).catch(() => undefined)

    return {
      text: [
        `${s.lines.length - 1} suggested rules, about ${k(s.deferredTokens)} tokens of MCP schema; ${s.kept.length} tool(s) you use stay in the prompt.`,
        ...s.lines.slice(1, 13),
        s.lines.length > 13 ? `… and ${s.lines.length - 13} more` : '',
        'Written to thriftquill/tool-defer.suggested.txt; copy the lines you want into tool-defer.txt.',
      ]
        .filter(Boolean)
        .join('\n'),
    }
  }

  const rules = parseDeferRules(await $.fs.read(`${await claudeHome($)}/thriftquill/tool-defer.txt`).catch(() => ''))
  const breakdown = await $.session.usage({ breakdown: 'summary' }).then(u => u.context.breakdown, () => undefined)
  const real = new Map((breakdown?.mcpTools ?? []).map(t => [t.name, t.tokens] as const))
  const { text, rows } = fmtToolSizes(await $.tool.list(), rules, new Set([...hotTools(asHistory(await $.store.get('toolUse').catch(() => undefined))), ...usedNow]), real)
  const now = (breakdown?.categories ?? []).filter(c => c.tokens > 0 && c.kind !== 'free' && c.kind !== 'buffer').map(c => `${c.name} ${(c.tokens / 1000).toFixed(1)}k${c.isDeferred ? ' (deferred)' : ''}`)

  await $.fs.write(`${await claudeHome($)}/thriftquill/tools-report.md`, rows.map(r => `${r.deferred ? 'defer' : 'keep '} ${Math.round(r.tokens)}\t${r.name}${real.has(r.name) ? '' : '+'}`).join('\n')).catch(() => undefined)

  return { text: [now.length === 0 ? '' : `context now (engine's count): ${now.join(' · ')}`, text, 'A + after a size means an estimate from a description the tool list cuts at 300 characters: a lower bound.', 'Full list: thriftquill/tools-report.md'].filter(Boolean).join('\n') }
}

// ---- the Thriftquill pane (pane.tsx draws it; the engine wants each module's atom made where it is used)
const tqPaneState = atom({ plugin: 'thriftquill', key: 'pane' } as const, EMPTY_TQ_PANE, { shape: 'pane-1' })

const refreshSnaps = async ($: CoreEngineInterface): Promise<void> => {
  const snaps = (await snapshotsIn($)).map(x => ({ file: x.file, project: x.project, name: x.name, at: x.at }))

  await update($, tqPaneState, (s): TqPane => ({ ...s, snaps, loadedAt: Date.now() }))
}

const openTq = async ($: CoreEngineInterface, tab: TqTab): Promise<boolean> => {
  await update($, tqPaneState, (s): TqPane => ({ ...s, tab }))

  if (tab === 'snaps') {
    await refreshSnaps($)
  }

  return (await $.ui.open({ id: TQ_PANE_ID, title: 'Thriftquill' })).isPlaced
}

// A snapshot of the conversation as it stands, written in the background; the pane shows it working, then lists it.
const startSnapshot = async ($: CoreEngineInterface, jo: JanitorOptions, relay: Relay, name: string): Promise<string> => {
  const messages = (await $.session.messages().catch(() => [])) as unknown as SnapMessage[]
  const list = Array.isArray(messages) ? messages : []

  await update($, tqPaneState, (s): TqPane => ({ ...s, busy: `snapshot "${name}": summarizing ${list.length} message(s)…` }))

  $.clock.after(0, async () => {
    const line = await takeSnapshot($, jo, relay, list, name).catch(err => `snapshot failed — ${flat(String(err)).slice(0, 160)}`)

    await update($, tqPaneState, (s): TqPane => ({ ...s, busy: undefined }))
    await refreshSnaps($)
    await $.ui.toast(line.slice(0, 160))
  })

  return `snapshot "${name}" is being written (about half a minute); /snap shows it`
}

const TQ_REPORTS: Record<string, string> = { plan: 'Compaction plan', stats: 'Savings and cost', doctor: 'Health', trace: 'Trace', probe: 'Model check', tools: 'Tool sizes', suggest: 'Suggested tool rules' }

// A /janitor or /tools report drawn in the pane's Reports tab instead of the chat.
const reportInTq = async ($: CoreEngineInterface, live: JanitorLive, usedNow: ReadonlySet<string>, kind: string): Promise<{ placed: boolean; text: string }> => {
  const title = TQ_REPORTS[kind] ?? kind

  await update($, tqPaneState, (s): TqPane => ({ ...s, tab: 'report', busy: `${title}: working…` }))

  const placed = (await $.ui.open({ id: TQ_PANE_ID, title: 'Thriftquill' })).isPlaced
  const run = kind === 'tools' || kind === 'suggest' ? toolsCommand($, usedNow, kind === 'suggest' ? 'suggest' : '') : janitorCommand($, live, kind === 'plan' ? '' : kind)
  const text = await run.then(
    r => r.text ?? '',
    err => `failed — ${flat(String(err)).slice(0, 200)}`,
  )

  await update($, tqPaneState, (s): TqPane => ({ ...s, busy: undefined, report: { title, text, at: Date.now() } }))

  return { placed, text }
}

export const register: Register = (on, options) => {
  const jo = readOptions(options)
  const gate: Gate = { isForced: false }
  let turnStart: Snap | undefined
  let lastPrompt: string | undefined
  let spent: Spent = { five: 0, seven: 0 }
  let lastCall: number | undefined
  let stopTick: { cancel: () => void } | undefined
  let isIdleSignalled = false
  // A cold cache met a message before the idle timer ran: the compaction waits for that answer (the engine refuses one under the prompt hook).
  let coldOwed = false
  let pending: Pending | undefined
  // The snapshot /restore picked, attached to the person's next message.
  let restoreOwed: { file: string; doc: string } | undefined
  const warned = new Set<string>()
  const relay: Relay = { mcpDown: false, items: [] }
  // What /janitor doctor reads: which hooks ran this session.
  const fired = { compose: 0, submit: 0, complete: 0, attachment: 0, describe: 0, toolCall: 0, compact: 0, append: 0 }

  registerTqPane(on)

  on('prompt.compose', async ($, e, next) => {
    fired.compose++

    const composed = await next(e)
    const anchors = anchorsFor(jo, hasRelayRule(composed.sections))

    return anchors === undefined ? composed : { sections: [...composed.sections, anchors] }
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'janitor', description: 'Show what a compaction would archive; "run" compacts now; "trace" shows the log; "stats" what the mod saved and spent; "doctor" a health check; "probe" checks its model' })
    await $.command.register({ name: 'snap', description: 'Save a snapshot of this conversation to resume it later or in another chat: "/snap [name]"; "list"; "show N|name"' })
    await $.command.register({ name: 'restore', description: 'Attach a saved snapshot to your next message: "/restore" (newest of this project), "/restore N" or "/restore name"' })
    await $.command.register({ name: 'tools', description: 'Show tool description sizes and what tool-defer.txt would move behind ToolSearch; "suggest" proposes rules from the tools you use' })
    spent = { five: 0, seven: 0 }

    // How much tool schema is out of the prompt now: the engine's own tool search and these rules together.
    $.clock.after(25000, async () => {
      try {
        const u = await $.session.usage({ breakdown: 'summary' })

        noteSaving(
          'defer',
          (u.context.breakdown?.categories ?? []).filter(c => c.isDeferred).reduce((n, c) => n + c.tokens, 0),
          'engine tool search and rules together',
        )
      } catch {
        // no breakdown here: nothing to record
      }
    })

    // A compaction whose report was not shown yet (the mod was reloaded in between) is still owed.
    try {
      pending = await takePending($)

      if (pending !== undefined) {
        await trace($, 'pending: report of a compaction restored after a reload')
      }
    } catch {
      // the store is unreadable: nothing to restore
    }

    stopTick?.cancel()
    stopTick = $.clock.every(60000, async () => {
      // Silent for jo.idleMinutes with the cache still warm: a compaction now reads the context at the cached price and
      // the next prompt starts small; a cold restart would write the whole context again. Shadow mode only says so.
      if (!jo.ownTriggers || lastCall === undefined || isIdleSignalled || turnStart !== undefined || pending !== undefined) {
        return
      }

      const idle = Math.floor((Date.now() - lastCall) / 60000)

      if (idle < jo.idleMinutes) {
        return
      }

      isIdleSignalled = true

      const size = (await $.session.usage()).context.tokens ?? 0
      const cacheNote = idle < 60 ? `cache goes cold in ${60 - idle} min` : `cache is cold, silent for ${idle} min`
      const step = idleStep(idle, size, jo)

      if (step === 'none') {
        await trace($, `idle: ${cacheNote}, context ${k(size)} is under ${k(jo.idleMinTokens)}, nothing to do`)

        return
      }

      if (step === 'shadow') {
        await trace($, `idle: ${cacheNote}, context ${k(size)}: shadow, a compaction would run now`)
        $.ui.log(`janitor (shadow): ${cacheNote}; in active mode the ${k(size)} context would be compacted now`)

        return
      }

      await trace($, `idle: ${cacheNote}, context ${k(size)}: compacting ${idle < 60 ? 'while the cache is warm' : 'now, the next message starts small'}`)
      $.ui.log(`janitor: ${cacheNote}, context ${k(size)}: compacting${idle < 60 ? ', while the cache is warm' : ', the next message starts small'}`)
      gate.isForced = true
      $.clock.after(300, async () => {
        try {
          $.ui.log(`janitor: ${await compactNow($)}`)
        } catch (err) {
          gate.isForced = false
          $.ui.log(`janitor: failed — ${String(err).slice(0, 200)}`)
        }
      })
    })

    // A moment after the load, so the check does not hold the start: whether `$.mcp.call` reaches the service from here.
    // Three times, since a stdio server may need a while to connect. The first reading always gets a row (it says whose load it is,
    // several sessions write to one trace); the later ones only when the answer changed: a failure, or the first success after one.
    let wasOk: boolean | undefined
    for (const [i, ms] of [3000, 15000, 40000].entries()) {
      $.clock.after(ms, async () => {
        const reading = await probe($)
        const sid = (await $.session.id()).slice(0, 8)

        relay.mcpDown = !reading.ok

        if (i === 0) {
          await trace($, `load v${MOD_VERSION} mode=${jo.mode} sid=${sid}; selftest ${reading.ok ? 'ok' : `FAILED at +${ms / 1000}s: ${reading.text}`}`)
        } else if (!reading.ok || wasOk === false) {
          await trace($, `sid=${sid} selftest ${reading.ok ? `ok again at +${ms / 1000}s` : `FAILED at +${ms / 1000}s: ${reading.text}`}`)
        }

        wasOk = reading.ok

        if (!reading.ok && i === 0) {
          warnOnce($, warned, 'mcp', 'memory: the mod cannot reach the service; notes go through the model')
        }
      })
    }

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    fired.submit++

    const usageNow = await $.session.usage()

    turnStart = toSnap(usageNow)
    lastPrompt = e.text

    // How the shadow signal fared: the person is back, the cache is warm or went cold in the meantime.
    const gap = lastCall === undefined ? undefined : Math.floor((Date.now() - lastCall) / 60000)

    if (gap !== undefined && gap >= jo.idleMinutes) {
      await trace($, `idle: back after ${gap} min, cache ${gap >= 60 ? 'went cold' : 'still warm'}, context ${k(usageNow.context.tokens ?? 0)}, ${isIdleSignalled ? 'signal was sent' : 'no signal'}`)
    }

    // The idle timer did not reach a cold cache first (the process slept, or the mod reloaded): this answer runs on the
    // cold context, and the compaction follows it once the turn is over.
    if (gap !== undefined && gap >= 60 && !isIdleSignalled && idleStep(gap, usageNow.context.tokens ?? 0, jo) === 'compact') {
      coldOwed = true
    }

    isIdleSignalled = false
    lastCall = Date.now()

    const asks: string[] = relay.items.splice(0)

    if (pending !== undefined) {
      const p = pending

      pending = undefined
      await dropPending($).catch(() => undefined)

      // A service the mod cannot reach is told to the model in this very prompt; otherwise the store is the mod's own.
      if (relay.mcpDown && jo.isHandoff) {
        asks.push(HANDOFF_ASK)
      }

      $.clock.after(200, async () => {
        try {
          await reportCompaction($, jo, relay, p)
        } catch (err) {
          await trace($, `report failed: ${String(err).slice(0, 200)}`)
          $.ui.log(`janitor: compaction report not shown — ${String(err).slice(0, 120)}`)
        }
      })
    }

    const isPerson = e.origin.kind !== 'plugin' && e.origin.kind !== 'peer'
    const handed = isPerson ? relayBlock(asks) : undefined
    // A snapshot /restore picked goes with the person's next message.
    const restored = isPerson && restoreOwed !== undefined ? restoreBlock(restoreOwed.file, restoreOwed.doc) : undefined

    if (restored !== undefined) {
      await trace($, `restore: ${restoreOwed?.file} attached to the message`)
      restoreOwed = undefined
      await update($, tqPaneState, (st): TqPane => ({ ...st, restoreOwed: undefined }))
    }

    if (handed !== undefined) {
      await trace($, `relay: ${asks.length} item(s) handed to the model`)
    }

    const added = [restored, handed].filter((x): x is string => x !== undefined)

    return added.length === 0 ? next(e) : next({ ...e, context: [...(e.context ?? []), ...added] })
  })

  on('turn.complete', async ($, e, next) => {
    fired.complete++

    const usage = await $.session.usage()
    const now = toSnap(usage)
    const turn = { five: rise(turnStart?.five, now.five), seven: rise(turnStart?.seven, now.seven) }

    spent = { five: spent.five + (turn.five ?? 0), seven: spent.seven + (turn.seven ?? 0) }
    turnStart = undefined

    if (e.agentId === undefined) {
      lastCall = Date.now()
    }


    if (e.agentId === undefined) {
      if (turnSpend.calls > 0) {
        $.ui.log(fmtSpend(turnSpend), { to: 'debug' })
      }

      turnSpend = noSpend()
      await flushSpend($)
      await flushLedger($)
    }

    if (e.agentId === undefined && !e.isAborted) {
      const cold = coldOwed
      const step = cold ? 'compact' : decide(usage.context.tokens, jo, gate)

      coldOwed = false

      if (step !== 'none') {
        gate.lastAttemptTokens = usage.context.tokens

        try {
          if (step === 'shadow') {
            const messages = await $.session.messages()

            $.ui.log(
              describePlan(planStubs(Array.isArray(messages) ? messages : [], jo, await archiveDir($)), usage.context.tokens) +
                ' (shadow mode, nothing changed)',
            )
          } else {
            if (cold) {
              gate.isForced = true
            }

            $.ui.log(
              cold
                ? `janitor: cache went cold before this answer, context ${k(usage.context.tokens ?? 0)}: compacting after the answer`
                : `janitor: context ${k(usage.context.tokens ?? 0)} ≥ threshold ${k(jo.thresholdTokens)}, starting a compaction`,
            )
            // Raised a moment after the turn is over: a compaction under a hook the turn waits on is refused.
            $.clock.after(500, async () => {
              try {
                $.ui.log(`janitor: ${await compactNow($)}`)
              } catch (err) {
                $.ui.log(`janitor: failed — ${String(err).slice(0, 200)}`)
              }
            })
          }
        } catch (err) {
          $.ui.log(`janitor failed: ${String(err).slice(0, 160)}`)
        }
      }
    }

    return next(e)
  })

  const seen = new Map<string, Seen>()
  const seenBy = (agentId?: string) => {
    const key = agentId ?? 'main'
    const s = seen.get(key) ?? { skills: new Set<string>(), tools: new Set<string>() }

    seen.set(key, s)

    return s
  }

  on('prompt.attachment', { type: 'skill_listing' }, async ($, e, next) => {
    fired.attachment++

    const text = dedupeSkills(e.text, seenBy(e.agentId).skills)

    if (text !== e.text) {
      noteSaving('dedup', (e.text.length - (text?.length ?? 0)) / 4, 'skill listing')
      $.ui.log(`dedup: skill listing not resent, saved ≈ ${Math.round((e.text.length - (text?.length ?? 0)) / 4000)}k tokens`, { to: 'debug' })
    }

    return text === null ? { text: null } : next(text === e.text ? e : { ...e, text })
  })

  on('prompt.attachment', { type: 'deferred_tools_delta' }, async ($, e, next) => {
    fired.attachment++

    const prefixes = (await $.fs.read(`${await claudeHome($)}/thriftquill/hide-tools.txt`).catch(() => ''))
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.startsWith('mcp__'))
    const shown = hideTools(e.text, prefixes)

    if (shown !== e.text) {
      await trace($, `catalog: hid ${e.text.split('\n').length - shown.split('\n').length} lines of the deferred-tools notice (${prefixes.join(' ')})`)
      e = { ...e, text: shown }
    }

    const text = dedupeDeferred(e.text, seenBy(e.agentId).tools)

    if (text !== e.text) {
      noteSaving('dedup', (e.text.length - (text?.length ?? 0)) / 4, 'deferred tool names')
      $.ui.log(`dedup: deferred tool names not resent, saved ≈ ${Math.round((e.text.length - (text?.length ?? 0)) / 4000)}k tokens`, { to: 'debug' })
    }

    return text === null ? { text: null } : next(text === e.text ? e : { ...e, text })
  })

  // Tool compression (see parseDeferRules). Usage per session is kept in the store: the pool adapts to what is called.
  let usedNow = new Set<string>()
  // The engine asks for every tool once per session (about five hundred with many MCP servers): the rules file and the history
  // are read once, the rules again after half a minute, so an edit of the file is picked up without a read per tool.
  let rulesLoad: Promise<DeferRules> | undefined
  let rulesAt = 0
  let hotLoad: Promise<Set<string>> | undefined

  on('tool.describe', async ($, e, next) => {
    fired.describe++

    if (rulesLoad === undefined || Date.now() - rulesAt > 30000) {
      rulesAt = Date.now()
      rulesLoad = $.fs
        .read(`${await claudeHome($)}/thriftquill/tool-defer.txt`)
        .catch(() => '')
        .then(parseDeferRules)
    }

    // The tools of earlier sessions only: what is called now is recorded for the next session, it never moves a tool now.
    hotLoad ??= $.store
      .get('toolUse')
      .catch(() => undefined)
      .then(h => new Set(hotTools(asHistory(h))))

    const placement = deferralFor(e.tool, await rulesLoad, await hotLoad)
    const out = await next(e)

    return placement === undefined ? out : { ...out, isDeferred: placement }
  })

  // A tool result longer than the cap keeps its start and its end, and the whole text goes to a file. In shadow mode the trace
  // only says what would be cut. An error result is never touched.
  on('session.append', { door: 'tool-result' }, async ($, e, next) => {
    fired.append++

    if (jo.outputMode === 'off') {
      return next(e)
    }

    const items = planShape(e.message.content, jo.outputCapChars)

    if (items.length === 0) {
      return next(e)
    }

    const tool = e.origin.kind === 'tool' ? e.origin.tool : 'unknown'
    const cut = charsCut(items, jo.outputCapChars)

    if (jo.outputMode === 'shadow') {
      await trace($, `shape (shadow): ${tool} result of ${items.map(i => i.text.length).join('+')} chars would be cut by about ${k(cut / 4)} tokens`)

      return next(e)
    }

    const paths = new Map<string, string>()
    let shaped: typeof e.message.content | undefined

    try {
      const dir = await archiveDir($)

      for (const item of items) {
        const path = archivePath(dir, item.id, 'result')

        await $.fs.write(path, item.text)
        paths.set(item.id, path)
      }

      shaped = applyShape(e.message.content, items, jo.outputCapChars, i => paths.get(i.id) ?? '')
    } catch (err) {
      await trace($, `shape: archive failed, the result stays whole: ${String(err).slice(0, 120)}`)
    }

    if (shaped === undefined) {
      return next(e)
    }

    noteSaving('shape', cut / 4, tool)
    await trace($, `shape: ${tool} result cut by about ${k(cut / 4)} tokens, whole text in ${[...paths.values()].join(', ')}`)

    return next({ ...e, message: { ...e.message, content: shaped } })
  })

  on('tool.call', async ($, e, next) => {
    fired.toolCall++

    if (!usedNow.has(e.tool)) {
      usedNow = new Set([...usedNow, e.tool])

      const history = asHistory(await $.store.get('toolUse').catch(() => undefined))

      const sid = await $.session.id()

      await $.store.set('toolUse', [...history.filter(h => h[0] !== sid).slice(-(HOT_WINDOW * 3)), [sid, ...usedNow]]).catch(() => undefined)
    }

    return next(e)
  })

  // Before the engine summarizes: the big outputs older than the last few messages go to disk and are replaced by
  // one-line stubs, so the summary is cheaper and points at where the full text lives. Shadow mode touches nothing.
  // After any real compaction the model has forgotten what it was told: the engine announces the catalogs again.

  on('session.compact', async ($, e, next) => {
    fired.compact++

    if (e.trigger === 'precompute' || e.agentId !== undefined) {
      return next(e)
    }

    // What the summary is about to drop is kept as a snapshot first: written in the background, the compaction does not wait.
    if (jo.snapshotOnCompact && e.messages.length >= 4) {
      const before = e.messages

      $.clock.after(0, async () => {
        const line = await takeSnapshot($, jo, relay, before, `before-compact-${e.trigger}`).catch(err => `snapshot before the compaction failed — ${flat(String(err)).slice(0, 160)}`)

        await refreshSnaps($)
        await $.ui.toast(line.slice(0, 160))
      })
    }

    const isActive = jo.mode === 'active' || gate.isForced

    gate.isForced = false
    await trace($, `compact: trigger=${e.trigger} stubs=${isActive ? 'on' : 'off (shadow)'} messages=${e.messages.length}`)

    let prepared: { messages: typeof e.messages; saved: number; count: number } | undefined

    if (isActive) {
      try {
        const dir = await archiveDir($)
        const plan = planStubs(e.messages, jo, dir)

        await Promise.all(plan.archives.map(a => $.fs.write(archivePath(dir, a.id, a.field), a.text)))
        prepared = { messages: plan.messages, saved: plan.savedTokens, count: plan.archives.length }
        await trace($, `compact: archived ${plan.archives.length} fragments, summary input cut ≈${k(plan.savedTokens)} tokens`)
      } catch (err) {
        await trace($, `compact: archive failed, plain compaction: ${String(err).slice(0, 200)}`)
        $.ui.log(`janitor: archive not written (${String(err).slice(0, 120)}), plain compaction`)
      }
    }

    // From here the report is owed whatever the engine does with the call.
    const owed: Pending = { trigger: `${e.trigger}${isActive ? '' : ', shadow mode'}`, archived: prepared?.count ?? 0, saved: prepared?.saved ?? 0 }

    pending = owed
    await keepPending($, owed).catch(() => undefined)

    // Hybrid: when the stubs alone take enough off the context, the conversation is kept as it is, stubs in it, and no summary is made.
    // A /compact the person typed asks for a summary: it always gets one.
    if (prepared !== undefined && e.trigger !== 'manual' && (e.instructions ?? '') === '') {
      const before = (await $.session.usage()).context.tokens

      if (maskDecision(before, prepared.saved, jo) === 'mask') {
        const after = before === undefined ? undefined : Math.max(0, before - prepared.saved)

        pending = { ...owed, before, after, masked: true }
        await keepPending($, pending).catch(() => undefined)
        await trace($, `compact: hybrid, kept the conversation with ${prepared.count} stubs (about ${k(prepared.saved)} tokens), no summary`)

        gate.lastAttemptTokens = after
        noteSaving('stub', prepared.saved, 'hybrid, no summary')

        return { messages: prepared.messages, tokensBefore: before, tokensAfter: after }
      }
    }

    const input =
      prepared === undefined
        ? isActive
          ? { ...e, instructions: instructionsFor(e.instructions) }
          : e
        : { ...e, messages: prepared.messages, instructions: instructionsFor(e.instructions) }

    const usageBefore = await $.session.usage().then(toSnap, () => undefined)
    let done: Awaited<ReturnType<typeof next>>

    try {
      done = await next(input)
    } catch (err) {
      await trace($, `compact: next() threw: ${String(err).slice(0, 300)}`)
      throw err
    }

    await trace($, `compact: next returned skip=${done.skip ?? 'no'} before=${('tokensBefore' in done ? done.tokensBefore : undefined) ?? '?'} after=${('tokensAfter' in done ? done.tokensAfter : undefined) ?? '?'} messages=${done.messages?.length ?? '?'}`)

    if (done.skip !== undefined) {
      pending = undefined
      await dropPending($).catch(() => undefined)

      return done
    }

    if (prepared !== undefined) {
      noteSaving('stub', prepared.saved, `${prepared.count} fragments`)
    }

    seen.delete('main')
    gate.lastAttemptTokens = done.tokensAfter
    // What the compaction itself cost the windows, counted into the running total like an answer.
    const usageAfter = await $.session.usage().then(toSnap, () => undefined)
    const cost = { five: rise(usageBefore?.five, usageAfter?.five), seven: rise(usageBefore?.seven, usageAfter?.seven) }

    spent = { five: spent.five + (cost.five ?? 0), seven: spent.seven + (cost.seven ?? 0) }
    pending = { ...owed, before: done.tokensBefore, after: done.tokensAfter, summary: summaryOf(done.messages), usageLine: fmtTurn(cost, spent) }
    await keepPending($, pending).catch(() => undefined)

    return done
  })

  on('command.run', { command: 'janitor' }, async ($, e) => {
    const args = e.args.trim()
    const kind = args === '' ? 'plan' : args

    if (['plan', 'stats', 'doctor', 'trace', 'probe'].includes(kind)) {
      const { placed, text } = await reportInTq($, { jo, gate, relay, fired }, usedNow, kind)

      return placed ? {} : { text }
    }

    return janitorCommand($, { jo, gate, relay, fired }, e.args)
  })

  on('session.end', async ($, e, next) => {
    stopTick?.cancel()
    stopTick = undefined
    seen.clear()

    return next(e)
  })

  // "/snap" opens the pane (the snapshots with Restore and View); "/snap <name>" takes one; "list" and "show" open the pane.
  on('command.run', { command: 'snap' }, async ($, e) => {
    const a = parseSnapArgs(e.args)

    if (a.kind === 'take' && a.name !== '') {
      return { text: await startSnapshot($, jo, relay, a.name) }
    }

    if (a.kind === 'show') {
      const pick = pickSnapshot(await snapshotsIn($), a.target, await projectHere($))

      if (pick !== undefined) {
        const text = await $.fs.read(`${await snapshotDir($)}/${pick.file}`).catch(() => '')

        await update($, tqPaneState, (s): TqPane => ({ ...s, preview: { file: pick.file, text } }))
      }
    }

    const placed = await openTq($, 'snaps')

    if (placed) {
      return {}
    }

    // No pane on this surface: the list as text.
    const entries = await snapshotsIn($)

    return {
      text: entries.length === 0 ? 'no snapshots yet: /snap <name> takes one' : [...entries.slice(0, 15).map((x, i) => `${i + 1}. ${x.at} · ${x.project} · ${x.name}`), '/restore N attaches one to your next message'].join('\n'),
    }
  })

  // The pane's buttons: the key says what to do ("verb:arg"); the press is taken here, nothing reaches the chat.
  on('ui.press', async ($, e, next) => {
    if (e.plugin !== 'thriftquill') {
      return next(e)
    }

    const { verb, arg } = pressOf(e.element)

    if (verb === 'tab') {
      await openTq($, arg === 'report' ? 'report' : 'snaps')
    } else if (verb === 'take') {
      await $.ui.toast(await startSnapshot($, jo, relay, 'manual'))
    } else if (verb === 'refresh') {
      await refreshSnaps($)
    } else if (verb === 'restore') {
      const doc = await $.fs.read(`${await snapshotDir($)}/${arg}`).catch(() => '')

      if (doc === '') {
        await $.ui.toast('that snapshot could not be read')
      } else {
        restoreOwed = { file: arg, doc }
        await update($, tqPaneState, (s): TqPane => ({ ...s, restoreOwed: arg }))
        await $.ui.toast('the snapshot goes with your next message')
      }
    } else if (verb === 'unrestore') {
      restoreOwed = undefined
      await update($, tqPaneState, (s): TqPane => ({ ...s, restoreOwed: undefined }))
    } else if (verb === 'view') {
      const st = await read($, tqPaneState)

      if (st.preview?.file === arg) {
        await update($, tqPaneState, (s): TqPane => ({ ...s, preview: undefined }))
      } else {
        const text = await $.fs.read(`${await snapshotDir($)}/${arg}`).catch(() => 'could not be read')

        await update($, tqPaneState, (s): TqPane => ({ ...s, preview: { file: arg, text } }))
      }
    } else if (verb === 'report') {
      await reportInTq($, { jo, gate, relay, fired }, usedNow, arg)
    } else {
      return next(e)
    }

    return { element: e.element }
  })

  // The pane's field: a name for a new snapshot.
  on('ui.input', async ($, e, next) => {
    if (e.plugin !== 'thriftquill' || e.kind !== 'submit' || e.element !== 'snapname') {
      return next(e)
    }

    await $.ui.toast(await startSnapshot($, jo, relay, e.value.trim() === '' ? 'manual' : e.value.trim()))

    return { element: e.element, value: '' }
  })

  on('command.run', { command: 'restore' }, async ($, e) => {
    const entries = await snapshotsIn($)
    const pick = pickSnapshot(entries, e.args, await projectHere($))

    if (pick === undefined) {
      return { text: entries.length === 0 ? 'no snapshots yet: /snap [name] takes one' : `no snapshot matches "${e.args.trim()}"; /snap list` }
    }

    const doc = await $.fs.read(`${await snapshotDir($)}/${pick.file}`).catch(() => '')

    if (doc === '') {
      return { text: `snapshot ${pick.file} could not be read` }
    }

    restoreOwed = { file: pick.file, doc }
    await update($, tqPaneState, (st): TqPane => ({ ...st, restoreOwed: pick.file }))

    return { text: `snapshot ${pick.file} (~${k(tokens(doc.length))} tok) will go with your next message; write what to do with it, e.g. "continue from the snapshot"` }
  })

  on('command.run', { command: 'tools' }, async ($, e) => {
    const { placed, text } = await reportInTq($, { jo, gate, relay, fired }, usedNow, e.args.trim() === 'suggest' ? 'suggest' : 'tools')

    return placed ? {} : { text }
  })


}
