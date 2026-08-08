// The music how-to dot: unseen by default, retired forever after one open.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { useCreateStore } from '../createStore'

describe('music how-to notification dot', () => {
  it('is unseen by default and retires after the first open', () => {
    expect(useCreateStore.getState().musicHowtoSeen).toBe(false)
    useCreateStore.getState().setMusicHowtoSeen(true)
    expect(useCreateStore.getState().musicHowtoSeen).toBe(true)
  })

  it('survives a reload: partialize persists the flag (source guard)', () => {
    const src = readFileSync(join(__dirname, '../createStore.ts'), 'utf8')
    expect(src).toContain('musicHowtoSeen: state.musicHowtoSeen')
  })
})
