/** Turn the ComfyUI output tail into an error a person can act on. The last
 *  lines of a startup crash name the real problem (a torch import error, a
 *  missing DLL, an OOM); without them the message was a dead end (GH #98). */
export function comfyStartupError(lines?: string[]): string {
  const tail = (lines ?? []).map((l) => l.trim()).filter(Boolean).slice(-6)
  const base = 'Installed ComfyUI but it did not come up.'
  if (!tail.length) return `${base} Check Settings → AI Backends.`
  return `${base} Its last output:\n${tail.join('\n')}`
}
