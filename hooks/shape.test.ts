import { expect, test } from 'claude-code/testing'

import { applyShape, charsCut, cutText, planShape, textOfResult } from './shape'
import type { Block } from './shape'

const big = (n: number) => `${'a'.repeat(n - 10)}0123456789`

test('textOfResult reads a string and text blocks, and refuses anything else', () => {
  expect(textOfResult({ type: 'tool_result', content: 'abc' })).toEqual('abc')
  expect(textOfResult({ type: 'tool_result', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })).toEqual('a\nb')
  expect(textOfResult({ type: 'tool_result', content: [{ type: 'text', text: 'a' }, { type: 'image', source: {} }] })).toEqual(undefined)
  expect(textOfResult({ type: 'tool_result' })).toEqual(undefined)
})

test('planShape picks results over the cap and leaves errors, small results and other blocks alone', () => {
  const blocks: Block[] = [
    { type: 'text', text: big(50000) },
    { type: 'tool_result', tool_use_id: 't1', content: big(50000) },
    { type: 'tool_result', tool_use_id: 't2', content: big(50000), is_error: true },
    { type: 'tool_result', tool_use_id: 't3', content: big(500) },
    { type: 'tool_result', tool_use_id: 't4', content: [{ type: 'text', text: big(40000) }] },
    { type: 'tool_result', tool_use_id: 't5', content: [{ type: 'image', source: {} }] },
  ]
  const plan = planShape(blocks, 30000)

  expect(plan.map(p => [p.index, p.id])).toEqual([[1, 't1'], [4, 't4']])
})

test('cutText keeps the start and the end within the cap and names the file', () => {
  const text = `START${'x'.repeat(100000)}END`
  const cut = cutText(text, 30000, 'C:/a/b.txt')

  expect(cut.startsWith('START')).toEqual(true)
  expect(cut.endsWith('END')).toEqual(true)
  expect(cut).toContain('C:/a/b.txt')
  expect(cut.length).toBeLessThan(30000)
  expect(cut).toContain(`${text.length - 18000 - 7500} characters left out`)
})

test('applyShape keeps the form of each result and the blocks that are not planned', () => {
  const blocks: Block[] = [
    { type: 'tool_result', tool_use_id: 't1', content: big(50000) },
    { type: 'tool_result', tool_use_id: 't4', content: [{ type: 'text', text: big(40000) }] },
    { type: 'tool_result', tool_use_id: 't3', content: 'small' },
  ]
  const plan = planShape(blocks, 30000)
  const out = applyShape(blocks, plan, 30000, i => `P/${i.id}`)

  expect(typeof out[0]?.content).toEqual('string')
  expect(Array.isArray(out[1]?.content)).toEqual(true)
  expect(String((out[0]?.content as string).includes('P/t1'))).toEqual('true')
  expect(out[2]).toEqual(blocks[2])
  expect(out[0]?.tool_use_id).toEqual('t1')
  expect(charsCut(plan, 30000)).toEqual(plan.reduce((n, i) => n + i.text.length - cutText(i.text, 30000, '').length, 0))
  expect(charsCut(plan, 30000)).toBeGreaterThan(50000 + 40000 - 2 * 25500 - 400)
  expect(charsCut(plan, 30000)).toBeLessThan(50000 + 40000 - 2 * 25500)
})
