import { describe, it, expect, vi, beforeEach } from 'vitest'

// zustand persist reads window.localStorage at store-module load (node env
// has no DOM) — same hoisted Map shim as createStore.test.ts.
vi.hoisted(() => {
  const map = new Map<string, string>()
  const ls = {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => { map.set(k, String(v)) },
    removeItem: (k: string) => { map.delete(k) },
    clear: () => { map.clear() },
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() { return map.size },
  }
  ;(globalThis as unknown as { localStorage: unknown }).localStorage = ls
  const g = globalThis as unknown as { window?: Record<string, unknown> }
  g.window = Object.assign(g.window ?? {}, { localStorage: ls })
})

vi.mock('../../../../api/comfyui', () => ({
  getImageUrl: vi.fn((filename: string, subfolder?: string) => `http://127.0.0.1:8188/view?filename=${filename}&subfolder=${subfolder ?? ''}`),
  classifyModel: vi.fn(() => 'unknown'),
}))
vi.mock('../../../../api/cloud/jobs', () => ({
  refreshResultUrl: vi.fn(),
  resolveResultUrl: vi.fn(),
}))
// Only backendCall is faked — fetchLocalhostBytes/isTauri keep their real
// behaviour, which the ComfyUI-path tests below depend on.
vi.mock('../../../../api/backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../api/backend')>()),
  backendCall: vi.fn(),
}))

import { fetchGalleryItemBlob, recoverGalleryUrl, proxiedComfyBlobUrl } from '../galleryUrl'
import { refreshResultUrl, resolveResultUrl } from '../../../../api/cloud/jobs'
import { backendCall } from '../../../../api/backend'
import { useCreateStore, type GalleryItem } from '../../../../stores/createStore'

const baseItem: GalleryItem = {
  id: 'g1', filename: 'out.png', subfolder: '', type: 'image', prompt: '',
  negativePrompt: '', model: 'm', modelType: 'unknown', seed: 1, steps: 1,
  cfgScale: 1, sampler: 's', scheduler: 's', width: 8, height: 8,
  batchSize: 1, createdAt: 1,
} as GalleryItem

describe('fetchGalleryItemBlob', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    useCreateStore.setState({ gallery: [] })
  })

  it('returns the blob when the primary URL answers', async () => {
    const blob = new Blob(['x'], { type: 'image/png' })
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => blob })))
    await expect(fetchGalleryItemBlob({ ...baseItem, remoteUrl: 'https://cdn/x.png' })).resolves.toBe(blob)
  })

  it('re-signs an expired cloud URL once and retries (the "failed to fetch" ops bug)', async () => {
    const blob = new Blob(['y'], { type: 'image/png' })
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ ok: true, blob: async () => blob })
    vi.stubGlobal('fetch', fetchMock)
    vi.mocked(refreshResultUrl).mockResolvedValueOnce('https://cdn/fresh.png')
    const item = { ...baseItem, remoteUrl: 'https://cdn/expired.png', jobId: 'job-1' }
    useCreateStore.setState({ gallery: [item] })

    await expect(fetchGalleryItemBlob(item)).resolves.toBe(blob)
    expect(fetchMock).toHaveBeenLastCalledWith('https://cdn/fresh.png')
    // The gallery entry is patched so every surface re-renders with the fresh URL.
    expect(useCreateStore.getState().gallery[0].remoteUrl).toBe('https://cdn/fresh.png')
  })

  it('reports an honest error when the cloud copy is gone for good', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    vi.mocked(refreshResultUrl).mockResolvedValueOnce(null as unknown as string)
    await expect(fetchGalleryItemBlob({ ...baseItem, remoteUrl: 'https://cdn/x.png', jobId: 'job-2' }))
      .rejects.toThrow(/no longer available/)
  })

  it('explains the dead local ComfyUI /view URL instead of a bare TypeError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    await expect(fetchGalleryItemBlob(baseItem)).rejects.toThrow(/ComfyUI/)
  })
})

