/**
 * GH #109 (ElBiggus): "I put a couple in ...\ComfyUI\models\loras but I can't
 * see any way of activating them."
 *
 * Der LoRA-Stack existierte laengst: Store, Slider, Multi-LoRA-Kettung im
 * Builder, sogar der Trainer legt fertige Charaktere in models/loras ab. Aber
 * die Sektion war unsichtbar, solange die Liste leer war, und die Liste wurde
 * genau einmal beim Connect geholt. Wer eine Datei danach in den Ordner legte,
 * sah bis zum App-Neustart nichts, und wer den Ordner nicht kannte, erfuhr ihn
 * nirgends. Genau ElBiggus' Lauf.
 *
 * Quellgepinnt, weil beide Fixes reine Sichtbarkeits- und Verdrahtungs-
 * bedingungen sind, die kein bestehender Test bemerkt.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const hier = dirname(fileURLToPath(import.meta.url))
const lies = (f: string) => readFileSync(resolve(hier, '..', f), 'utf8')

describe('der LoRA-Stack ist auffindbar (#109)', () => {
  it('die Sektion steht, sobald die Spur LoRAs kann, nicht erst wenn die Liste voll ist', () => {
    const src = lies('ParamGroups.tsx')
    expect(src).not.toMatch(/loraSupported && loraList\.length > 0/)
    expect(src).toMatch(/\{loraSupported && \(/)
  })

  it('der leere Zustand nennt den Ordner und bietet einen Rescan an', () => {
    const src = lies('ParamGroups.tsx')
    expect(src).toMatch(/models\/loras/)
    expect(src).toMatch(/Rescan/)
    expect(src).toMatch(/refreshModelLists\s*\}\s*=\s*useCreateExp\(\)/)
  })

  it('der Kontext stellt den Refresh bereit und der Connect-Pfad nutzt ihn', () => {
    const src = lies('CreateContext.tsx')
    expect(src).toMatch(/refreshModelLists: \(\) => Promise<void>/)
    expect(src).toMatch(/const refreshModelLists = useCallback/)
    expect(src).toMatch(/refreshModelLists\(\) \}, \[refreshModelLists\]\)/)
  })

  it('ein Rescan liest wirklich frisch statt aus dem Node-Cache', () => {
    const src = lies('CreateContext.tsx')
    expect(src).toMatch(/getAllNodeInfo\(true\)/)
  })
})
