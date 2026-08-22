/**
 * Z36 finding 3 (W3 run 2026-08-16): once one real tool success sits in the
 * run history, the model starts fabricating the next ones. It wrote confident
 * final answers citing links no tool ever returned, without emitting a tool
 * call. The G14 family guards text the APP invents; here the MODEL is the
 * author, so the app has to notice it deterministically: a URL in the final
 * answer that appears nowhere in what the model was shown (system prompt,
 * history, tool results) cannot have come from a tool.
 *
 * Contract with useAgentChat: one corrective steer gives the model the chance
 * to really search or to retract. If it insists, the answer stands untouched
 * (it is the model's text, G14-2) and the bubble carries a labelled app
 * notice naming the unverified links.
 *
 * Matching is biased towards under-flagging on purpose: a link only counts
 * as invented when its normalized form (no protocol, no www, no fragment, no
 * trailing slash, lowercased) is absent from the ENTIRE shown corpus as a
 * substring. A tool result that mentions the bare domain path without a
 * protocol therefore still backs the pretty https link in the answer.
 */

const URL_RE = /https?:\/\/[^\s<>"'`()[\]{}|\\^]+/gi

/** Trailing sentence punctuation is prose, not part of the URL. */
function trimTrailingPunctuation(url: string): string {
  return url.replace(/[.,;:!?]+$/, '')
}

/** Every http(s) URL in the text, in order, trailing punctuation trimmed. */
export function extractUrls(text: string): string[] {
  if (!text) return []
  const found = text.match(URL_RE) ?? []
  return found.map(trimTrailingPunctuation).filter((u) => u.length > 0)
}

/** Comparison form: lowercased, protocol, leading www, fragment and one
 *  trailing slash removed. The query string stays, a different query is a
 *  different resource. */
export function normalizeUrl(raw: string): string {
  let u = trimTrailingPunctuation(raw.trim())
  u = u.replace(/^https?:\/\//i, '')
  u = u.replace(/^www\./i, '')
  u = u.replace(/#.*$/, '')
  if (u.endsWith('/')) u = u.slice(0, -1)
  return u.toLowerCase()
}

/**
 * URLs in `answer` that appear nowhere in `shownToModel` (the concatenated
 * text of everything the model was shown this run). Returned in the exact
 * spelling the model used, deduplicated by normalized form. Empty when the
 * answer carries no URLs at all.
 */
export function findUnbackedLinks(answer: string, shownToModel: string): string[] {
  const urls = extractUrls(answer)
  if (urls.length === 0) return []
  const corpus = (shownToModel ?? '').toLowerCase()
  const seen = new Set<string>()
  const out: string[] = []
  for (const url of urls) {
    const norm = normalizeUrl(url)
    if (!norm || seen.has(norm)) continue
    if (corpus.includes(norm)) continue
    seen.add(norm)
    out.push(url)
  }
  return out
}

/** The one corrective user turn. Direct, names every invented link, offers
 *  the two honest ways out (really search, or retract). */
export function unbackedLinksSteer(links: string[]): string {
  const list = links.join(', ')
  const noun = links.length === 1 ? 'a link that no tool returned' : `${links.length} links that no tool returned`
  const these = links.length === 1 ? 'this link' : 'these links'
  return (
    `Stop: your answer presents ${noun} in this run: ${list}. ` +
    `You must not invent URLs or cite sources you did not actually open. ` +
    `Either call a tool now to really find the source, or rewrite your final answer ` +
    `without ${these} and say plainly which part is unverified.`
  )
}

/** Badge label under the bubble once the steer was ignored. null when there
 *  is nothing to flag, so the caller renders nothing. */
export function unbackedLinksNotice(links?: string[]): string | null {
  if (!links || links.length === 0) return null
  const shorten = (u: string) => {
    const s = u.replace(/^https?:\/\//i, '')
    return s.length > 60 ? s.slice(0, 57) + '...' : s
  }
  const shown = links.slice(0, 3).map(shorten).join(', ')
  const more = links.length > 3 ? ` and ${links.length - 3} more` : ''
  return links.length === 1
    ? `This link came from the model, not from any tool result: ${shown}`
    : `${links.length} links came from the model, not from any tool result: ${shown}${more}`
}
