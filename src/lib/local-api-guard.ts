/**
 * GitHub #115 (graysoncooper): browser voice recording always failed because
 * the /local-api security middleware enforced application/json on EVERY POST
 * body, and /local-api/transcribe is the one endpoint whose body IS the raw
 * recorded audio (audio/webm from Chrome's MediaRecorder, audio/mp4 from
 * Safari). The 415 fired before the whisper handler ever saw the request.
 *
 * This module is the pure decision the middleware applies, importable both
 * by vite.config.ts (Node side) and by vitest. The transcribe carve-out
 * swaps the JSON requirement for an audio requirement rather than dropping
 * the check: a JSON or text body on /transcribe is still refused, and every
 * other endpoint keeps the strict application/json rule. CSRF protection
 * (the x-locally-uncensored header and the origin check) stays on for
 * transcribe, the client sends the header like every backendCall does.
 *
 * `url` is mount-relative, the middleware mounts at '/local-api', so the
 * transcribe endpoint arrives here as '/transcribe'.
 */

/** The raw-audio POST endpoint. transcribe-status is a GET and stays under
 *  the JSON rule if anything ever POSTs to it. */
export function isTranscribePath(url: string | undefined): boolean {
  if (!url) return false
  return url === '/transcribe' || url.startsWith('/transcribe?')
}

/** Body types a MediaRecorder clip legitimately arrives as. */
function isAudioContentType(contentType: string): boolean {
  const ct = contentType.toLowerCase()
  return (
    ct.startsWith('audio/') ||
    // Chrome labels some Opus recordings video/webm even for audio-only.
    ct.startsWith('video/webm') ||
    ct.startsWith('application/octet-stream')
  )
}

/** The middleware's POST body verdict for a mount-relative /local-api URL. */
export function postContentTypeAllowed(url: string | undefined, contentType: string): boolean {
  if (isTranscribePath(url)) return isAudioContentType(contentType)
  return contentType.includes('application/json')
}

/** Matching 415 body, names what the endpoint actually accepts. */
export function postContentTypeError(url: string | undefined): string {
  return isTranscribePath(url)
    ? 'Unsupported Media Type: Must be an audio body (audio/*, video/webm or application/octet-stream)'
    : 'Unsupported Media Type: Must be application/json'
}
