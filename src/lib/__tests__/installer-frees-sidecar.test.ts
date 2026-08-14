/**
 * The Windows installer has to free our own engine before it copies over it,
 * and it may free NOTHING ELSE.
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
 * Review 2026-08-14: the first version of the unlock reached far too wide.
 * `taskkill /F /T /IM "llama-server.exe"` matches by image name for the whole
 * session, so a llama.cpp server the user started themselves (one of the
 * backends this app detects, so a normal thing to have running) was hard
 * killed mid-generation by an update they never watched. Everywhere else the
 * app leaves a stranger alone, so the kill is now scoped to the one file the
 * installer is about to overwrite, and a lock it cannot clear moves the file
 * aside instead of handing the user Abort, Retry, Ignore.
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

// Only the unlock macro. The dormant product-rename macro below it kills the
// app itself and is a different question.
const unlock = hooks.slice(
  hooks.indexOf('!macro LU_FREE_SIDECAR'),
  hooks.indexOf('!macro NSIS_HOOK_PREINSTALL'),
)

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
    expect(unlock).toMatch(/FileOpen \$R3 "\$INSTDIR\\llama-server\.exe" a/)
    // Bounded: a locked file must not spin the installer forever.
    expect(unlock).toMatch(/\$R4 >= 4/)
  })

  it('frees the file the bundle actually ships and Rust actually starts', () => {
    const external = conf.bundle?.externalBin ?? []
    expect(external).toContain('bin/llama-server')
    expect(engineRs).toMatch(/"llama-server\.exe"/)
  })
})

describe('it kills our engine and nobody elses', () => {
  it('never swings at an image name', () => {
    expect(unlock).not.toMatch(/\/IM/)
  })

  it('kills only the process whose image is the file being overwritten', () => {
    expect(unlock).toContain("-eq '$INSTDIR\\llama-server.exe'")
    expect(unlock).toMatch(/Stop-Process -Id \$\$_\.ProcessId -Force/)
  })

  it('reads the path over WMI, a 32 bit installer cannot read a 64 bit MainModule', () => {
    expect(unlock).toContain('Get-CimInstance Win32_Process')
    expect(unlock).not.toContain('Get-Process')
  })

  it('escapes the PowerShell dollar so NSIS does not eat the pipeline variable', () => {
    // A bare $_ is an unknown NSIS variable and expands to nothing, which would
    // compare the empty string against the path and match no process at all.
    expect(unlock).not.toMatch(/[^$]\$_\./)
  })

  it('touches nothing while the file still opens for writing', () => {
    // The kill sits behind the write probe, not in front of it.
    expect(unlock.indexOf('FileOpen')).toBeLessThan(unlock.indexOf('nsExec::Exec'))
  })

  it('follows the rule the rest of the app already keeps', () => {
    expect(engineRs).toMatch(
      /already serving another llama-server that this app does not manage/,
    )
  })
})

describe('a lock we cannot clear must not end the update', () => {
  it('moves the old engine aside instead of failing the copy', () => {
    expect(unlock).toMatch(
      /Rename "\$INSTDIR\\llama-server\.exe" "\$INSTDIR\\llama-server\.exe\.old"/,
    )
    // The rename is the last resort, it belongs after the retry budget.
    expect(unlock.indexOf('$R4 >= 4')).toBeLessThan(unlock.indexOf('Rename'))
  })

  it('sweeps the leftover before the next install writes a new one', () => {
    const sweep = unlock.indexOf('Delete "$INSTDIR\\llama-server.exe.old"')
    expect(sweep).toBeGreaterThan(-1)
    expect(sweep).toBeLessThan(unlock.indexOf('${Do}'))
  })
})
