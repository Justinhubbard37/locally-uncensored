/**
 * Regression: the downloads tray opens itself when a download starts, but had
 * no way back. Cancel the download (or let the last file finish) and the panel
 * kept hanging over the app reading "No active downloads" until the user
 * happened to mousedown somewhere else. Seen live on 2026-07-26 while the tray
 * sat on top of the cloud retention banner.
 *
 * There is no render harness in this repo (no @testing-library), so this guards
 * the source for the three pieces of the fix, in the same style as
 * AppShell-backend-autoenable.test.ts. The behaviour itself is covered by the
 * CDP run on the ship exe: tray opens on start, closes on cancel.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const src = readFileSync(join(__dirname, '../DownloadBadge.tsx'), 'utf8')

describe('DownloadBadge tray auto-close', () => {
  it('remembers that the tray opened itself', () => {
    expect(src).toMatch(/const autoOpened = useRef\(false\)/)
    // The auto-open effect must set the flag, not just open the panel.
    expect(src).toMatch(/if \(totalActive > 0\) \{ setOpen\(true\); autoOpened\.current = true \}/)
  })

  it('closes again when the list empties, but only if it opened itself', () => {
    expect(src).toMatch(/if \(!hasAny && autoOpened\.current\) \{ setOpen\(false\); autoOpened\.current = false \}/)
    // Keyed on hasAny (every entry, not just active ones) so a finished row is
    // still readable until it is cleared.
    expect(src).toMatch(/\}, \[hasAny\]\)/)
  })

  it('leaves a hand-opened tray alone', () => {
    // Clicking the trigger drops the flag, so the close effect skips it.
    expect(src).toMatch(/onClick=\{\(\) => \{ setOpen\(!open\); autoOpened\.current = false \}\}/)
  })
})
