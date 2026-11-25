// /tools suggest: rules for tool-defer.txt drawn from what the person actually calls.

export type ToolRow = { name: string; tokens: number; mcp: boolean }

export type Suggestion = { lines: string[]; kept: string[]; deferredTokens: number }

const serverOf = (name: string) => /^(mcp__[^_]+(?:_[^_]+)*?__)/.exec(name)?.[1]

// For each MCP server: defer all its tools when none of them is in the hot set, otherwise keep the hot ones and defer the
// rest by name. Built-in tools that are not hot and not already kept are listed for the person to decide; nothing is
// deferred for them without a word, since the engine's own placement is usually right for a built-in.
export const suggestRules = (tools: readonly ToolRow[], hot: ReadonlySet<string>): Suggestion => {
  const lines: string[] = ['# suggested by /tools suggest from the tools used in recent sessions; review before using']
  const kept: string[] = []
  let deferredTokens = 0
  const byServer = new Map<string, ToolRow[]>()

  for (const t of tools) {
    const s = t.mcp ? serverOf(t.name) : undefined

    if (s !== undefined) {
      byServer.set(s, [...(byServer.get(s) ?? []), t])
    }
  }

  for (const [server, rows] of [...byServer].sort((a, b) => b[1].reduce((n, r) => n + r.tokens, 0) - a[1].reduce((n, r) => n + r.tokens, 0))) {
    const used = rows.filter(r => hot.has(r.name))

    if (used.length === 0) {
      lines.push(`defer ${server}`)
      deferredTokens += rows.reduce((n, r) => n + r.tokens, 0)

      continue
    }

    for (const r of used) {
      lines.push(`keep ${r.name}`)
      kept.push(r.name)
    }

    for (const r of rows.filter(x => !hot.has(x.name))) {
      lines.push(`defer ${r.name}`)
      deferredTokens += r.tokens
    }
  }

  return { lines, kept, deferredTokens }
}
