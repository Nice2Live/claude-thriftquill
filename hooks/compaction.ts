import { clipHead } from './text'

// Compaction by the small model, and the measurement that says whether it is worth it. Pure helpers; the session.compact
// hook in register.ts calls the model, writes the files and the rows.

// ---- what a model costs: $ per million tokens, the Anthropic list prices of 2026-11-03. A cache write (5 minutes) costs
// 1.25 × input; Haiku 5.5 costs five times more for a prompt over 100K tokens.
export type Price = { input: number; output: number; cacheRead: number; cacheWrite: number }

const PRICES: Record<string, Price> = {
  'claude-fable-5-2': { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
}

const HAIKU_LONG: Price = { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }

export type Usage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }

// "claude-opus-5-5[1m]" and the like are the same model for the price.
export const modelKey = (model: string): string => model.replace(/\[[^\]]*\]$/, '').trim()

export const priceOf = (model: string, promptTokens: number): Price | undefined => {
  const key = modelKey(model)

  return key === 'claude-haiku-5-5' && promptTokens > 100000 ? HAIKU_LONG : PRICES[key]
}

// What one request cost in $, or undefined for a model the table does not know.
export const costOf = (usage: Usage | undefined, model: string): number | undefined => {
  if (usage === undefined) {
    return undefined
  }

  const input = usage.input_tokens ?? 0
  const read = usage.cache_read_input_tokens ?? 0
  const write = usage.cache_creation_input_tokens ?? 0
  const p = priceOf(model, input + read + write)

  return p === undefined ? undefined : (input * p.input + read * p.cacheRead + write * p.cacheWrite + (usage.output_tokens ?? 0) * p.output) / 1e6
}

// ---- where the kept tail starts: the last `keep` messages, moved back to a message of the person's that carries no tool
// results, so no tool result is kept whose call went into the summary.
export type Msg = { role: string; text: string; toolUses?: readonly unknown[]; toolResults?: readonly unknown[] }

export const keepFrom = (messages: readonly Msg[], keep: number): number => {
  let i = Math.max(0, messages.length - keep)

  while (i > 0 && !(messages[i]?.role === 'user' && (messages[i]?.toolResults ?? []).length === 0)) {
    i--
  }

  return i
}

// ---- how much of what matters a summary kept: the share of the transcript's key terms (file names, `code spans`) it names.
const FILE = /[\w.-]+\.(?:ts|tsx|js|jsx|mjs|json|md|py|cs|lua|xml|ya?ml|toml|txt|sql|sh|ps1|go|rs|java|kt|cpp|h)\b/g

