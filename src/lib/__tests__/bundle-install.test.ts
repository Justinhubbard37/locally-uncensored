import { describe, it, expect, vi } from 'vitest'
import {
  downloadBundleFiles, formatProgressLine, friendlyDownloadError, waitOrAbort,
  InstallCancelled, MAX_FILE_ATTEMPTS, type BundleFile, type DownloadDeps,
} from '../bundle-install'
import type { DownloadProgress } from '../../api/discover'

const FILE: BundleFile = {
  filename: 'wan2.1_vace_1.3B_fp16.safetensors',
  subfolder: 'diffusion_models',
  downloadUrl: 'https://example.invalid/vace.safetensors',
  sizeGB: 4.01,
}

function prog(over: Partial<DownloadProgress> = {}): DownloadProgress {
  return {
    progress: 0, total: 0, speed: 0, filename: FILE.filename, status: 'downloading', ...over,
  }
}

/** Deps with no real waiting, plus a scripted sequence of progress maps. */
function deps(
  rounds: Array<Record<string, DownloadProgress>>,
  over: Partial<DownloadDeps> = {},
): DownloadDeps & { lines: string[]; starts: number } {
  const lines: string[] = []
  let i = 0
  const d = {
    lines,
    starts: 0,
    start: vi.fn(async () => { d.starts++; return { status: 'started' } }),
    progress: vi.fn(async () => rounds[Math.min(i++, rounds.length - 1)]),
    onStatus: (m: string) => { lines.push(m) },
    wait: async () => { /* no real time in tests */ },
    ...over,
  } as DownloadDeps & { lines: string[]; starts: number }
  return d
}

describe('formatProgressLine', () => {
  it('reports percent, bytes and speed, because a bare percent does not answer "is it moving"', () => {
    const line = formatProgressLine(
      prog({ progress: 1_229_661_185, total: 4_309_519_800, speed: 3_049_536 }),
      FILE.filename,
      'File 1 of 3. ',
    )
    expect(line).toBe(
      'File 1 of 3. Downloading wan2.1_vace_1.3B_fp16.safetensors. 29%, 1.1 GB of 4.0 GB, 2.9 MB/s',
    )
  })

  it('degrades gracefully before the server reports a size', () => {
    expect(formatProgressLine(prog(), FILE.filename)).toBe(
      'Downloading wan2.1_vace_1.3B_fp16.safetensors.',
    )
  })
})

describe('friendlyDownloadError', () => {
  it('translates the raw reqwest text David actually hit', () => {
    const msg = friendlyDownloadError('Stream error: error decoding response body', FILE.filename)
    expect(msg).toContain('The connection dropped')
    expect(msg).toContain('kept')
    expect(msg).not.toContain('Stream error')
  })

  it('names the real cause for a full disk and for a blocked folder', () => {
    expect(friendlyDownloadError('No space left on device', FILE.filename)).toContain('ran out of space')
    expect(friendlyDownloadError('Access is denied. (os error 5)', FILE.filename)).toContain('Windows blocked')
  })

  it('keeps an unrecognised message visible instead of swallowing it', () => {
    const msg = friendlyDownloadError('kaboom', FILE.filename)
    expect(msg).toContain('kaboom')
  })
})

describe('waitOrAbort', () => {
  it('throws immediately when the signal is already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(waitOrAbort(60_000, ac.signal)).rejects.toBeInstanceOf(InstallCancelled)
  })

  it('returns early when the signal fires mid wait, and still reports the cancel', async () => {
    const ac = new AbortController()
    const started = Date.now()
    const p = waitOrAbort(30_000, ac.signal)
    ac.abort()
    await expect(p).rejects.toBeInstanceOf(InstallCancelled)
    expect(Date.now() - started).toBeLessThan(5_000)
  })
})

