import { expect, mock, test } from 'claude-code/testing'

import {
  HANDOFF_ASK,
  RUSSIAN_SHARE,
  cyrillicShare,
  dedupeDeferred,
  dedupeSkills,
  deferralFor,
  dropPending,
  fmtSpend,
  fmtToolSizes,
  handoffBody,
  hideSkills,
  hideTools,
  hotTools,
  isUnreachable,
  keepPending,
  ownHandoffHash,
  parseDeferRules,
  parseSkillRules,
  redact,
  relayBlock,
  rise,
  storeVerdict,
  summarizeSpend,
  summaryOf,
  takePending,
} from './register'
// A command run as the person types it.
const cmd = (command: string, args = '') => ({ command, args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } })

const HEAD = 'The following skills are available for use with the Skill tool:\n'
const SKILLS = `${HEAD}\n- a:one: First skill\n- b:two: Second skill\n  continued line\n- c:three: Third skill`
const TOOLS_HEAD = 'The following deferred tools are now available via ToolSearch. Load schemas first:'
const GONE_HEAD = 'The following deferred tools are no longer available (server disconnected):'
const SUMMARY = [
  'Summary:',
  '**1. Primary Request and Intent**',
  '- Build the mod.',
  '',
  '**2. Key Technical Concepts**',
  '- hooks and relay',
  '',
  '**7. Pending Tasks**',
  '- Verify the janitor.',
  '',
  '**8. Current Work**',
  '- Reading the trace.',
  '',
  '**9. Optional Next Step**',
  'Ask the user about deleting notes.',
  '',
  'If you need specific details from before compaction, read the transcript at C:/x.jsonl',
  'Continue the conversation from where it left off without asking the user any further questions.',
].join('\n')
const fakeKeep = (sid: string) => {
  const data = new Map<string, unknown>()

  return {
    data,
    store: {
      get: async (key: string) => data.get(key),
      set: async (key: string, value: unknown) => void data.set(key, JSON.parse(JSON.stringify(value))),
      delete: async (key: string) => void data.delete(key),
    },
    session: { id: async () => `${sid}-0000-0000` },
  }
}

test('skill listing: first passes whole, a repeat is dropped, only new skills pass on a change', () => {
  const seen = new Set<string>()

  expect(dedupeSkills(SKILLS, seen)).toEqual(SKILLS)
  expect(dedupeSkills(SKILLS, seen)).toEqual(null)

  const next = dedupeSkills(`${SKILLS}\n- d:four: Fourth skill`, seen)

  expect(next).toContain('d:four')
  expect(next).toContain(HEAD.trim())
  expect(next).not.toContain('a:one')
  expect(next).not.toContain('continued line')
})

test('deferred tools: repeats are cut, a tool that went away and came back is announced again', () => {
  const known = new Set<string>()
  const first = `${TOOLS_HEAD}\nCronCreate\nCronDelete\nmcp__x__y\n\nAmbient note.`

  expect(dedupeDeferred(first, known)).toEqual(first)
  expect(dedupeDeferred(first, known)).toEqual(null)

  const mixed = dedupeDeferred(`${TOOLS_HEAD}\nCronCreate\nNewTool\n\nAmbient note.`, known)

  expect(mixed).toContain('NewTool')
  expect(mixed).not.toContain('CronCreate')
  expect(mixed).toContain('Ambient note.')

  const gone = dedupeDeferred(`${GONE_HEAD}\nCronDelete\nmcp__x__y`, known)

  expect(gone).toContain('CronDelete')

  const back = dedupeDeferred(`${TOOLS_HEAD}\nCronDelete\nCronCreate`, known)

  expect(back).toContain('CronDelete')
  expect(back).not.toContain('CronCreate')
})

test('deferred tools: text without a notice passes untouched', () => {
  expect(dedupeDeferred('nothing to see here', new Set())).toEqual('nothing to see here')
})

test('the hooks drop a repeated listing end to end', async ($, on) => {
  on('prompt.attachment', (_$, e) => ({ text: e.text }))

  const input = { type: 'skill_listing', text: SKILLS, origin: { kind: 'engine' } } as const

  expect(await $.prompt.attachment(input)).toEqual({ text: SKILLS })
  expect(await $.prompt.attachment(input)).toEqual({ text: null })
})