// Cloud renders are deleted after seven days (the Create banner says so, and
// services/render-worker/src/reaper.ts now does it). A tile whose render is
// gone must settle into an honest state, not retry a dead re-sign forever.
describe('recoverGalleryUrl — expired cloud renders', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    useCreateStore.setState({ gallery: [] })
  })

  const flush = () => new Promise((r) => setTimeout(r, 0))

  it('marks the tile unavailable when the render is gone for good', async () => {
    const item = { ...baseItem, id: 'gone-1', jobId: 'job-gone', remoteUrl: 'https://cdn/old.png' }
    useCreateStore.setState({ gallery: [item] })
    vi.mocked(resolveResultUrl).mockResolvedValueOnce({ kind: 'gone' })

    recoverGalleryUrl(item)
    await flush()
    expect(useCreateStore.getState().gallery[0].unavailable).toBe(true)
  })

  it('patches in the fresh URL when the render is still there', async () => {
    const item = { ...baseItem, id: 'ok-1', jobId: 'job-ok', remoteUrl: 'https://cdn/old.png' }
    useCreateStore.setState({ gallery: [item] })
    vi.mocked(resolveResultUrl).mockResolvedValueOnce({ kind: 'ok', url: 'https://cdn/new.png' })

    recoverGalleryUrl(item)
    await flush()
    expect(useCreateStore.getState().gallery[0].remoteUrl).toBe('https://cdn/new.png')
    expect(useCreateStore.getState().gallery[0].unavailable).toBeUndefined()
  })

  it('does NOT mark unavailable when we simply could not reach the server', async () => {
    // An offline launch must not look like a deleted render.
    const item = { ...baseItem, id: 'retry-1', jobId: 'job-retry', remoteUrl: 'https://cdn/old.png' }
    useCreateStore.setState({ gallery: [item] })
    vi.mocked(resolveResultUrl).mockResolvedValueOnce({ kind: 'retry' })

    recoverGalleryUrl(item)
    await flush()
    expect(useCreateStore.getState().gallery[0].unavailable).toBeUndefined()
  })
})

/**
 * Local MLX renders (Mac). partialize strips `dataUrl` on persist, so after a
 * restart the tile has only a filename — and galleryItemUrl turns that into a
 * ComfyUI /view URL, which on a Mac can never answer. Every locally generated
 * image therefore died on the next launch. The file on disk is the way back.
 */
describe('recoverGalleryUrl — local MLX renders on disk', () => {
  beforeEach(() => {
    vi.mocked(backendCall).mockReset()
    useCreateStore.setState({ gallery: [] })
    ;(URL as unknown as { createObjectURL: (b: unknown) => string }).createObjectURL = () => 'blob:restored'
  })

  const flush = () => new Promise((r) => setTimeout(r, 0))

  it('re-reads the file and hands the tile a fresh blob URL', async () => {
    const item = { ...baseItem, id: 'disk-ok', localPath: '/tmp/mlx-1.png' }
    useCreateStore.setState({ gallery: [item] })
    // base64 of "PNG" — content is irrelevant, the decode path is what matters.
    vi.mocked(backendCall).mockResolvedValueOnce('UE5H' as never)

    recoverGalleryUrl(item)
    await flush()
    expect(vi.mocked(backendCall)).toHaveBeenCalledWith('read_media_file', { path: '/tmp/mlx-1.png' })
    expect(useCreateStore.getState().gallery[0].dataUrl).toBe('blob:restored')
    expect(useCreateStore.getState().gallery[0].unavailable).toBeUndefined()
  })

  it('marks the tile unavailable when the file is gone', async () => {
    const item = { ...baseItem, id: 'disk-gone', localPath: '/tmp/deleted.png' }
    useCreateStore.setState({ gallery: [item] })
    vi.mocked(backendCall).mockRejectedValueOnce(new Error('no such file'))

    recoverGalleryUrl(item)
    await flush()
    expect(useCreateStore.getState().gallery[0].unavailable).toBe(true)
  })

  it('reads the file once, not on every remount', async () => {
    // Tiles call this from onError, which can fire repeatedly.
    const item = { ...baseItem, id: 'disk-once', localPath: '/tmp/mlx-2.png' }
    useCreateStore.setState({ gallery: [item] })
    vi.mocked(backendCall).mockResolvedValue('UE5H' as never)

    recoverGalleryUrl(item)
    await flush()
    recoverGalleryUrl(item)
    await flush()
    expect(vi.mocked(backendCall).mock.calls.length).toBe(1)
  })

  it('never asks ComfyUI about a file we own on disk', async () => {
    // Without this guard the recovery took a pointless round trip to port 8188
    // first — and on a Mac that happens to run ComfyUI for something else, it
    // asked the wrong server about a file it never made.
    const item = { ...baseItem, id: 'disk-noproxy', localPath: '/tmp/mlx-3.png' }
    expect(await proxiedComfyBlobUrl(item)).toBeNull()
  })

  it('still marks a ComfyUI item unavailable — no localPath, nothing to re-read', async () => {
    const item = { ...baseItem, id: 'comfy-dead' }
    useCreateStore.setState({ gallery: [item] })

    recoverGalleryUrl(item)
    await flush()
    expect(vi.mocked(backendCall)).not.toHaveBeenCalled()
    expect(useCreateStore.getState().gallery[0].unavailable).toBe(true)
  })
})
