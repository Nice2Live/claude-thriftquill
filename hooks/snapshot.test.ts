import { expect, test } from 'claude-code/testing'

import { listSnapshots, localStamp, parseSnapArgs, pickSnapshot, projectTag, restoreBlock, snapshotDoc, snapshotFile, transcriptOf } from './snapshot'

test('transcriptOf keeps the first message and the end within the budget', () => {
  const messages = [
    { role: 'user', text: 'TASK: build the thing' },
    ...Array.from({ length: 50 }, (_, i) => ({ role: i % 2 === 0 ? 'assistant' : 'user', text: `message ${i} ${'x'.repeat(200)}`, toolUses: i % 2 === 0 ? [{ tool: 'Bash' }, { tool: 'Bash' }, { tool: 'Edit' }] : [] })),
  ]
  const t = transcriptOf(messages, 3000)

  expect(t.startsWith('USER: TASK: build the thing')).toBe(true)
  expect(t).toContain('message 49')
  expect(t).toContain('earlier message(s) left out')
  expect(t).toContain('[tools: Bash ×2, Edit]')
  expect(t.length).toBeLessThan(3600)
  expect(transcriptOf([])).toBe('')
})

test('snapshot file names sort by time and parse back', () => {
  const at = new Date(2026, 10, 25, 16, 40)
  const file = snapshotFile(at, 'project:my_mods', 'Before Refactor')

  expect(file).toBe('2026-11-25_1640_my-mods_before-refactor.md')
  expect(snapshotFile(at, undefined, '')).toBe('2026-11-25_1640_none_snapshot.md')

  const list = listSnapshots([file, '2026-11-24_0900_other_manual.md', 'notes.txt'])

  expect(list.map(s => s.name)).toEqual(['before-refactor', 'manual'])
  expect(list[0]).toEqual({ file, project: 'my-mods', name: 'before-refactor', at: '2026-11-25 16:40' })
})

test('pickSnapshot by number, by name, or the newest of the project', () => {
  const list = listSnapshots(['2026-11-25_1640_mods_alpha.md', '2026-11-24_0900_other_beta.md', '2026-11-23_0900_mods_gamma.md'])

  expect(pickSnapshot(list, '', 'project:mods')?.name).toBe('alpha')
  expect(pickSnapshot(list, '', 'project:nothing')?.name).toBe('alpha')
  expect(pickSnapshot(list, '', undefined)?.name).toBe('alpha')
  expect(pickSnapshot(list, '2', undefined)?.name).toBe('beta')
  expect(pickSnapshot(list, 'gam', undefined)?.name).toBe('gamma')
  expect(pickSnapshot(list, '9', undefined)).toBeUndefined()
})

test('parseSnapArgs, projectTag and the documents', () => {
  expect(parseSnapArgs('')).toEqual({ kind: 'take', name: '' })
  expect(parseSnapArgs('list')).toEqual({ kind: 'list' })
  expect(parseSnapArgs('show 2')).toEqual({ kind: 'show', target: '2' })
  expect(parseSnapArgs('release prep')).toEqual({ kind: 'take', name: 'release prep' })
  expect(projectTag('C:\Users\Admin', 'C:\Users\Admin')).toBeUndefined()
  expect(projectTag('C:/work/My Mods/', 'C:\Users\Admin')).toBe('project:my-mods')

  const doc = snapshotDoc({ name: 'x', project: 'project:mods', cwd: 'C:/m', sessionId: 's1', at: new Date('2026-11-25T13:40:00Z'), messages: 9, source: 'model' }, '## Goal\nship it')

  expect(doc).toContain('- project: mods (C:/m)')
  expect(doc).toMatch(/- taken: 2026-11-2[56] \d{2}:\d{2} \(UTC[+-]\d+(:\d{2})?\)/)
  expect(localStamp(new Date(2026, 10, 25, 17, 46))).toMatch(/^2026-11-25 17:46 \(UTC[+-]\d+(:\d{2})?\)$/)
  expect(doc).toContain('## Goal')
  expect(restoreBlock('f.md', doc)).toMatch(/^\[context snapshot restored from f\.md/)
})
