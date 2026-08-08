/** "47s", "1m 05s", "12m 03s". The run anchor's clock (G14-6). */
export function formatElapsed(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const mins = Math.floor(s / 60)
  const secs = s % 60
  if (mins === 0) return `${secs}s`
  return `${mins}m ${String(secs).padStart(2, '0')}s`
}
