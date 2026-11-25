// Cutting text by characters without splitting a surrogate pair (an emoji, a rare character): a lone half would reach the model.

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff

const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff

// The first `n` characters of `s`, backing off one when the cut would fall inside a pair.
export const clipHead = (s: string, n: number): string => {
  const c = s.slice(0, Math.max(0, n))

  return c.length > 0 && isHigh(c.charCodeAt(c.length - 1)) ? c.slice(0, -1) : c
}

// The last `n` characters of `s`, moving on by one when the cut would fall inside a pair.
export const clipTail = (s: string, n: number): string => {
  if (n <= 0) {
    return ''
  }

  const c = s.slice(Math.max(0, s.length - n))

  return c.length > 0 && isLow(c.charCodeAt(0)) ? c.slice(1) : c
}
