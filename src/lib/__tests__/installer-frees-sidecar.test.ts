/**
 * The Windows installer has to free our own engine before it copies over it.
 *
 * aldrich_ironhart, 2026-08-10: the update died on "Error opening file for
 * writing: D:\Locally Uncensored\llama-server.exe". Windows locks a running
 * image, and the hook that kills our processes was compiled away in every
 * normal build (it sat behind a productName check that is false today), so
 * nothing ever stopped the sidecar.
 *
 * The name is the fragile part: it appears in the bundle config, in Rust, and
 * in the installer, and a rename in one of them makes the hook silently do
 * nothing again. So all three are compared here, not just the hook.
 *
 * Run: npx vitest run src/lib/__tests__/installer-frees-sidecar.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../..')
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8')

const hooks = read('src-tauri/windows/installer-hooks.nsh')
const engineRs = read('src-tauri/src/commands/engine.rs')
const conf = JSON.parse(read('src-tauri/tauri.conf.json')) as {
  bundle?: { externalBin?: string[] }
}

describe('the installer frees the bundled engine', () => {
  it('runs the unlock on every build, not only on a product rename', () => {
    const preinstall = hooks.slice(hooks.indexOf('!macro NSIS_HOOK_PREINSTALL'))
    const insert = preinstall.indexOf('!insertmacro LU_FREE_SIDECAR')
    const rename = preinstall.indexOf('!if "${PRODUCTNAME}"')
    expect(insert).toBeGreaterThan(-1)
    // Before the compile-time rename switch, otherwise it is dead code again.
    expect(insert).toBeLessThan(rename)
  })

  it('asks the only question that matters, can the file be written', () => {
    expect(hooks).toMatch(/FileOpen \$R3 "\$INSTDIR\\llama-server\.exe" a/)
    expect(hooks).toMatch(/taskkill\.exe" \/F \/T \/IM "llama-server\.exe"/)
    // Bounded: a locked file must not spin the installer forever.
    expect(hooks).toMatch(/\$R4 >= 4/)
  })

  it('kills the name the bundle actually ships and Rust actually starts', () => {
    const external = conf.bundle?.externalBin ?? []
    expect(external).toContain('bin/llama-server')
    expect(engineRs).toMatch(/"llama-server\.exe"/)
    const killed = hooks.match(/\/IM "([^"]+)"/g) ?? []
    expect(killed).toContain('/IM "llama-server.exe"')
  })
})
