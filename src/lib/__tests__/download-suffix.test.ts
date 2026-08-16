import { describe, it, expect } from 'vitest'
import { downloadSuffix, formatEta } from '../formatters'

// #162: the bracket next to "Rebuilding the ComfyUI environment…" must say
// how big the download is, how fast it runs and roughly how long is left.
describe('downloadSuffix', () => {
  it('shows size, rate and remaining time while a total is known', () => {
    const s = downloadSuffix({ progress: 1024 ** 3, total: 2 * 1024 ** 3, speed: 10 * 1024 ** 2 })
    expect(s).toBe(' (1.0 GB of 2.0 GB, 10.0 MB/s, ~2 min left)')
  })

  it('reports seconds when the rest is short', () => {
    const s = downloadSuffix({ progress: 900 * 1024 ** 2, total: 1000 * 1024 ** 2, speed: 10 * 1024 ** 2 })
    expect(s).toBe(' (900.0 MB of 1000.0 MB, 10.0 MB/s, ~10s left)')
  })

  it('drops rate and remaining time when the rate is unknown', () => {
    const s = downloadSuffix({ progress: 512 * 1024 ** 2, total: 1024 ** 3, speed: 0 })
    expect(s).toBe(' (512.0 MB of 1.0 GB)')
  })

  it('stays empty before any download is announced', () => {
    // Negative control: the plain spinner must never grow a "(0 B of 0 B)".
    expect(downloadSuffix({ progress: 0, total: 0, speed: 0 })).toBe('')
  })

  it('never shows a negative remainder when progress overshoots the total', () => {
    const s = downloadSuffix({ progress: 1100, total: 1000, speed: 100 })
    expect(s).toContain('~0s left')
  })
})

describe('formatEta', () => {
  it('scales from seconds to minutes to hours', () => {
    expect(formatEta(45)).toBe('45s')
    expect(formatEta(102.4)).toBe('2 min')
    expect(formatEta(6600)).toBe('1 h 50 min')
  })
})
