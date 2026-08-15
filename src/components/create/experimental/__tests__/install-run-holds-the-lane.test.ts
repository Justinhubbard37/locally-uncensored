/**
 * Ein halb installiertes Buendel ist waehlbar, lange bevor es benutzbar ist.
 *
 * Gemessen auf der Box 2026-08-15: bei 88 Prozent des Wan 2.2 Buendels war
 * `wan2.2_ti2v_5B_fp16.safetensors` fertig und damit in der Spurliste, die
 * Installationskarte verschwand, und `wan2.2_vae.safetensors` stand bei
 * 2 Prozent. Ein Klick auf Create haette einen ComfyUI-Fehler ueber eine Datei
 * gebracht, die gerade noch geladen wird.
 *
 * Beide Stellen quellgepinnt, weil der ganze Fix jeweils eine Bedingung ist
 * und kein anderer Test es merken wuerde.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const hier = dirname(fileURLToPath(import.meta.url))
const lies = (f: string) => readFileSync(resolve(hier, '..', f), 'utf8')

describe('ein laufender Install haelt die Spur', () => {
  it('die Karte bleibt stehen, solange der Lauf laeuft', () => {
    const src = lies('Stage.tsx')
    expect(src).toMatch(/} else if \(modelsMissing \|\| installRun\) \{/)
    expect(src).toMatch(/getInstallRun\(meta\.requiresModels\)\.running/)
  })

  it('Create bleibt gesperrt, solange der Lauf laeuft', () => {
    const src = lies('Composer.tsx')
    const gate = src.slice(src.indexOf('const canGenerate ='), src.indexOf('const showNoPromptHint'))
    expect(gate).toMatch(/!installing/)
  })

  it('nur lokal, ein Cloud-Lauf braucht aus dem Download nichts', () => {
    const src = lies('Composer.tsx')
    expect(src).toMatch(/backend === 'local' && meta\.requiresModels \? getInstallRun\(meta\.requiresModels\)\.running : false/)
  })
})
