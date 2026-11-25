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

## Compacting at a threshold, at a good moment

Turn on "Start compactions myself" (`own_triggers`) with Janitor mode `active`, and set "Compaction threshold" (`threshold_tokens`, 100k–900k): at the end of a turn where the context has reached it, the janitor compacts. With "Wait for agents at work" (`wait_for_agents`, on by default) a due compaction waits while subagents of the session are still running and runs at the end of the turn that takes their reports, so a stage is summarized whole; past 1.25 × the threshold it no longer waits. Every summary (this one, the engine's auto-compact, a `/compact`) is also given the list of the session's agents, with the instruction to keep what each one did.

## Compaction by the small model (experimental)

Setting `compaction_model`:

- `session` (default): the engine compacts with the model of the session, reading the conversation from the prompt cache.
- `compare`: the same, and the small model (`claude-haiku-5-5`) writes its own summary of the same conversation on the side. The Thriftquill pane, Reports, **Compactions** shows for each compaction what both summaries cost (list prices) and how many of the conversation's key terms (file names, code spans) each kept; both summaries are saved to `~/.claude/thriftquill/compactions/` to read side by side.
- `small`: the small model writes the summary and the last messages stay as they are; the engine compacts only where the small model gives no answer.

Run `compare` for a while before choosing `small`: a summary is all that is left of the conversation after a compaction.