test('rise: growth, window reset, missing reading', () => {
  expect(rise(10, 12)).toEqual(2)
  expect(rise(90, 3)).toEqual(3)
  expect(rise(undefined, 5)).toEqual(undefined)
})

test('the anchors come last in the system prompt', async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'base', text: 'base', scope: 'shared' }] }))

  const composed = await $.prompt.compose({ model: 'test', promptModel: 'test', surfaces: [], tools: [], outputStyle: null, traits: [] })

  expect(composed.sections.map(s => s.id)).toEqual(['base', 'thriftquill:protocol'])
  expect(composed.sections[1]!.text).toContain('memory_store')
  expect(composed.sections[1]!.text).not.toContain('Russian')
})

test('redact blanks the secret and keeps the rest', () => {
  const out = redact('ключ api_key = abc123 и хеш 1111111111111111111111111111111111111111111111111111111111111111, путь toolu_018QexfkJE2BqBNB6T4kqcwC')

  expect(out).toContain('[redacted]')
  expect(out).not.toContain('abc123')
  expect(out).not.toContain('33404cd8')
  expect(out).toContain('toolu_018QexfkJE2BqBNB6T4kqcwC')
})

test('storeVerdict: an error, a refusal said in words, and a clean store', () => {
  const reply = (text: string, isError = false) => ({ content: [{ type: 'text', text }], isError })

  expect(storeVerdict(reply('boom', true))).toContain('error')
  expect(storeVerdict(reply('Duplicate content detected, not stored'))).toContain('not stored')
  expect(storeVerdict(reply('Memory stored successfully. Hash: abc'))).toEqual('ok')
})

test('summaryOf picks the engine summary and drops its preface', () => {
  const summary = `This session is being continued from a previous conversation.

Summary:
**1. Primary Request** ${'x'.repeat(300)}`
  const text = summaryOf([
    { role: 'user', text: 'short' },
    { role: 'user', text: summary },
  ])

  expect(text.startsWith('**1. Primary Request**')).toEqual(true)
  expect(summaryOf([{ role: 'assistant', text: 'hi' }])).toEqual('')
})

test('relay: the model is told what to store, an unreachable service is recognised by the engine wording', () => {
  expect(relayBlock([])).toEqual(undefined)

  const block = relayBlock(['tags "auto-saved,pref", type decision: user wants Russian', HANDOFF_ASK]) ?? ''

  expect(block.startsWith('[memory relay')).toEqual(true)
  expect(block).toContain('1. tags "auto-saved,pref"')
  expect(block).toContain('2. tags "session-handoff,auto-saved"')
  expect(isUnreachable(new Error('HooksError: thriftquill: $.mcp.call: no connected MCP tool "memory_search" on a server named "x"'))).toEqual(true)
  expect(isUnreachable(new Error('timeout'))).toEqual(false)
})

test('handoffBody keeps the goal, the pending work and the current work, and drops the engine orders', () => {
  const body = handoffBody(SUMMARY)

  expect(body).toContain('Build the mod.')
  expect(body).toContain('Verify the janitor.')
  expect(body).toContain('Reading the trace.')
  expect(body).not.toContain('hooks and relay')
  expect(body).not.toContain('deleting notes')
  expect(body).not.toContain('Continue the conversation')
  expect(body).not.toContain('transcript')
})

test('ownHandoffHash picks the newest live handoff of the session and nothing from a bad reply', () => {
  const list = JSON.stringify({
    memories: [
      { content_hash: 'old', created_at: 100 },
      { content_hash: 'newest', created_at: 300 },
      { content_hash: 'gone', created_at: 400, metadata: { superseded_by: 'newest' } },
    ],
  })

  expect(ownHandoffHash(list)).toEqual('newest')
  expect(ownHandoffHash(JSON.stringify({ memories: [] }))).toEqual(undefined)
  expect(ownHandoffHash('Error: nothing')).toEqual(undefined)
})

