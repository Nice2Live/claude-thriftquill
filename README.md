# thriftquill

Spends fewer tokens and less of your limits in long Claude Code sessions. Archives big old tool output before a compaction (so the summary call reads less), compacts while the prompt cache is still warm, stops repeated skill and tool listings from being resent, and moves tool descriptions behind ToolSearch by rules you write.

Everything that changes your session starts in shadow mode: the mod only says what it would do until you set `mode` or `idle_mode` to `active`. A memory service is optional and only used to store the session handoff.

Commands: `/janitor`, `/tools`. Full description, settings and caveats are in the [repository README](../../README.md).


## Install

At the prompt of a Claude Code terminal session:

```
/plugin install thriftquill --marketplace Nice2Live/claude-thriftquill
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```
claude plugin install thriftquill --marketplace Nice2Live/claude-thriftquill
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `Nice2Live/claude-thriftquill`, then Add plugin.

Or just ask Claude in any session: "install the thriftquill mod from Nice2Live/claude-thriftquill".

## Context snapshots

- `/snap [name]` — the small model presses the conversation into a snapshot (goal, decisions with reasons, current state, files, next steps, open questions) and saves it to `~/.claude/thriftquill/snapshots/`; a copy goes to memory with the tags `snapshot` and `project:<folder>` (setting `snapshot_memory`).
- `/snap list`, `/snap show N|name` — the saved snapshots.
- `/restore`, `/restore N|name` — attaches a snapshot to your next message, in this chat or any other (no argument: the newest of this project).
- Before every compaction a snapshot is taken automatically (setting `snapshot_on_compact`).

## The Thriftquill pane

`/snap` opens it. **Snapshots**: a name field and Take snapshot, every snapshot with Restore and View. **Reports**: Savings & cost, Compaction, Tools, Health, Trace. `/janitor …` and `/tools` reports open there instead of the chat; the per-answer cost line and the dedup lines go to the debug log.
