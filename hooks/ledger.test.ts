import { expect, test } from 'claude-code/testing'

import { fmtSaved, ledgerRow, summarizeLedger } from './ledger'

const NOW = new Date('2026-11-08T12:00:00Z')
const row = (iso: string, kind: string, tokens: number) => JSON.stringify({ t: iso, kind, tokens })

test('ledgerRow rounds, never goes negative and keeps the note only when given', () => {
  expect(ledgerRow('stub', 1234.6, NOW, 'x')).toEqual({ t: '2026-11-08T12:00:00Z', kind: 'stub', tokens: 1235, note: 'x' })
  expect(ledgerRow('dedup', -5, NOW)).toEqual({ t: '2026-11-08T12:00:00Z', kind: 'dedup', tokens: 0 })
})

test('summarizeLedger adds up today and the week, keeps defer apart, skips bad and old rows', () => {
  const lines = [
    row('2026-11-08T10:00:00Z', 'stub', 70000),
    row('2026-11-08T11:00:00Z', 'dedup', 3000),
    row('2026-11-05T11:00:00Z', 'stub', 10000),
    row('2026-10-01T11:00:00Z', 'stub', 999999),
    row('2026-11-08T09:00:00Z', 'defer', 15000),
    row('2026-11-08T11:30:00Z', 'defer', 20000),
    'not json',
    'null',
    JSON.stringify({ t: 'garbage', kind: 'stub', tokens: 5 }),
    JSON.stringify({ t: '2026-11-08T10:00:00Z', kind: 'other', tokens: 5 }),
  ]
  const s = summarizeLedger(lines, NOW)

  expect(s.today).toEqual({ stub: 70000, dedup: 3000, shape: 0, total: 73000 })
  expect(s.week).toEqual({ stub: 80000, dedup: 3000, shape: 0, total: 83000 })
  expect(s.deferred).toEqual(20000)
  expect(fmtSaved(s.today)).toContain('73k')
})
