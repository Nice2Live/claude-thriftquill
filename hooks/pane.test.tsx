import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'thriftquill',
  component: 'Pane',
  requestId: 'thriftquill',
  props: {
    title: 'Thriftquill',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const cmd = (command: string, args = '') => ({ command, args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } })

const FILE = '2026-11-25_1701_output_manual.md'

test('the pane draws the snapshot tab on every surface', async $ => {
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await ui.find({ type: 'Button', key: 'tab:report' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'take' })).toBeDefined()
    expect(await ui.find({ type: 'Input', key: 'snapname' })).toBeDefined()
    await ui.unmount()
  }
})

test('/snap opens the pane with the list; View shows a snapshot, Restore attaches it, all in the pane', async ($, on) => {
  mock.env(on, { HOME: 'C:/tmp/home' })
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.toast', () => ({ value: undefined }))
  on('fs.list', () => ({ value: [{ name: FILE, kind: 'file', size: 10, mtimeMs: 0, isLink: false }] }))
  on('fs.read', () => ({ value: '# Snapshot: manual\n\n## Goal\nship the video pipeline' }))

  expect(await $.command.run(cmd('snap'))).toEqual({})

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await ui.find({ type: 'Button', key: `restore:${FILE}` })).toBeDefined()

  await ui.press({ key: `view:${FILE}` })
  expect(await ui.find({ type: 'Text', text: /ship the video pipeline/ })).toBeDefined()

  await ui.press({ key: `restore:${FILE}` })
  expect(await ui.find({ type: 'Text', text: /Goes with your next message/ })).toBeDefined()
  await ui.unmount()
})
