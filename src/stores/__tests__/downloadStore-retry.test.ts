/**
 * Retrying a failed model download must clear BOTH sides (2026-07-28)
 *
 * An errored entry lives in the Rust download map as well as in this store.
 * retry() only deleted the frontend row, and download_model short-circuits
 * with "exists" when the file is already on disk — never touching that map. So
 * the next refresh() re-read the old error and the card the user had just
 * retried came back, making the model look permanently broken. dismiss() had
 * already learned this (the_mr_pickles); retry() had not.
 *
 * Run: npx vitest run src/stores/__tests__/downloadStore-retry.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const cancelDownload = vi.fn(async () => {})
const startModelDownload = vi.fn(async () => {})
const startModelDownloadToPath = vi.fn(async () => {})
const getDownloadProgress = vi.fn(async () => ({}))

vi.mock('../../api/discover', () => ({
  getDownloadProgress: (...a: any[]) => getDownloadProgress(...(a as [])),
  pauseDownload: vi.fn(async () => {}),
  cancelDownload: (...a: any[]) => cancelDownload(...(a as [])),
  resumeDownload: vi.fn(async () => {}),
  startModelDownload: (...a: any[]) => startModelDownload(...(a as [])),
  startModelDownloadToPath: (...a: any[]) => startModelDownloadToPath(...(a as [])),
  lookupFileMeta: () => undefined,
}))

import { useDownloadStore } from '../downloadStore'

function seedErrored(id: string) {
  useDownloadStore.setState({
    downloads: {
      [id]: { progress: 10, total: 100, speed: 0, filename: id, status: 'error', error: 'boom' } as any,
    },
    downloadMeta: { [id]: { url: 'https://example.test/m.safetensors', subfolder: 'checkpoints' } },
  })
}

describe('downloadStore.retry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useDownloadStore.setState({ downloads: {}, downloadMeta: {} })
    useDownloadStore.getState().stopPolling()
  })

  it('clears the errored entry on the Rust side before restarting', async () => {
    seedErrored('model.safetensors')
    await useDownloadStore.getState().retry('model.safetensors')

    expect(cancelDownload).toHaveBeenCalledWith('model.safetensors')
    expect(startModelDownload).toHaveBeenCalledWith(
      'https://example.test/m.safetensors',
      'checkpoints',
      'model.safetensors',
    )
    expect(useDownloadStore.getState().downloads['model.safetensors']).toBeUndefined()
    useDownloadStore.getState().stopPolling()
  })

  it('does not cancel a transfer that is merely paused', async () => {
    useDownloadStore.setState({
      downloads: {
        'm.gguf': { progress: 5, total: 100, speed: 0, filename: 'm.gguf', status: 'paused' } as any,
      },
      downloadMeta: { 'm.gguf': { url: 'https://example.test/m.gguf', subfolder: 'unet' } },
    })
    await useDownloadStore.getState().retry('m.gguf')

    expect(cancelDownload).not.toHaveBeenCalled()
    expect(startModelDownload).toHaveBeenCalled()
    useDownloadStore.getState().stopPolling()
  })
})
