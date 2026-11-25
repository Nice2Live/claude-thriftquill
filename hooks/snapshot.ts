import { clipHead, clipTail } from './text'
import type { TqPane } from '../types'

export type { SnapRow, TqPane, TqTab } from '../types'

// Context snapshots: the conversation pressed into a note another chat can resume from. Pure helpers; the commands and the
// compaction hook in register.ts read the conversation, call the model and write the files.

export type SnapMessage = { role: string; text: string; toolUses?: readonly { tool: string }[] }

export const SNAPSHOT_SYSTEM = [
  'You turn a conversation between a user and a coding assistant into a snapshot that another assistant, with no other context, can resume the work from.',
  'Write Markdown with these sections, each only when it has content: "## Goal", "## Decisions" (each with its reason), "## Current state" (what is done, what works, what was verified and what was not), "## Files and places" (paths, branches, commands, settings that matter), "## Next steps", "## Open questions".',
  'Facts only: no tool output dumps, no secrets, no pleasantries. Keep names, paths, identifiers, commands and error messages exactly as written. Write in English whatever language the conversation is in. At most 6000 characters.',
].join(' ')

// The conversation as text for the model: the first message (the task, or the summary a compaction left) and as much of
// the end as fits in `budget` characters, the newest kept whole first. A tool call is one line naming the tools.
export const transcriptOf = (messages: readonly SnapMessage[], budget = 60000): string => {
  const line = (m: SnapMessage) => {
    const tools = (m.toolUses ?? []).map(t => t.tool)
    const used = tools.length === 0 ? '' : `\n  [tools: ${[...new Set(tools)].map(t => `${t}${tools.filter(x => x === t).length > 1 ? ` ×${tools.filter(x => x === t).length}` : ''}`).join(', ')}]`

    return `${m.role.toUpperCase()}: ${m.text.trim()}${used}`
  }

  if (messages.length === 0) {
    return ''
  }

  const first = clipHead(line(messages[0]!), 4000)
  const tail: string[] = []
  let room = Math.max(0, budget - first.length)

  for (let i = messages.length - 1; i >= 1 && room > 0; i--) {
    const text = line(messages[i]!)
    const kept = text.length <= room ? text : `[…] ${clipTail(text, room)}`

    tail.unshift(kept)
    room -= kept.length + 2
  }

  const skipped = messages.length - 1 - tail.length

  return [first, ...(skipped > 0 ? [`[… ${skipped} earlier message(s) left out …]`] : []), ...tail].join('\n\n')
}

// "project:<folder name>" for the folder the session runs in; none for the home folder or a drive root. The same rule as
// mnemovale's, so a snapshot stored in memory is found by that mod's start briefing.
export const projectTag = (cwd: string | undefined, home: string | undefined): string | undefined => {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')

  if (cwd === undefined || cwd === '') {
    return undefined
  }

  const dir = norm(cwd)

  if (home !== undefined && home !== '' && dir.toLowerCase() === norm(home).toLowerCase()) {
    return undefined
  }

  const base = dir.split('/').pop() ?? ''

  if (/^[A-Za-z]:$/.test(base)) {
    return undefined
  }

  const slug = base
    .toLowerCase()
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)

  return slug === '' ? undefined : `project:${slug}`
}

// A file name part: no "_", which separates the parts of a snapshot's file name.
export const slug = (text: string, max = 40): string =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}.-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)

const two = (n: number) => String(n).padStart(2, '0')

// "2026-11-25_1640_<project>_<name>.md": sorts by time, and says the project without opening the file.
export const snapshotFile = (now: Date, project: string | undefined, name: string): string =>
  `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}_${two(now.getHours())}${two(now.getMinutes())}_${slug(project?.replace(/^project:/, '') ?? 'none') || 'none'}_${slug(name) || 'snapshot'}.md`

export type SnapEntry = { file: string; project: string; name: string; at: string }

export const parseSnapshotFile = (file: string): SnapEntry | undefined => {
  const m = /^(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})_([^_]+)_(.+)\.md$/.exec(file)

  return m === null ? undefined : { file, project: m[4]!, name: m[5]!, at: `${m[1]} ${m[2]}:${m[3]}` }
}

// The snapshots, newest first.
export const listSnapshots = (files: readonly string[]): SnapEntry[] =>
  files
    .map(parseSnapshotFile)
    .filter((x): x is SnapEntry => x !== undefined)
    .sort((a, b) => b.file.localeCompare(a.file))

// Which snapshot "/restore <arg>" means: a number of the list, a name (whole, then a part of it), or with no argument the
// newest of the project, else the newest of all.
export const pickSnapshot = (entries: readonly SnapEntry[], arg: string, project: string | undefined): SnapEntry | undefined => {
  const a = arg.trim()

  if (a === '') {
    const mine = project === undefined ? undefined : entries.find(e => e.project === slug(project.replace(/^project:/, '')))

    return mine ?? entries[0]
  }

  if (/^\d+$/.test(a)) {
    return entries[Number(a) - 1]
  }

  const s = slug(a)

  return entries.find(e => e.name === s) ?? entries.find(e => e.name.includes(s) || e.file.includes(s))
}

// Local time with its offset, as the file name has it: "2026-11-25 17:46 (UTC+3)".
export const localStamp = (d: Date): string => {
  const off = -d.getTimezoneOffset()
  const h = Math.floor(Math.abs(off) / 60)
  const m = Math.abs(off) % 60

  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())} (UTC${off < 0 ? '-' : '+'}${h}${m === 0 ? '' : `:${two(m)}`})`
}

export type SnapMeta = { name: string; project?: string; cwd: string; sessionId: string; at: Date; messages: number; source: 'model' | 'extract' }

export const snapshotDoc = (meta: SnapMeta, body: string): string =>
  [
    `# Snapshot: ${meta.name}`,
    '',
    `- taken: ${localStamp(meta.at)}`,
    `- project: ${meta.project?.replace(/^project:/, '') ?? 'none'} (${meta.cwd})`,
    `- session: ${meta.sessionId}, ${meta.messages} message(s), ${meta.source === 'model' ? 'summarized by the small model' : 'raw extract (the model gave no answer)'}`,
    '',
    body.trim(),
    '',
  ].join('\n')

// What the next message carries when a snapshot is restored.
export const restoreBlock = (file: string, doc: string): string =>
  [
    `[context snapshot restored from ${file}: it describes earlier work, possibly from another chat. Treat it as background; check that files and state still match before acting on its next steps]`,
    doc.trim(),
  ].join('\n')

// "/snap", "/snap <name>", "/snap list", "/snap show <n|name>".
export type SnapArgs = { kind: 'take'; name: string } | { kind: 'list' } | { kind: 'show'; target: string }

export const parseSnapArgs = (args: string): SnapArgs => {
  const a = args.trim()
  const m = /^(list|ls|show)\b\s*(.*)$/i.exec(a)

  if (m === null) {
    return { kind: 'take', name: a }
  }

  const verb = m[1]!.toLowerCase()

  return verb === 'show' ? { kind: 'show', target: m[2]!.trim() } : { kind: 'list' }
}

// ---- the pane
export const EMPTY_TQ_PANE: TqPane = { tab: 'snaps', snaps: [] }

// What a press on the pane names: "verb:arg", the arg after the first colon (a file name holds none).
export const pressOf = (element: string): { verb: string; arg: string } => {
  const i = element.indexOf(':')

  return i < 0 ? { verb: element, arg: '' } : { verb: element.slice(0, i), arg: element.slice(i + 1) }
}

export const ago = (at: number, now: number): string => {
  const s = Math.max(0, Math.round((now - at) / 1000))

  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`
}
