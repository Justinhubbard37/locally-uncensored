/**
 * Every drop zone in the app was dead on Windows.
 *
 * ElBiggus mentioned it in one clause of issue #111: dragging images onto the
 * Character Studio board does nothing, picking them through the dialog works.
 * That pairing is the tell. The handler is fine (Stage.tsx, TrainSetBoard):
 * onDragOver preventDefault, onDrop reads dataTransfer.files. It never runs.
 *
 * Tauri owns drag and drop by default. With `dragDropEnabled` true, which is
 * the default, the webview hands the OS drop to Tauri and the HTML5 events
 * never fire in the page. Tauri's own docs say disabling it is required to use
 * the HTML5 drag and drop API on Windows. Nothing on the Rust side listens for
 * those events, so we were paying for a feature we do not use with three
 * features we do.
 *
 * It is one word in tauri.conf.json, and it revives three drop zones, not the
 * one that got reported: the training board, the chat composer and the RAG
 * panel. A config value has no runtime to test, so this file guards the two
 * halves of the reasoning instead: the value itself, and the assumption that
 * makes the value safe.
 *
 * Run: npx vitest run src/lib/__tests__/html5-drop-enabled.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const conf = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'))

function walk(dir: string, hit: (file: string, body: string) => void): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, hit)
    else if (/\.(ts|tsx|rs)$/.test(entry)) hit(full, readFileSync(full, 'utf8'))
  }
}

describe('the webview keeps its own drag and drop', () => {
  it('dragDropEnabled is off on the main window', () => {
    expect(conf.app.windows[0].dragDropEnabled).toBe(false)
  })

  it('every window declares it, not just the first one', () => {
    // A second window added later would silently be born with the default.
    for (const w of conf.app.windows) expect(w.dragDropEnabled).toBe(false)
  })
})

describe('the assumptions that make it safe', () => {
  it('the frontend really does use HTML5 drops, so the setting earns its place', () => {
    const zones: string[] = []
    walk(join(root, 'src'), (file, body) => {
      if (body.includes('onDrop=') && body.includes('dataTransfer')) zones.push(file)
    })
    expect(zones.length).toBeGreaterThanOrEqual(3)
    expect(zones.some((f) => f.endsWith('Stage.tsx'))).toBe(true)
  })

  it('nothing on the Rust side listens for the Tauri drop events', () => {
    // The day someone wires a native drop handler, this setting starts costing
    // something and the trade has to be made deliberately, not discovered.
    const users: string[] = []
    walk(join(root, 'src-tauri/src'), (file, body) => {
      if (/DragDrop|drag_drop|FileDrop|file_drop/.test(body)) users.push(file)
    })
    expect(users).toEqual([])
  })
})
