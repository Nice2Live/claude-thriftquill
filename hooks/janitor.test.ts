import { expect, test } from 'claude-code/testing'

import { boundaryStep, DEFAULTS, dropReread, decide, describePlan, idleStep, instructionsFor, planStubs, maskDecision, readOptions, stubText } from './janitor'

const BIG = 'first line of output\n' + 'x'.repeat(8000)
const OPTS = { ...DEFAULTS, ownTriggers: true, keepRecentMessages: 2, stubMinChars: 2000, idleMode: 'active' as const }

const history = () => [
  { role: 'user', text: 'do X', toolUses: [], handle: 'h0' },
  {
    role: 'assistant',
    text: '',
    toolUses: [
      { tool_use_id: 't1', tool: 'Bash', input: { command: 'ls' }, text: BIG, result: { stdout: BIG } },
      { tool_use_id: 't2', tool: 'Write', input: { file_path: 'a.ts', content: 'y'.repeat(5000) }, text: 'ok' },
    ],
    handle: 'h1',
  },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: BIG, isError: false, result: { stdout: BIG } }], handle: 'h2' },
  { role: 'assistant', text: 'done', toolUses: [], handle: 'h3' },
  { role: 'user', text: 'thanks', toolUses: [], handle: 'h4' },
] as const

test('options: defaults, clamping and bad values', () => {
  expect(readOptions({})).toEqual(DEFAULTS)
  expect(readOptions({ mode: 'active', threshold_tokens: 50, keep_recent_messages: 'x', handoff: false })).toEqual({
    ...DEFAULTS,
    mode: 'active',
    thresholdTokens: 100000,
    isHandoff: false,
  })
  expect(readOptions({ mode: 'weird' }).mode).toEqual('shadow')
})

test('planStubs archives big old output once per id and field, and leaves the rest whole', () => {
  const plan = planStubs(history() as never, OPTS, 'D')
  const ids = plan.archives.map(a => `${a.id}.${a.field}`).sort()

  expect(ids).toEqual(['t1.out', 't2.in-content'])
  expect(plan.isChanged).toEqual(true)
  expect(plan.savedTokens).toBeGreaterThan(3000)

  const [assistant, results, tail1, tail2] = [plan.messages[1]!, plan.messages[2]!, plan.messages[3]!, plan.messages[4]!]

  expect(assistant.toolUses[0]!.text).toContain('[archived: Bash.out')
  expect(assistant.toolUses[0]!.text).toContain('D/t1.out.txt')
  expect(assistant.toolUses[0]!.text).toContain('start: first line of output')
  expect(assistant.toolUses[0]!.result).toEqual(undefined)
  expect(assistant.toolUses[1]!.input.content).toContain('[archived: Write.in-content')
  expect(assistant.toolUses[1]!.input.file_path).toEqual('a.ts')
  expect(assistant.toolUses[1]!.text).toEqual('ok')
  expect(results.toolResults?.[0]?.text).toContain('D/t1.out.txt')
  expect('handle' in assistant).toEqual(false)
  expect(tail1.handle).toEqual('h3')
  expect(tail2.handle).toEqual('h4')
  expect(plan.messages[0]!.handle).toEqual('h0')
})

test('planStubs keeps recent messages even when big, and never stubs a stub', () => {
  const plan = planStubs(history() as never, { ...OPTS, keepRecentMessages: 5 }, 'D')

  expect(plan.isChanged).toEqual(false)
  expect(plan.archives.length).toEqual(0)

  const once = planStubs(history() as never, OPTS, 'D')
  const twice = planStubs(once.messages, OPTS, 'D')

  expect(twice.archives.length).toEqual(0)
  expect(twice.isChanged).toEqual(false)
})

test('stub text names size, path and the first line', () => {
  expect(stubText('Read', 'out', 'abc\ndef', 'P/x.txt')).toEqual('[archived: Read.out ~2 tok.; full: P/x.txt; start: abc]')
})

test('decide: below, at the threshold, retry gate, modes', () => {
  const gate = { isForced: false }

  expect(decide(undefined, OPTS, gate)).toEqual('none')
  expect(decide(299999, OPTS, gate)).toEqual('none')
  expect(decide(300000, OPTS, gate)).toEqual('shadow')
  expect(decide(300000, { ...OPTS, mode: 'active' }, gate)).toEqual('compact')
  expect(decide(320000, { ...OPTS, mode: 'active' }, { isForced: false, lastAttemptTokens: 300000 })).toEqual('none')
  expect(decide(340000, { ...OPTS, mode: 'active' }, { isForced: false, lastAttemptTokens: 300000 })).toEqual('compact')
})

test('instructions keep the person text first and always carry the priorities', () => {
  expect(instructionsFor('keep the plan')).toContain('keep the plan\n\nCompaction priorities')
  expect(instructionsFor(undefined)).toContain('[archived:')
})

test('describePlan: nothing to trim and a real plan', () => {
  expect(describePlan({ messages: [], archives: [], savedTokens: 0, isChanged: false }, 310000)).toContain('nothing to trim (context 310k)')

  const plan = planStubs(history() as never, OPTS, 'D')

  expect(describePlan(plan, 310000)).toContain('Bash.out')
})

test('readOptions keeps the idle settings in their range', () => {
  expect(readOptions({}).idleMinutes).toEqual(50)
  expect(readOptions({ idle_minutes: 5 }).idleMinutes).toEqual(20)
  expect(readOptions({ idle_minutes: 90 }).idleMinutes).toEqual(58)
  expect(readOptions({ idle_min_tokens: 'x' }).idleMinTokens).toEqual(150000)
  expect(readOptions({ idle_min_tokens: 1000 }).idleMinTokens).toEqual(50000)
})

