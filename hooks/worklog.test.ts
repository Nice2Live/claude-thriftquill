import { expect, test } from 'claude-code/testing'

import { addEntry, asWorklog, backgroundStart, clipReport, closeStage, EMPTY_WORKLOG, noticeTitle, patchEntry, renderWorklog, stageEnd } from './worklog'

const T0 = '2026-11-25T19:00:00.000Z'

test('the log: add, patch, render, and a stage closed keeps what still runs', () => {
  let log = addEntry(EMPTY_WORKLOG, { id: 'a1', kind: 'agent', title: 'Explore: scan the repo', started: T0, status: 'running' })

  log = addEntry(log, { id: 't1', kind: 'task', title: 'npm test', started: T0, status: 'running' })
  log = patchEntry(log, 'a1', { status: 'completed', ended: '2026-11-25T19:05:00.000Z', report: 'found 3 files', file: 'thriftquill/worklog/x.md' })
  expect(patchEntry(log, 'nope', { status: 'failed' })).toEqual(log)

  const text = renderWorklog(log) ?? ''

  expect(text).toContain('[work log (thriftquill)')
  expect(text).toContain('1 item(s) still running')
  expect(text).toContain('- [completed] agent "Explore: scan the repo" (started 19:00 UTC, ended 19:05) · full report: thriftquill/worklog/x.md')
  expect(text).toContain('  found 3 files')
  expect(renderWorklog(EMPTY_WORKLOG)).toEqual(undefined)

  const closed = closeStage(log, '2026-11-25T19:10:00.000Z', 'commit')

  expect(closed.entries.map(x => x.id)).toEqual(['t1'])
  expect(renderWorklog(closed) ?? '').toContain('Previous stage, closed 19:10 UTC (commit): "Explore: scan the repo"')
  expect(closeStage(addEntry(EMPTY_WORKLOG, { id: 'r', kind: 'task', title: 'x', started: T0, status: 'running' }), T0, 'commit').closed).toEqual(undefined)
})

test('the log keeps its newest 60 entries and replaces one of the same id', () => {
  let log = EMPTY_WORKLOG

  for (let i = 0; i < 70; i++) {
    log = addEntry(log, { id: `n${i}`, kind: 'notice', title: `n${i}`, started: T0, status: 'noted' })
  }

  expect(log.entries.length).toEqual(60)
  expect(log.entries[0]?.id).toEqual('n10')
  expect(addEntry(log, { id: 'n69', kind: 'notice', title: 'again', started: T0, status: 'noted' }).entries.length).toEqual(60)
})

test('stageEnd: wrap-up, a finished plan or todo list, a commit', () => {
  expect(stageEnd('mcp__ccd_turn__wrap_up', {})).toEqual('task wrapped up')
  expect(stageEnd('mcp__ccd_turn__update_plan', { items: [{ content: 'a', status: 'completed' }] })).toEqual('plan done')
  expect(stageEnd('mcp__ccd_turn__update_plan', { items: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }] })).toEqual(undefined)
  expect(stageEnd('mcp__ccd_turn__update_plan', { advance: true })).toEqual(undefined)
  expect(stageEnd('TodoWrite', { todos: [{ content: 'a', status: 'completed' }] })).toEqual('todo list done')
  expect(stageEnd('Bash', { command: 'cd x && git add -A && git commit -qm "msg"' })).toEqual('commit')
  expect(stageEnd('Bash', { command: 'git -C repo commit -m x' })).toEqual('commit')
  expect(stageEnd('Bash', { command: 'git commit --dry-run' })).toEqual(undefined)
  expect(stageEnd('Bash', { command: 'git log -1 --oneline' })).toEqual(undefined)
  expect(stageEnd('Read', { file_path: 'commit.ts' })).toEqual(undefined)
})

test('backgroundStart: background commands, monitors and workflows', () => {
  expect(backgroundStart('Bash', { command: 'npm test', run_in_background: true, description: 'Run tests' })).toEqual('Run tests')
  expect(backgroundStart('Bash', { command: 'npm test' })).toEqual(undefined)
  expect(backgroundStart('Monitor', { description: 'wait for build' })).toEqual('Monitor: wait for build')
  expect(backgroundStart('Agent', { description: 'x' })).toEqual(undefined)
})

test('reports, notices and what the store gives back', () => {
  expect(clipReport('short')).toEqual('short')

  const long = clipReport('a'.repeat(2000) + 'END')

  expect(long.length < 1600).toEqual(true)
  expect(long.endsWith('END')).toEqual(true)
  expect(long).toContain('[…]')
  expect(noticeTitle('<task-notification><status>completed</status><summary>Build  done</summary></task-notification>')).toEqual('Build done')
  expect(noticeTitle('<x>plain   text</x>')).toEqual('plain text')
  expect(asWorklog(undefined)).toEqual(EMPTY_WORKLOG)
  expect(asWorklog({ entries: [{ id: 'a', title: 't', status: 'running', kind: 'agent', started: T0 }, { bad: 1 }] }).entries.length).toEqual(1)
})
