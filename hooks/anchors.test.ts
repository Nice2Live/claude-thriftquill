import { expect, test } from 'claude-code/testing'

import { anchorsFor, hasRelayRule } from './register'

test('anchorsFor leaves the relay rule out when another mod already sent it', () => {
  const jo = { isHandoff: true, anchors: 'Reply in Russian.' }

  expect(anchorsFor(jo)?.text).toContain('[memory relay')
  expect(anchorsFor(jo, true)?.text).toBe('Reply in Russian.')
  expect(anchorsFor({ isHandoff: true, anchors: '' }, true)).toBeUndefined()
  expect(hasRelayRule([{ text: '... a block starting "[memory relay", store ...' }])).toBe(true)
})