test('handoffBody caps long sections and survives a summary without headings', () => {
  const long = handoffBody(`**1. Primary Request**\n${'a'.repeat(5000)}\n**7. Pending Tasks**\n${'b'.repeat(5000)}`)

  expect(long.length).toBeLessThan(3700)
  expect(long).toContain('[…]')
  expect(handoffBody('just a short plain summary')).toEqual('just a short plain summary')
  expect(handoffBody(`${'x'.repeat(5000)}\nContinue the conversation from where it left off.`).length).toBeLessThan(3700)
})

test('cyrillicShare tells an English note from a Russian one', () => {
  expect(cyrillicShare('User prefers short answers, see /janitor trace')).toEqual(0)
  expect(cyrillicShare('Пользователь хочет русский язык ответов')).toBeGreaterThan(0.9)
  expect(cyrillicShare('12345 --- ///')).toEqual(0)
  expect(cyrillicShare('Use /janitor run on the server prod1 now')).toEqual(0)
})

test('summarizeSpend adds up today, the week and the kinds; fmtSpend says it', () => {
  const now = new Date('2026-10-07T15:00:00')
  const row = (t: string, kind: string, inTok: number, outTok: number) => JSON.stringify({ t, kind, inTok, outTok, ms: 2000 })
  const day = (h: string) => `2026-10-07T${h}`
  const { today, week, byKind } = summarizeSpend(
    [row(day('09:00:00'), 'recall', 100, 10), row(day('10:00:00'), 'save', 3000, 200), row(day('11:00:00'), 'save', 1000, 100), row('2026-10-04T10:00:00', 'save', 500, 50), row('2026-09-20T10:00:00', 'save', 9999, 999), 'not json'],
    now,
  )

  expect(today).toEqual({ calls: 3, inTok: 4100, outTok: 310, ms: 6000 })
  expect(week.calls).toEqual(4)
  expect(byKind.save?.calls).toEqual(2)
  expect(byKind.recall?.inTok).toEqual(100)
  expect(fmtSpend(today)).toContain('calls 3')
  expect(fmtSpend({ calls: 0, inTok: 0, outTok: 0, ms: 0 })).toContain('calls 0')
})

test('a handoff above RUSSIAN_SHARE of Cyrillic counts as copied, not translated', () => {
  expect(RUSSIAN_SHARE).toBeLessThan(0.25)
  expect(cyrillicShare('Goal: tune the mod. Decisions: rename the plugin to ua; keep memory in English.')).toBeLessThan(RUSSIAN_SHARE)
  expect(cyrillicShare('Цель: приёмка мода ua. Решения: память хранить на английском, ответы по-русски.')).toBeGreaterThan(RUSSIAN_SHARE)
})

test('the report owed after a compaction survives a reload, once, for its own session', async () => {
  const mine = fakeKeep('aaaaaaaa')

  expect(await takePending(mine)).toEqual(undefined)

  await keepPending(mine, { trigger: 'auto', archived: 3, saved: 1000 })
  expect(await takePending(mine)).toEqual({ trigger: 'auto', archived: 3, saved: 1000 })

  await dropPending(mine)
  expect(await takePending(mine)).toEqual(undefined)

  // another session sharing the store does not see it
  await keepPending(mine, { trigger: 'auto', archived: 1, saved: 1 })

  const other = { ...fakeKeep('bbbbbbbb'), store: mine.store }

  expect(await takePending(other)).toEqual(undefined)
})

test('a report older than six hours is dropped', async () => {
  const mine = fakeKeep('aaaaaaaa')

  mine.data.set('pending:aaaaaaaa', { at: Date.now() - 7 * 60 * 60 * 1000, p: { trigger: 'auto', archived: 0, saved: 0 } })
  expect(await takePending(mine)).toEqual(undefined)
  expect(mine.data.size).toEqual(0)
})

test('hideTools cuts the listed server from the "now available" notice and says how to find it', () => {
  const text = ['The following deferred tools are now available via ToolSearch:', 'mcp__acme__users_list', 'mcp__acme__users_get', 'mcp__memory__store', 'Read'].join('\n')
  const out = hideTools(text, ['mcp__acme__'])

  expect(out).not.toContain('users_list')
  expect(out).toContain('mcp__memory__store')
  expect(out).toContain('(2 tools "mcp__acme__*" are not listed')
  expect(out).toContain('ToolSearch "acme"')
  expect(hideTools(text, [])).toEqual(text)
  expect(hideTools(text, ['mcp__none__'])).toEqual(text)
})

