/**
 * The document and viewport maths behind every HTML preview: the model-snippet
 * modal and, since 2.6.6 C3, the Explorer panel's file preview.
 *
 * Pulled out of HtmlPreviewModal so both surfaces build the identical document
 * and so this half is testable without a DOM.
 */

export type Viewport = 'mobile' | 'tablet' | 'desktop'

export const VIEWPORTS: Record<Viewport, { width: number; height: number }> = {
  mobile: { width: 375, height: 667 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1280, height: 800 },
}

/**
 * Wrap an HTML / SVG snippet so the iframe always has a sane shell.
 *   - Bare SVG becomes a centred dark page that hugs the artwork.
 *   - Snippet HTML (no html tag, no doctype) becomes a minimal document with
 *     utf-8 and body padding.
 *   - A full document is passed through untouched.
 *
 * Note for the panel preview: the document is handed to the iframe via
 * `srcDoc`, so relative assets next to the file (a css or js sibling) do NOT
 * load. That is a documented v1 limit (plan R2), not a bug.
 */
export function buildDocument(code: string, language?: string): string {
  const lang = (language || '').toLowerCase()
  const trimmed = code.trim()
  const lower = trimmed.toLowerCase()

  // Bare SVG.
  if (lang === 'svg' || (lower.startsWith('<svg') && lower.includes('xmlns'))) {
    return [
      '<!doctype html><html><head><meta charset="utf-8"><title>SVG Preview</title>',
      '<style>html,body{margin:0;padding:0;background:#0e0e0e;color:#fff;height:100%;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif}svg{max-width:100%;max-height:100%}</style>',
      '</head><body>',
      code,
      '</body></html>',
    ].join('')
  }

  // Already a full document.
  if (lower.startsWith('<!doctype') || lower.startsWith('<html')) {
    return code
  }

  // Snippet, so wrap it.
  return [
    '<!doctype html><html><head><meta charset="utf-8"><title>HTML Preview</title>',
    '<style>body{margin:0;padding:16px;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.5;background:#ffffff;color:#111}</style>',
    '</head><body>',
    code,
    '</body></html>',
  ].join('')
}
