import { clipHead } from './text'

// The work log: what the conversation handed off (subagents, background commands, monitors, workflows) and what came
// back, kept by the mod outside the conversation. A compaction may lose it from the summary; the log goes back to the
// model with the next message after every compaction, so a stage that spans agents is not forgotten halfway.
export type WorkStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'noted'

export type WorkEntry = {
  id: string
  kind: 'agent' | 'task' | 'notice'
  title: string
  started: string
  status: WorkStatus
  ended?: string
  report?: string
  file?: string
}

export type Worklog = { entries: WorkEntry[]; closed?: { at: string; reason: string; titles: string[] } }

export const EMPTY_WORKLOG: Worklog = { entries: [] }

const MAX_ENTRIES = 60

export const REPORT_CHARS = 1500

// A report short enough goes in as it is; a longer one keeps its start and end until the small model's digest replaces it.
export const clipReport = (text: string, max = REPORT_CHARS): string => {
  const t = text.trim()

  return t.length <= max ? t : `${t.slice(0, Math.round(max * 0.65))}\n[…]\n${t.slice(-Math.round(max * 0.3))}`
}

export const addEntry = (log: Worklog, entry: WorkEntry): Worklog => ({
  ...log,
  entries: [...log.entries.filter(x => x.id !== entry.id), entry].slice(-MAX_ENTRIES),
})

export const patchEntry = (log: Worklog, id: string, patch: Partial<WorkEntry>): Worklog =>
  log.entries.some(x => x.id === id) ? { ...log, entries: log.entries.map(x => (x.id === id ? { ...x, ...patch } : x)) } : log

// A stage ended (the task was wrapped up, the plan or todo list is done, a commit was made): what is finished leaves the
// log as titles; what still runs stays, its report still owed.
export const closeStage = (log: Worklog, at: string, reason: string): Worklog => {
  const done = log.entries.filter(x => x.status !== 'running')

  return done.length === 0 ? log : { entries: log.entries.filter(x => x.status === 'running'), closed: { at, reason, titles: done.map(x => x.title).slice(-20) } }
}

const hhmm = (iso: string) => iso.slice(11, 16)

// The block the model gets after a compaction; undefined when there is nothing to say.
export const renderWorklog = (log: Worklog, max = 9000): string | undefined => {
  if (log.entries.length === 0 && log.closed === undefined) {
    return undefined
  }

  const rows = log.entries.map(x => {
    const head = `- [${x.status}] ${x.kind} "${x.title}" (started ${hhmm(x.started)} UTC${x.ended === undefined ? '' : `, ended ${hhmm(x.ended)}`})${x.file === undefined ? '' : ` · full report: ${x.file}`}`

    return x.report === undefined || x.report === '' ? head : `${head}\n  ${x.report.replace(/\n/g, '\n  ')}`
  })
  const running = log.entries.filter(x => x.status === 'running').length
  const closed =
    log.closed === undefined ? [] : [`Previous stage, closed ${hhmm(log.closed.at)} UTC (${log.closed.reason}): ${log.closed.titles.map(t => `"${t}"`).join(', ')}`]

  return clipHead(
    [
      '[work log (thriftquill): the work handed off in this stage and what came back, kept outside the conversation because a compaction may drop it. Use it to know what is done and what is still owed; do not start again what is listed as running.' +
        (running > 0 ? ` ${running} item(s) still running: their reports arrive later.` : '') +
        ']',
      ...rows,
      ...closed,
    ].join('\n'),
    max,
  )
}

// ---- reading the tool calls of the main loop
type Input = Record<string, unknown>

const str = (v: unknown) => (typeof v === 'string' ? v : undefined)

const allDone = (items: unknown, key = 'status') =>
  Array.isArray(items) && items.length > 0 && items.every(i => typeof i === 'object' && i !== null && (i as Input)[key] === 'completed')

const COMMIT = /\bgit\b[^\n;&|]*\scommit\b(?![^\n;&|]*--dry-run)/

// Why this call ends a stage, or undefined.
export const stageEnd = (tool: string, input: Input): string | undefined => {
  if (tool === 'mcp__ccd_turn__wrap_up') {
    return 'task wrapped up'
  }

  if (tool === 'mcp__ccd_turn__update_plan' && allDone(input.items)) {
    return 'plan done'
  }

  if (tool === 'TodoWrite' && allDone(input.todos)) {
    return 'todo list done'
  }

  if ((tool === 'Bash' || tool === 'PowerShell') && COMMIT.test(str(input.command) ?? '')) {
    return 'commit'
  }

  return undefined
}

// Background work a tool call starts (the Agent tool is heard at agent.spawn instead), as the log's title.
export const backgroundStart = (tool: string, input: Input): string | undefined => {
  if ((tool === 'Bash' || tool === 'PowerShell') && input.run_in_background === true) {
    return str(input.description) ?? (str(input.command) ?? '').slice(0, 100)
  }

  if (tool === 'Monitor' || tool === 'Workflow') {
    return `${tool}: ${str(input.description) ?? str(input.name) ?? str(input.prompt)?.slice(0, 80) ?? ''}`.trim()
  }

  return undefined
}

// A task notification as one line: its summary, else the start of its text.
export const noticeTitle = (text: string): string => {
  const summary = /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1] ?? text.replace(/<[^>]+>/g, ' ')

  return summary.replace(/\s+/g, ' ').trim().slice(0, 140)
}

// What the store holds, as a log or empty: a value of an earlier shape is dropped.
export const asWorklog = (v: unknown): Worklog => {
  if (typeof v !== 'object' || v === null || !Array.isArray((v as Worklog).entries)) {
    return EMPTY_WORKLOG
  }

  const entries = (v as Worklog).entries.filter(
    (x): x is WorkEntry => typeof x === 'object' && x !== null && typeof x.id === 'string' && typeof x.title === 'string' && typeof x.status === 'string',
  )

  return { entries, closed: (v as Worklog).closed }
}

export const DIGEST_SYSTEM =
  'You condense the report a coding subagent handed back, for the assistant that will continue the work without it. Keep: what was asked, what was found or changed, file paths, identifiers, numbers, commands, errors, open problems and recommendations. Drop narration. At most 900 characters, plain lines, no preamble.'
