/**
 * GH #85 (I-Am-LongXi): der VRAM-Handoff wirft das Textmodell fuer einen
 * Render aus dem Speicher und laedt es danach neu. Fuer die Built-in-Engine
 * hiess Neuladen bisher: die komplette Gespraechshistorie wird beim naechsten
 * Turn neu verarbeitet. llama-server kann den KV-Cache als Slot auf Platte
 * sichern und wiederherstellen; der Handoff nutzt das jetzt.
 *
 * Quellgepinnt auf beiden Seiten des Drahts: die Rust-Bruecke (der Webview
 * kommt am Engine-Port nicht vorbei) und die Reihenfolge im Handoff (sichern
 * VOR dem Stopp, wiederherstellen NACH dem Start, nur wenn das Sichern
 * gelang). Kein anderer Test sieht eine dieser Weichen.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const hier = dirname(fileURLToPath(import.meta.url))
const handoff = () => readFileSync(resolve(hier, '..', 'vram-handoff.ts'), 'utf8')
const engineRs = () => readFileSync(resolve(hier, '..', '..', '..', 'src-tauri', 'src', 'commands', 'engine.rs'), 'utf8')

describe('#85: KV-Slot ueberlebt den VRAM-Handoff', () => {
  it('die Rust-Bruecke trifft llama-servers /slots-API und der Start traegt den Slot-Pfad', () => {
    const src = engineRs()
    expect(src).toMatch(/\/slots\/0\?action=/)
    expect(src).toMatch(/--slot-save-path/)
    expect(src).toMatch(/pub async fn kv_slot_action/)
  })

  it('die Built-in-Engine wird als dritter Teilnehmer erkannt und mitgerechnet', () => {
    const src = handoff()
    expect(src).toMatch(/bundled_engine_status/)
    expect(src).toMatch(/bundledTarget\?\.modelBytes/)
    expect(src).toMatch(/textModel \|\| lmsTarget \|\| bundledTarget/)
  })

  it('gesichert wird VOR dem Stopp, wiederhergestellt NACH dem Start, und nur nach gelungenem Sichern', () => {
    const src = handoff()
    const save = src.indexOf("action: 'save'")
    const stop = src.indexOf("backendCall('stop_bundled_engine')")
    const start = src.indexOf('startBundledEngine(evictedBundled.modelPath)')
    const restore = src.indexOf("action: 'restore'")
    expect(save).toBeGreaterThan(-1)
    expect(stop).toBeGreaterThan(save)
    expect(start).toBeGreaterThan(stop)
    expect(restore).toBeGreaterThan(start)
    expect(src).toMatch(/if \(evictedBundled\.slotSaved\)/)
  })
})
