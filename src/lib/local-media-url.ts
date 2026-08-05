/**
 * Turning a file this app wrote into something an <img> or <video> can show.
 *
 * B3 (2.6.3). The Mac MLX tool results used to embed a `blob:` URL straight
 * into the tool-result string. That string is PERSISTED with the conversation,
 * and a blob URL is scoped to the document that created it, so it broke in two
 * ways at once: the blob was never revoked, so every generated image stayed in
 * memory for the life of the window, and after a restart the persisted URL
 * pointed at nothing, so the picture silently vanished from the history.
 *
 * The Create gallery already solved this (see recoverGalleryUrl /
 * restoreFromDisk in components/create/experimental/galleryUrl.ts): keep the
 * PATH, which is stable, and rebuild a blob on demand. The bytes are already on
 * disk in both cases, written by the Rust side before the result is built, so
 * nothing has to be re-generated.
 */

import { backendCall } from '../api/backend'

/** `file://` is what marks a result line as OUR file rather than a ComfyUI URL. */
const FILE_URL_PREFIX = 'file://'

/** Wrap an absolute path so it survives in a result string as a real URL. */
export function pathToFileUrl(path: string): string {
  return FILE_URL_PREFIX + encodeURI(path.replace(/\\/g, '/'))
}

/** The path back out, or null when this is not one of ours. */
export function fileUrlToPath(url: string): string | null {
  if (!url.startsWith(FILE_URL_PREFIX)) return null
  try {
    return decodeURI(url.slice(FILE_URL_PREFIX.length))
  } catch {
    return null
  }
}

export function guessMimeFromName(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() || ''
  if (ext === 'mp4') return 'video/mp4'
  if (ext === 'webm') return 'video/webm'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  return 'image/png'
}

/**
 * Read a file this app wrote and hand back a fresh `blob:` URL for it.
 *
 * The caller owns the URL and MUST revoke it when the element goes away. That
 * is the whole difference from the old code: the blob's lifetime is now tied to
 * something that ends, instead of to a string that is stored forever.
 */
export async function readLocalFileAsBlobUrl(path: string): Promise<string> {
  const b64 = await backendCall<string>('read_media_file', { path })
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const name = path.split(/[\\/]/).pop() || ''
  return URL.createObjectURL(new Blob([bytes], { type: guessMimeFromName(name) }))
}
