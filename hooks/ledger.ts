// What the mod saved, in tokens, one row per event: the other half of overhead.jsonl, which holds what the mod spent.
// Only what the mod itself caused is added up. 'stub' is the compaction input it cut, 'dedup' the repeated listings it did
// not resend. 'defer' is how much tool schema is out of the prompt at session start; the engine's own tool search is in
// that figure too, so it is shown on its own and never added to the total.
export type LedgerKind = 'stub' | 'dedup' | 'shape' | 'defer'

export type LedgerRow = { t: string; kind: LedgerKind; tokens: number; note?: string }

export const LEDGER_ROWS = 5000

export const ledgerRow = (kind: LedgerKind, tokens: number, now: Date, note?: string): LedgerRow => ({
  t: `${now.toISOString().slice(0, 19)}Z`,
  kind,
  tokens: Math.max(0, Math.round(tokens)),
  ...(note === undefined ? {} : { note }),
})

export type Saved = { stub: number; dedup: number; shape: number; total: number }

export type LedgerSummary = { today: Saved; week: Saved; deferred?: number }

const dayOf = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`

const none = (): Saved => ({ stub: 0, dedup: 0, shape: 0, total: 0 })

// The file's rows read back: today (the local day) and the last seven days; `deferred` is the latest reading of the day.
export const summarizeLedger = (lines: readonly string[], now: Date): LedgerSummary => {
  const out: LedgerSummary = { today: none(), week: none() }
  let latest = -Infinity

  for (const line of lines) {
    let row: LedgerRow

    try {
      row = JSON.parse(line) as LedgerRow
    } catch {
      continue
    }

    if (row === null || typeof row !== 'object') {
      continue
    }

    const when = new Date(row.t)
    const age = now.getTime() - when.getTime()

    if (Number.isNaN(age) || age < 0 || age > 7 * 86400000 || typeof row.tokens !== 'number') {
      continue
    }

    const isToday = dayOf(when) === dayOf(now)

    if (row.kind === 'defer') {
      if (isToday && when.getTime() >= latest) {
        latest = when.getTime()
        out.deferred = row.tokens
      }

      continue
    }

    if (row.kind !== 'stub' && row.kind !== 'dedup' && row.kind !== 'shape') {
      continue
    }

    for (const bucket of isToday ? [out.week, out.today] : [out.week]) {
      bucket[row.kind] += row.tokens
      bucket.total += row.tokens
    }
  }

  return out
}

const k = (n: number) => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(Math.round(n)))

export const fmtSaved = (s: Saved) => `${k(s.total)} (compaction input cut ${k(s.stub)} · listings not resent ${k(s.dedup)} · big results cut ${k(s.shape)})`
