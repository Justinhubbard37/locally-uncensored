/**
 * Vision feedback needs the bytes of the image the agent just made — that is
 * what stops the model describing its own render from the prompt alone.
 *
 * On Windows the render is a ComfyUI /view URL and the localhost proxy fetches
 * it. On macOS the MLX lane hands back a `blob:` URL (an in-memory PNG, no
 * server at all), which the proxy cannot fetch: it threw, buildVisionFeedback
 * swallowed the error, and the step silently did nothing. These pin the source
 * dispatch so a Mac render reaches the model.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const fetchLocalhostBytes = vi.fn()
vi.mock('../backend', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../backend')>()),
  fetchLocalhostBytes: (...a: unknown[]) => fetchLocalhostBytes(...a),
}))

import { fetchComfyImageBase64 } from '../comfyui'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
const PNG_B64 = 'iVBORw=='

beforeEach(() => {
  fetchLocalhostBytes.mockReset()
  vi.stubGlobal('fetch', vi.fn(async () => ({ arrayBuffer: async () => PNG.buffer })))
})

describe('fetchComfyImageBase64 — where the bytes come from', () => {
  it('reads a blob: URL directly, never through the localhost proxy', async () => {
    // The Mac path. Routing this through the proxy is what made the agent
    // hallucinate its own picture.
    const b64 = await fetchComfyImageBase64('blob:http://localhost/9f2a-1')
    expect(b64).toBe(PNG_B64)
    expect(fetchLocalhostBytes).not.toHaveBeenCalled()
  })

  it('reads a data: URL directly too', async () => {
    const b64 = await fetchComfyImageBase64('data:image/png;base64,iVBORw==')
    expect(b64).toBe(PNG_B64)
    expect(fetchLocalhostBytes).not.toHaveBeenCalled()
  })

  it('still proxies a real ComfyUI /view URL', async () => {
    // Windows must be untouched: that URL is a server the WebView cannot read
    // cross-origin, which is the whole reason the proxy exists.
    fetchLocalhostBytes.mockResolvedValueOnce(PNG)
    const url = 'http://127.0.0.1:8188/view?filename=out.png'
    expect(await fetchComfyImageBase64(url)).toBe(PNG_B64)
    expect(fetchLocalhostBytes).toHaveBeenCalledWith(url)
  })
})
