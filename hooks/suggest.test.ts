import { expect, test } from 'claude-code/testing'

import { suggestRules } from './suggest'

test('suggestRules defers a whole server nobody uses, keeps what is used and defers the rest of its server by name', () => {
  const tools = [
    { name: 'mcp__big__a', tokens: 3000, mcp: true },
    { name: 'mcp__big__b', tokens: 2000, mcp: true },
    { name: 'mcp__plugin_desktop_x__read', tokens: 500, mcp: true },
    { name: 'mcp__plugin_desktop_x__write', tokens: 700, mcp: true },
    { name: 'Bash', tokens: 900, mcp: false },
  ]
  const s = suggestRules(tools, new Set(['mcp__plugin_desktop_x__read']))

  expect(s.lines.slice(1)).toEqual(['defer mcp__big__', 'keep mcp__plugin_desktop_x__read', 'defer mcp__plugin_desktop_x__write'])
  expect(s.kept).toEqual(['mcp__plugin_desktop_x__read'])
  expect(s.deferredTokens).toEqual(5000 + 700)
})

test('suggestRules says nothing when there are no MCP tools', () => {
  const s = suggestRules([{ name: 'Bash', tokens: 900, mcp: false }], new Set())

  expect(s.lines.length).toEqual(1)
  expect(s.deferredTokens).toEqual(0)
})
