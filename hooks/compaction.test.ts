import { expect, test } from 'claude-code/testing'

import { compactionReport, costOf, coverage, keepFrom, keyTerms, modelKey, summaryMessage } from './compaction'

test('costOf prices a cached Opus request and Haiku on both sides of its 100K step', () => {
  // 300k read from cache, 2k fresh, 5k written: 0.3×0.2 + 0.002×4 + 0.005×5 + 0.008×20 = 0.253
  expect(Math.round((costOf({ input_tokens: 2000, cache_read_input_tokens: 300000, cache_creation_input_tokens: 5000, output_tokens: 8000 }, 'claude-opus-5-5[1m]') ?? NaN) * 1e6)).toBe(Math.round((0.253) * 1e6))
  expect(Math.round((costOf({ input_tokens: 80000, output_tokens: 6000 }, 'claude-haiku-5-5') ?? NaN) * 1e6)).toBe(Math.round((0.008 + 0.003) * 1e6))
  expect(Math.round((costOf({ input_tokens: 120000, output_tokens: 6000 }, 'claude-haiku-5-5') ?? NaN) * 1e6)).toBe(Math.round((0.06 + 0.015) * 1e6))
  expect(costOf({ input_tokens: 1 }, 'some-unknown-model')).toBeUndefined()
  expect(costOf(undefined, 'claude-opus-5-5')).toBeUndefined()
  expect(modelKey('claude-opus-5-5[1m]')).toBe('claude-opus-5-5')
})

test('keepFrom starts the kept tail at a message of the person with no tool results', () => {
  const m = (role: string, results = 0) => ({ role, text: role, toolResults: Array.from({ length: results }, () => ({})) })
  const conv = [m('user'), m('assistant'), m('user'), m('assistant'), m('user', 1), m('assistant'), m('user', 1), m('assistant')]

  expect(keepFrom(conv, 3)).toBe(2)
  expect(keepFrom(conv, 6)).toBe(2)
  expect(keepFrom(conv, 100)).toBe(0)
})

test('keyTerms takes file names and code spans; coverage is the share a summary names', () => {
  const t = 'edited hooks/register.ts and `takeSnapshot`, then register.ts again and `restoreBlock` and notes.md'
  const terms = keyTerms(t)

  expect(terms[0]).toBe('register.ts')
  expect(terms).toContain('takeSnapshot')
  expect(terms).toContain('notes.md')
  expect(Math.round((coverage(terms, 'We changed register.ts and takeSnapshot.') ?? NaN) * 1e6)).toBe(Math.round((2 / terms.length) * 1e6))
  expect(coverage([], 'x')).toBeUndefined()
})

test('the report says how to start measuring, then compares both sides', () => {
  expect(compactionReport([])).toContain('compare')

  const text = compactionReport([
    {
      t: '2026-11-25T18:00:00Z',
      trigger: 'auto',
      mode: 'compare',
      model: 'claude-opus-5-5',
      messages: 300,
      engine: { cost: 0.25, chars: 9000, coverage: 0.6 },
      small: { cost: 0.01, chars: 7000, coverage: 0.45, seconds: 40, inputChars: 290000 },
    },
  ])

  expect(text).toContain('Engine $0.250, small $0.010 (4% of the engine')
  expect(text).toContain('engine 60%, small 45%')
  expect(summaryMessage('x'.repeat(600)).text.startsWith('This session is being continued')).toBe(true)
})
