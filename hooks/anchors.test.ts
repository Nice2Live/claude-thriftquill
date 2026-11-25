import { expect, test } from 'claude-code/testing'

import { readOptions } from './janitor'
import { anchorsFor, hasRelayRule, NO_TASK_LIST, PLAN_TOOL } from './register'

test('anchorsFor leaves the relay rule out when another mod already sent it', () => {
  const jo = { isHandoff: true, anchors: 'Reply in Russian.' }

  expect(anchorsFor(jo)?.text).toContain('[memory relay')
  expect(anchorsFor(jo, true)?.text).toBe('Reply in Russian.')
  expect(anchorsFor({ isHandoff: true, anchors: '' }, true)).toBeUndefined()
  expect(hasRelayRule([{ text: '... a block starting "[memory relay", store ...' }])).toBe(true)
})

test('task list off: a section says so, on by default', () => {
  expect(readOptions({}).taskList).toEqual(true)
  expect(readOptions({ task_list: false }).taskList).toEqual(false)
  expect(NO_TASK_LIST.text).toContain(PLAN_TOOL)
  expect(NO_TASK_LIST.scope).toEqual('session')
})
