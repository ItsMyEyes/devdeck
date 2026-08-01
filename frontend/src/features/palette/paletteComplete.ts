/**
 * Ghost text for the palette input, Fish-shell style.
 *
 * Returns the *suffix* to render after the caret, never the full candidate —
 * the ghost is a sibling element behind a transparent input, so it must not
 * repeat what the user already typed. Returning a suffix (rather than the
 * whole word) is also what guarantees the ghost can never be submitted: the
 * input's own value is never touched by this function.
 *
 * Completion applies to the last whitespace-delimited token only, so
 * `agent-new ac` completes the project name and leaves the verb intact.
 */
export function computeCompletion(query: string, candidate: string | undefined): string {
  if (!candidate) return ''

  const lastSpace = query.lastIndexOf(' ')
  const token = lastSpace === -1 ? query : query.slice(lastSpace + 1)
  if (!token) return ''

  const lowerToken = token.toLowerCase()
  const lowerCandidate = candidate.toLowerCase()
  if (!lowerCandidate.startsWith(lowerToken)) return ''
  if (lowerCandidate === lowerToken) return ''

  return candidate.slice(token.length)
}