const CODE = /`([^`\n]{3,60})`/g

export const keyTerms = (text: string, max = 150): string[] => {
  const counts = new Map<string, number>()

  for (const m of text.matchAll(FILE)) {
    counts.set(m[0], (counts.get(m[0]) ?? 0) + 1)
  }

  for (const m of text.matchAll(CODE)) {
    const t = m[1]!.trim()

    if (t.length >= 3) {
      counts.set(t, (counts.get(t) ?? 0) + 1)
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([t]) => t)
}

export const coverage = (terms: readonly string[], summary: string): number | undefined => {
  if (terms.length === 0) {
    return undefined
  }

  const low = summary.toLowerCase()

  return terms.filter(t => low.includes(t.toLowerCase())).length / terms.length
}

// ---- the small model's summary
export const SMALL_COMPACT_SYSTEM = [
  'You compact a long conversation between a user and a coding assistant. The assistant will continue the work with your summary and the last few messages only, so it must not lose anything it needs.',
  'Write these sections: 1. Primary request and intent (all of the user\'s explicit requests, in order). 2. Key technical concepts. 3. Files and code sections (each file touched or read, why, and the important snippets or changes). 4. Errors and fixes (each error met, how it was fixed, and any feedback of the user on it). 5. Problem solving (what was solved, what is still being worked out). 6. All user messages that are not tool results, in order, close to their words. 7. Pending tasks. 8. Current work (exactly what was being done right before this summary, with file names and code). 9. Next step (only one that follows directly from the latest requests; quote the latest request where it helps).',
  'Keep names, paths, identifiers, commands, numbers and error messages exactly. Keep the language the user writes in for their messages; write the rest in English. No preamble.',
].join(' ')

export const SUMMARY_PREFACE =
  'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation (written by the small model).\n\nSummary:\n'

// The summary as the user message the engine would put first.
export const summaryMessage = (summary: string) => ({ role: 'user' as const, text: `${SUMMARY_PREFACE}${summary.trim()}`, toolUses: [] })

// ---- one measured compaction
export type CompactionRow = {
  t: string
  trigger: string
  mode: 'compare' | 'small'
  model: string // the session's
  messages: number
  engine?: { usage?: Usage; cost?: number; chars: number; coverage?: number; limit5h?: number }
  small?: { usage?: Usage; cost?: number; chars: number; coverage?: number; seconds: number; inputChars: number }
  files?: { engine?: string; small?: string }
}

const usd = (x: number | undefined) => (x === undefined ? '?' : x < 0.01 ? `$${x.toFixed(4)}` : `$${x.toFixed(3)}`)

const pct = (x: number | undefined) => (x === undefined ? '–' : `${Math.round(x * 100)}%`)

const tok = (u: Usage | undefined) =>
  u === undefined
    ? '?'
    : `in ${Math.round((u.input_tokens ?? 0) / 1000)}k · cache ${Math.round((u.cache_read_input_tokens ?? 0) / 1000)}k · write ${Math.round((u.cache_creation_input_tokens ?? 0) / 1000)}k · out ${Math.round((u.output_tokens ?? 0) / 1000)}k`

export const parseRows = (lines: readonly string[]): CompactionRow[] =>
  lines.flatMap(l => {
    try {
      const r = JSON.parse(l) as CompactionRow

      return typeof r === 'object' && r !== null && typeof r.t === 'string' ? [r] : []
    } catch {
      return []
    }
  })

// The report: each measured compaction, then the totals of those with both sides measured.
export const compactionReport = (rows: readonly CompactionRow[]): string => {
  if (rows.length === 0) {
    return 'No compaction measured yet. Set "Compaction model" to compare: every compaction then runs as usual, and the small model writes its own summary of the same conversation on the side, for cost and coverage.'
  }

  const lines = rows.slice(-12).flatMap(r => [
    `${r.t.slice(0, 16).replace('T', ' ')} · ${r.trigger} · ${r.mode} · ${r.messages} messages · session model ${r.model}`,
    ...(r.engine === undefined ? [] : [`  engine: ${usd(r.engine.cost)} (${tok(r.engine.usage)}) · summary ${r.engine.chars} chars · key terms ${pct(r.engine.coverage)}${r.engine.limit5h === undefined ? '' : ` · 5h limit +${r.engine.limit5h.toFixed(1)}%`}`]),
    ...(r.small === undefined ? [] : [`  small:  ${usd(r.small.cost)} (${tok(r.small.usage)}) · summary ${r.small.chars} chars · key terms ${pct(r.small.coverage)} · ${r.small.seconds.toFixed(0)} s · read ${Math.round(r.small.inputChars / 1000)}k chars`]),
    ...(r.files === undefined ? [] : [`  files: ${[r.files.engine, r.files.small].filter(Boolean).join(' | ')}`]),
  ])
  const both = rows.filter(r => r.engine?.cost !== undefined && r.small?.cost !== undefined)
  const sum = (f: (r: CompactionRow) => number | undefined) => both.reduce((n, r) => n + (f(r) ?? 0), 0)
  const avg = (f: (r: CompactionRow) => number | undefined) => {
    const xs = both.map(f).filter((x): x is number => x !== undefined)

    return xs.length === 0 ? undefined : xs.reduce((a, b) => a + b, 0) / xs.length
  }
  const totals =
    both.length === 0
      ? []
      : [
          '',
          `Both measured: ${both.length} compaction(s). Engine ${usd(sum(r => r.engine?.cost))}, small ${usd(sum(r => r.small?.cost))} (${Math.round((sum(r => r.small?.cost) / Math.max(1e-9, sum(r => r.engine?.cost))) * 100)}% of the engine's).`,
          `Key terms kept, on average: engine ${pct(avg(r => r.engine?.coverage))}, small ${pct(avg(r => r.small?.coverage))}. Read both summaries side by side before switching: the terms are a rough proxy.`,
        ]

  return [...lines, ...totals].join('\n')
}

// The transcript the small model reads stays under Haiku's 100K-token price step (about 4 characters a token).
export const SMALL_INPUT_CHARS = 300000

export const clipSummary = (text: string) => clipHead(text.trim(), 60000)
