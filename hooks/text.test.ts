import { expect, test } from 'claude-code/testing'

import { clipHead, clipTail } from './text'

const EMOJI = '😀' // one character made of two UTF-16 code units

test('clipHead never ends in the middle of a surrogate pair', () => {
  expect(clipHead('abc', 2)).toEqual('ab')
  expect(clipHead(`ab${EMOJI}cd`, 3)).toEqual('ab')
  expect(clipHead(`ab${EMOJI}cd`, 4)).toEqual(`ab${EMOJI}`)
  expect(clipHead('abc', 0)).toEqual('')
  expect(clipHead('abc', 99)).toEqual('abc')
})

test('clipTail never starts in the middle of a surrogate pair', () => {
  expect(clipTail('abc', 2)).toEqual('bc')
  expect(clipTail(`ab${EMOJI}cd`, 3)).toEqual('cd')
  expect(clipTail(`ab${EMOJI}cd`, 4)).toEqual(`${EMOJI}cd`)
  expect(clipTail('abc', 0)).toEqual('')
  expect(clipTail('abc', 99)).toEqual('abc')
})
