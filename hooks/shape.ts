import { clipHead, clipTail } from './text'

// Shaping a tool result as it enters the conversation: a result longer than the cap keeps its start and its end, the whole
// text goes to a file, and the model is told where. Pure functions; the hook in register.ts does the writing.

export type Block = { type: string; [field: string]: unknown }

export type ShapeItem = { index: number; id: string; text: string }

// The text of a tool_result block when it is plain text (a string, or text blocks alone); undefined for anything else
// (an image, a document), which is never touched.
export const textOfResult = (block: Block): string | undefined => {
  const c = block.content

  if (typeof c === 'string') {
    return c
  }

  if (Array.isArray(c) && c.every((b): b is { type: 'text'; text: string } => typeof b === 'object' && b !== null && (b as Block).type === 'text' && typeof (b as Block).text === 'string')) {
    return c.map(b => b.text).join('\n')
  }

  return undefined
}

// The results that are longer than the cap. An error result is never cut: its text is what the model must read.
export const planShape = (blocks: readonly Block[], capChars: number): ShapeItem[] =>
  blocks.flatMap((b, index) => {
    if (b.type !== 'tool_result' || b.is_error === true || typeof b.tool_use_id !== 'string') {
      return []
    }

    const text = textOfResult(b)

    return text !== undefined && text.length > capChars ? [{ index, id: b.tool_use_id, text }] : []
  })

// Start and end of the text within the cap, and a line in the middle saying how much went where.
export const cutText = (text: string, capChars: number, path: string): string => {
  const head = Math.floor(capChars * 0.6)
  const tail = Math.floor(capChars * 0.25)
  const cut = text.length - head - tail

  return `${clipHead(text, head)}\n[… ${cut} characters left out here; the whole output is in ${path}: read it from there (a line range) if you need the middle …]\n${clipTail(text, tail)}`
}

// The blocks with the planned results replaced by their cut text, in the form they had (a string stays a string).
export const applyShape = (blocks: readonly Block[], items: readonly ShapeItem[], capChars: number, pathOf: (item: ShapeItem) => string): Block[] =>
  blocks.map((b, index) => {
    const item = items.find(i => i.index === index)

    if (item === undefined) {
      return b
    }

    const text = cutText(item.text, capChars, pathOf(item))

    return { ...b, content: typeof b.content === 'string' ? text : [{ type: 'text', text }] }
  })

// How many characters the plan takes out of the conversation: what is left out, less the line that says where it went.
export const charsCut = (items: readonly ShapeItem[], capChars: number): number => items.reduce((n, i) => n + i.text.length - cutText(i.text, capChars, '').length, 0)