test('idle compaction: warm or cold it compacts a big context, a small one or a short silence waits', () => {
  expect(idleStep(49, 400000, OPTS)).toEqual('none')
  expect(idleStep(50, 100000, OPTS)).toEqual('none')
  expect(idleStep(55, 186000, OPTS)).toEqual('compact')
  expect(idleStep(60, 186000, OPTS)).toEqual('compact')
  expect(idleStep(1380, 186000, OPTS)).toEqual('compact')
  expect(idleStep(1380, 186000, { ...OPTS, idleMode: 'shadow' as const })).toEqual('shadow')
})

test('the idle compaction is shadow unless the settings say active, whatever the janitor mode is', () => {
  expect(readOptions({}).idleMode).toEqual('shadow')
  expect(readOptions({ mode: 'active' }).idleMode).toEqual('shadow')
  expect(readOptions({ idle_mode: 'active' }).idleMode).toEqual('active')
  expect(readOptions({ idle_mode: 'weird' }).idleMode).toEqual('shadow')
})

test('the anchors setting is text, cut at 4000 characters; anything else is empty', () => {
  expect(readOptions({}).anchors).toEqual('')
  expect(readOptions({ anchors: 'Reply in French.' }).anchors).toEqual('Reply in French.')
  expect(readOptions({ anchors: 5 }).anchors).toEqual('')
  expect(readOptions({ anchors: 'x'.repeat(5000) }).anchors.length).toEqual(4000)
})

test('own triggers are off unless the settings say so: no threshold and no idle compaction of its own', () => {
  expect(readOptions({}).ownTriggers).toEqual(false)
  expect(readOptions({ own_triggers: true }).ownTriggers).toEqual(true)
  expect(readOptions({ own_triggers: 'yes' }).ownTriggers).toEqual(false)

  const off = { ...OPTS, mode: 'active' as const, ownTriggers: false }

  expect(decide(900000, off, { isForced: false })).toEqual('none')
  expect(idleStep(120, 900000, off)).toEqual('none')
  expect(decide(900000, { ...off, ownTriggers: true }, { isForced: false })).toEqual('compact')
})

test('output, compaction style and handoff options: defaults, values and junk', () => {
  const d = readOptions({})

  expect([d.outputMode, d.outputCapChars, d.compactionStyle, d.maskMinCut, d.handoffRewrite]).toEqual(['shadow', 30000, 'summary', 40, true])
  expect(readOptions({ output_mode: 'active', output_cap_chars: 1, compaction_style: 'hybrid', mask_min_cut: 99, handoff_rewrite: false })).toMatchObject({
    outputMode: 'active',
    outputCapChars: 5000,
    compactionStyle: 'hybrid',
    maskMinCut: 80,
    handoffRewrite: false,
  })
  expect(readOptions({ output_mode: 'off' }).outputMode).toEqual('off')
  expect(readOptions({ output_mode: 'weird', compaction_style: 'weird' })).toMatchObject({ outputMode: 'shadow', compactionStyle: 'summary' })
})

test('maskDecision: only in hybrid style, and only when the stubs alone cut enough', () => {
  const hybrid = { compactionStyle: 'hybrid' as const, maskMinCut: 40 }

  expect(maskDecision(300000, 150000, hybrid)).toEqual('mask')
  expect(maskDecision(300000, 120000, hybrid)).toEqual('mask')
  expect(maskDecision(300000, 119999, hybrid)).toEqual('summary')
  expect(maskDecision(undefined, 150000, hybrid)).toEqual('summary')
  expect(maskDecision(0, 10, hybrid)).toEqual('summary')
  expect(maskDecision(300000, 290000, { compactionStyle: 'summary' as const, maskMinCut: 40 })).toEqual('summary')
})

test('boundaryStep: past the threshold a compaction waits for a stage end, up to the top of the window', () => {
  const o = { ...OPTS, thresholdTokens: 400000, boundaryWindowTokens: 70000 }

  expect(boundaryStep('compact', 420000, false, o)).toEqual('wait')
  expect(boundaryStep('compact', 420000, true, o)).toEqual('compact')
  expect(boundaryStep('compact', 470000, false, o)).toEqual('compact')
  expect(boundaryStep('shadow', 420000, false, o)).toEqual('wait')
  expect(boundaryStep('none', 420000, false, o)).toEqual('none')
  expect(boundaryStep('compact', 420000, false, { ...o, boundaryWindowTokens: 0 })).toEqual('compact')
  expect(readOptions({}).boundaryWindowTokens).toEqual(70000)
  expect(readOptions({ boundary_window_tokens: 0 }).boundaryWindowTokens).toEqual(0)
  expect(readOptions({ boundary_window_tokens: 999999 }).boundaryWindowTokens).toEqual(300000)
  expect(instructionsFor(undefined, 'EXTRA')).toContain('EXTRA')
})

test('dropReread: a file attached again after a compaction stays only when the message names it', () => {
  const text = 'Called the Read tool with the following input: {"file_path":"C:\\Users\\x\\hooks\\worklog.test.ts"}\nResult: ...'

  expect(dropReread(text, 'how did the compaction go?')).toEqual(true)
  expect(dropReread(text, 'look at @hooks/worklog.test.ts again')).toEqual(false)
  expect(dropReread('a file without a read call', '')).toEqual(false)
  expect(readOptions({}).reattachFiles).toEqual(false)
  expect(readOptions({ reattach_files: true }).reattachFiles).toEqual(true)
})
