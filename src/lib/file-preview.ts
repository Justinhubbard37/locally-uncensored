/**
 * Which preview a clicked file gets in the Explorer panel (2.6.6 C3), and the
 * sandbox the HTML one runs in.
 *
 * SECURITY (plan C3, round 2): the user clicked a file to LOOK at it, not to
 * run the repository's JavaScript. So the explorer's HTML preview starts with
 * an empty sandbox attribute, which is the fully restricted iframe, and gains
 * `allow-scripts` only after an explicit per-file opt-in. `allow-same-origin`
 * is never granted anywhere: together with allow-scripts it would let the page
 * reach out of the frame and into the app's own origin.
 */

export type PreviewKind = 'text' | 'image' | 'html' | 'binary'

/** Lowercase extension without the dot. Reads the tail of the NAME only, so
 *  no path is ever taken apart (plan R2, Windows parity). */
export function extensionOf(name: string): string {
  const m = /\.([^.\\/]+)$/.exec(name || '')
  return m ? m[1].toLowerCase() : ''
}

const IMAGE_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg',
])

const HTML_EXT = new Set(['html', 'htm', 'xhtml'])

const BINARY_EXT = new Set([
  'pdf', 'zip', 'gz', 'bz2', 'xz', 'tar', 'rar', '7z', 'exe', 'dll', 'so',
  'dylib', 'bin', 'wasm', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp3', 'mp4',
  'mov', 'avi', 'mkv', 'wav', 'flac', 'ogg', 'webm', 'psd', 'class', 'jar',
  'pyc', 'db', 'sqlite', 'sqlite3', 'dmg', 'iso', 'gguf', 'safetensors',
  'ckpt', 'pt', 'pth', 'onnx',
])

export function previewKindFor(name: string): PreviewKind {
  const ext = extensionOf(name)
  if (IMAGE_EXT.has(ext)) return 'image'
  if (HTML_EXT.has(ext)) return 'html'
  if (BINARY_EXT.has(ext)) return 'binary'
  return 'text'
}

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  svg: 'image/svg+xml',
}

/** Content type for the blob the image preview builds from the jailed bytes. */
export function imageMimeFor(name: string): string {
  return MIME[extensionOf(name)] ?? 'application/octet-stream'
}

const LANGUAGE: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript',
  cjs: 'javascript', json: 'json', md: 'markdown', markdown: 'markdown',
  css: 'css', scss: 'scss', less: 'less', html: 'html', htm: 'html',
  xml: 'xml', yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: 'ini',
  rs: 'rust', py: 'python', rb: 'ruby', go: 'go', java: 'java', kt: 'kotlin',
  swift: 'swift', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp',
  cs: 'csharp', php: 'php', sh: 'bash', bash: 'bash', zsh: 'bash',
  ps1: 'powershell', bat: 'batch', sql: 'sql', graphql: 'graphql',
  dockerfile: 'docker', lua: 'lua', r: 'r', dart: 'dart', vue: 'markup',
  svelte: 'markup', tf: 'hcl', gradle: 'groovy',
}

/** Prism language tag for the syntax highlighter, 'text' when unknown. */
export function previewLanguageFor(name: string): string {
  const ext = extensionOf(name)
  if (LANGUAGE[ext]) return LANGUAGE[ext]
  if (/^dockerfile$/i.test(name)) return 'docker'
  if (/^makefile$/i.test(name)) return 'makefile'
  return 'text'
}

/** A minified bundle is one line of two million characters, and the
 *  highlighter would chew on it for minutes. */
export const PREVIEW_TEXT_CAP = 200_000

export function capPreviewText(text: string): { text: string; truncated: boolean } {
  if (text.length <= PREVIEW_TEXT_CAP) return { text, truncated: false }
  return { text: text.slice(0, PREVIEW_TEXT_CAP), truncated: true }
}

/**
 * The iframe sandbox for a preview. Empty string = every restriction on, which
 * is the explorer default. `allow-same-origin` is deliberately absent from both
 * branches: an opaque origin is what keeps previewed markup away from the app.
 */
export function sandboxAttr(allowScripts: boolean): string {
  return allowScripts ? 'allow-scripts' : ''
}