describe('downloadBundleFiles', () => {
  it('finishes when the file reports complete', async () => {
    const d = deps([
      { [FILE.filename]: prog({ progress: 10, total: 100 }) },
      { [FILE.filename]: prog({ status: 'complete', progress: 100, total: 100 }) },
    ])
    await downloadBundleFiles([FILE], d)
    expect(d.starts).toBe(1)
    expect(d.lines.at(-1)).toContain('done')
  })

  it('skips polling when the file is already on disk', async () => {
    const d = deps([{}], { start: vi.fn(async () => ({ status: 'exists' })) })
    await downloadBundleFiles([FILE], d)
    expect(d.progress).not.toHaveBeenCalled()
    expect(d.lines.at(-1)).toContain('already on disk')
  })

  it('registers the transfer with the tray before the first byte', async () => {
    const keepTrayLive = vi.fn()
    const d = deps([{ [FILE.filename]: prog({ status: 'complete' }) }], { keepTrayLive })
    await downloadBundleFiles([FILE], d)
    expect(keepTrayLive).toHaveBeenCalled()
  })

  it('resumes a dropped transfer instead of failing the bundle (Davids 1.2 GB of 4.3 GB death)', async () => {
    let call = 0
    const d = deps([], {
      progress: vi.fn(async () => {
        call++
        if (call === 1) return { [FILE.filename]: prog({ progress: 1_229_661_185, total: 4_309_519_800 }) }
        if (call === 2) {
          return {
            [FILE.filename]: prog({ status: 'error', error: 'Stream error: error decoding response body' }),
          }
        }
        return { [FILE.filename]: prog({ status: 'complete' }) }
      }),
    })
    await downloadBundleFiles([FILE], d)
    // Second start_model_download = the resume; Rust picks up from the .download temp.
    expect(d.starts).toBe(2)
    expect(d.lines.some((l) => l.includes('Resuming'))).toBe(true)
  })

  it('gives up after the attempt budget and says something a person can act on', async () => {
    const d = deps([{ [FILE.filename]: prog({ status: 'error', error: 'Stream error: error decoding response body' }) }])
    await expect(downloadBundleFiles([FILE], d)).rejects.toThrow(/connection dropped/i)
    expect(d.starts).toBe(MAX_FILE_ATTEMPTS)
  })

  it('treats a vanished entry as a cancel, because Rust only removes on cancel', async () => {
    const stop = vi.fn()
    const d = deps([
      { [FILE.filename]: prog({ progress: 5, total: 100 }) },
      {}, // cancel_download removed it
    ], { stop })
    await expect(downloadBundleFiles([FILE], d)).rejects.toBeInstanceOf(InstallCancelled)
    // A cancel must NOT be retried like a network blip.
    expect(d.starts).toBe(1)
  })

  it('does not mistake a slow first round for a cancel', async () => {
    const d = deps([
      {}, {}, // Rust has not registered it yet
      { [FILE.filename]: prog({ status: 'complete' }) },
    ])
    await expect(downloadBundleFiles([FILE], d)).resolves.toBeUndefined()
  })

  it('keeps waiting while the user has it paused in the tray', async () => {
    const d = deps([
      { [FILE.filename]: prog({ status: 'paused' }) },
      { [FILE.filename]: prog({ status: 'paused' }) },
      { [FILE.filename]: prog({ status: 'complete' }) },
    ])
    await downloadBundleFiles([FILE], d)
    expect(d.lines.some((l) => l.includes('paused'))).toBe(true)
  })

  it('stops the Rust transfer when the user cancels, not just the loop', async () => {
    const ac = new AbortController()
    const stop = vi.fn()
    const d = deps([{ [FILE.filename]: prog({ progress: 5, total: 100 }) }], {
      stop,
      signal: ac.signal,
      // Abort during the poll wait, the way the Cancel button does.
      wait: async () => { ac.abort(); if (ac.signal.aborted) throw new InstallCancelled() },
    })
    await expect(downloadBundleFiles([FILE], d)).rejects.toBeInstanceOf(InstallCancelled)
    expect(stop).toHaveBeenCalledWith(FILE.filename)
  })

  it('labels each file of a multi file bundle so the card shows where it is', async () => {
    const files: BundleFile[] = [
      FILE,
      { filename: 'umt5.safetensors', subfolder: 'text_encoders', downloadUrl: 'https://x.invalid/a', sizeGB: 6.27 },
    ]
    let n = 0
    const d = deps([], {
      progress: vi.fn(async () => {
        n++
        const name = n <= 2 ? FILE.filename : 'umt5.safetensors'
        return { [name]: prog({ filename: name, status: n % 2 === 0 ? 'complete' : 'downloading', progress: 1, total: 2 }) }
      }),
    })
    await downloadBundleFiles(files, d)
    expect(d.lines.some((l) => l.startsWith('File 1 of 2.'))).toBe(true)
    expect(d.lines.some((l) => l.startsWith('File 2 of 2.'))).toBe(true)
  })

  it('ignores catalogue rows that have no usable download url', async () => {
    const d = deps([{ [FILE.filename]: prog({ status: 'complete' }) }])
    await downloadBundleFiles(
      [{ filename: 'x', subfolder: '', downloadUrl: '', sizeGB: 1 }, FILE],
      d,
    )
    expect(d.starts).toBe(1)
  })
})
