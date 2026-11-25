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

## Compacting at a threshold, at the end of a stage

Turn on "Start compactions myself" (`own_triggers`) with Janitor mode `active`, and set "Compaction threshold" (`threshold_tokens`). Past the threshold a compaction waits, up to "Wait for a stage end" (`boundary_window_tokens`, 70k by default) more tokens, for the end of a stage: the task wrapped up, the plan or todo list done, a commit, or a reply to your own message that handed nothing off. At the top of that window it runs at the end of any turn. Keep threshold + window under the engine's own auto-compact.

## Work log

The mod keeps, outside the conversation, what the conversation handed off and what came back: each subagent (its task and its report), background commands, monitors and workflows, and the task notifications. Long reports are saved whole to `~/.claude/thriftquill/worklog/` and condensed by the small model (one call per report over 2000 characters). After every compaction (the janitor's, the engine's auto-compact, a `/compact`) the log of the current stage goes back to the model with the next message, and the summary is told to keep it, so a stage spread over agents is not forgotten halfway. A stage closes when it ends (as above); finished items then stay only as titles. Thriftquill pane → Reports → Work log shows it.

## Less in the context

- **Files attached again after a compaction.** The engine re-attaches the files the model read last. With `reattach_files` off (default) they are left out unless your message names them; the model reads a file again when it needs it.
- **`~/.claude/thriftquill/hide-tools.txt`**: one MCP prefix per line (`mcp__acme__`). Those deferred tools leave the "now available" notice and one line says how to find them; they stay callable.
- **`~/.claude/thriftquill/hide-skills.txt`**: `<skill prefix> [unless <file>]` per line, e.g. `unity: unless ProjectSettings/ProjectVersion.txt` lists the Unity skills only in a Unity project.

## Compaction by the small model (experimental)

Setting `compaction_model`:

- `session` (default): the engine compacts with the model of the session, reading the conversation from the prompt cache.
- `compare`: the same, and the small model (`claude-haiku-5-5`) writes its own summary of the same conversation on the side. The Thriftquill pane, Reports, **Compactions** shows for each compaction what both summaries cost (list prices) and how many of the conversation's key terms (file names, code spans) each kept; both summaries are saved to `~/.claude/thriftquill/compactions/` to read side by side.
- `small`: the small model writes the summary and the last messages stay as they are; the engine compacts only where the small model gives no answer.

Run `compare` for a while before choosing `small`: a summary is all that is left of the conversation after a compaction.