test('tool deferral rules: defer all, keep core, hot tools stay in the pool', () => {
  const rules = parseDeferRules('# core\nkeep Bash\nkeep mcp__mcp-memory-service__\ndefer *\n')
  const none = new Set<string>()

  expect(deferralFor('NotebookEdit', rules, none)).toBe(true)
  expect(deferralFor('Bash', rules, none)).toBe(false)
  expect(deferralFor('mcp__mcp-memory-service__memory_search', rules, none)).toBe(false)
  expect(deferralFor('ToolSearch', rules, none)).toBe(false)
  expect(deferralFor('NotebookEdit', rules, new Set(['NotebookEdit']))).toBe(false)
  expect(deferralFor('Anything', parseDeferRules(''), none)).toBeUndefined()
  expect(deferralFor('mcp__x__a', parseDeferRules('defer mcp__x__'), none)).toBe(true)
  expect(deferralFor('mcp__y__a', parseDeferRules('defer mcp__x__'), none)).toBeUndefined()
})

test('hotTools counts sessions, not calls', () => {
  const hist = [['s1', 'A', 'A', 'B'], ['s2', 'A'], ['s3', 'A', 'B'], ['s4', 'C']]

  expect([...hotTools(hist)].sort()).toEqual(['A'])
})

test('fmtToolSizes sums descriptions the rules would defer', () => {
  const tools = [
    { name: 'Bash', description: 'x'.repeat(8000), mcp: false },
    { name: 'NotebookEdit', description: 'y'.repeat(4000), mcp: false }
  ]
  const { text } = fmtToolSizes(tools, parseDeferRules('keep Bash\ndefer *'), new Set())

  expect(text).toContain('defer 1')
  expect(text).toContain('−1.0k')
})

test('fmtToolSizes prefers the engine\'s own token count and marks estimates', () => {
  const tools = [
    { name: 'mcp__a__big', description: 'x'.repeat(300), mcp: true },
    { name: 'Bash', description: 'y'.repeat(300), mcp: false },
  ]
  const { text, rows } = fmtToolSizes(tools, { defer: ['*'], keep: [] }, new Set(), new Map([['mcp__a__big', 4000]]))

  expect(rows[0]?.name).toEqual('mcp__a__big')
  expect(rows[0]?.tokens).toEqual(4000)
  expect(rows[1]?.tokens).toEqual(75)
  expect(text).toContain('mcp__a__big 4.0k')
  expect(text).toContain('Bash 0.1k+')
})

test('/janitor doctor names the mode, the rules and the hooks that ran', async ($, on) => {
  mock.env(on, { HOME: 'C:/tmp/home' })
  on('ui.open', () => ({ value: { isPlaced: false } }) as never)
  on('mcp.call', () => ({ value: { content: [{ type: 'text', text: 'Found 0 memories' }], isError: false } }))

  const doctor = JSON.stringify(await $.command.run(cmd('janitor', 'doctor')))

  expect(doctor).toContain('thriftquill v')
  expect(doctor).toContain('hooks that ran this session')
  expect(doctor).toContain('own triggers off')
})

test('hide-skills.txt: a prefix cuts its skills from the listing, with or without the file that keeps them', () => {
  expect(parseSkillRules('# note\nunity: unless ProjectSettings/ProjectVersion.txt\nb:\n\nbad rule here')).toEqual([
    { prefix: 'unity:', unless: 'ProjectSettings/ProjectVersion.txt' },
    { prefix: 'b:' },
  ])

  const cut = hideSkills(SKILLS, ['b:'])

  expect(cut.hidden).toEqual(1)
  expect(cut.text).toContain('- a:one')
  expect(cut.text).not.toContain('continued line')
  expect(hideSkills(SKILLS, [])).toEqual({ text: SKILLS, hidden: 0 })
})
