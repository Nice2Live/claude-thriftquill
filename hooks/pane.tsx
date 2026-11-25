import { atom, read } from 'claude-code'
import type { Register } from 'claude-code'

import { ago, EMPTY_TQ_PANE } from './snapshot'

// The Thriftquill pane: context snapshots (take, view, restore) and the janitor's and the tools' reports, as buttons, so
// nothing has to be typed and no long answer lands in the chat. It only draws: a press or a submit reaches the `ui.press`
// and `ui.input` hooks in register.ts by the element's key ("verb:arg"), which do the work and write the atom.
export const TQ_PANE_ID = 'thriftquill'

// Change the shape tag when TqPane changes: it declines what an earlier version stored, which outlives a reload.
export const tqPane = atom({ plugin: 'thriftquill', key: 'pane' } as const, EMPTY_TQ_PANE, { shape: 'pane-1' })

type On = Parameters<Register>[0]

// The press is taken by the ui.press hook in register.ts; the element's own handler never runs.
const none = () => undefined

const REPORTS: readonly [string, string][] = [
  ['stats', 'Savings & cost'],
  ['plan', 'Compaction'],
  ['tools', 'Tools'],
  ['compactions', 'Compactions'],
  ['doctor', 'Health'],
  ['trace', 'Trace'],
]

export const registerTqPane = (on: On) => {
  on('ui.render', { component: 'Pane', requestId: TQ_PANE_ID }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const s = await read($, tqPane)
    const now = Date.now()

    const tabs = (
      <Box flexDirection="row" gap={1}>
        <Button key="tab:snaps" label={s.tab === 'snaps' ? '[Snapshots]' : 'Snapshots'} onPress={none} />
        <Button key="tab:report" label={s.tab === 'report' ? '[Reports]' : 'Reports'} onPress={none} />
      </Box>
    )

    const top = (
      <Box flexDirection="column">
        {s.busy !== undefined && <Text color="yellow">{s.busy}</Text>}
        {s.restoreOwed !== undefined && (
          <Box flexDirection="row" gap={1}>
            <Text color="green">Goes with your next message: {s.restoreOwed}</Text>
            <Button key="unrestore" label="Cancel" onPress={none} />
          </Box>
        )}
      </Box>
    )

    if (s.tab === 'report') {
      return (
        <Box flexDirection="column" gap={1}>
          {tabs}
          {top}
          <Box flexDirection="row" gap={1}>
            {REPORTS.map(([id, label]) => (
              <Button key={`report:${id}`} label={label} onPress={none} />
            ))}
          </Box>
          {s.report === undefined ? (
            <Text dimColor>Pick a report.</Text>
          ) : (
            <Box flexDirection="column">
              <Text bold>
                {s.report.title} <Text dimColor>· {ago(s.report.at, now)}</Text>
              </Text>
              {s.report.text.split('\n').map(line => (
                <Text>{line === '' ? ' ' : line}</Text>
              ))}
            </Box>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        {tabs}
        {top}
        <Input key="snapname" label="New snapshot:" placeholder="name (optional), Enter to save" submitLabel="save" onSubmit={none} />
        <Box flexDirection="row" gap={1}>
          <Button key="take" label="Take snapshot" onPress={none} />
          <Button key="refresh" label="Refresh" onPress={none} />
        </Box>
        {s.snaps.length === 0 ? (
          <Text dimColor>No snapshots yet. One is also taken before every compaction.</Text>
        ) : (
          <Box flexDirection="column">
            {s.snaps.slice(0, 30).map(x => (
              <Box flexDirection="column">
                <Box flexDirection="row" gap={1}>
                  <Text>
                    <Text bold>{x.name}</Text> <Text dimColor>· {x.project} · {x.at}</Text>
                  </Text>
                </Box>
                <Box flexDirection="row" gap={1}>
                  <Button key={`restore:${x.file}`} label={s.restoreOwed === x.file ? 'Attached' : 'Restore'} onPress={none} />
                  <Button key={`view:${x.file}`} label={s.preview?.file === x.file ? 'Hide' : 'View'} onPress={none} />
                </Box>
                {s.preview?.file === x.file &&
                  s.preview.text.split('\n').map(line => (
                    <Text dimColor>{line === '' ? ' ' : line}</Text>
                  ))}
              </Box>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
