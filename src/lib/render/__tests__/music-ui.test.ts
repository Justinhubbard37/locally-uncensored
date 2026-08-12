// Regression guard for #108 (ElBiggus): the local Music tab printed cloud
// facts. It hid the lyrics box while claiming the model writes its own lyrics,
// described a box that was not on screen, implied other music models were
// downloadable, and said the length slider bills per second on a machine where
// nothing is billed.
import { describe, it, expect } from 'vitest'
import { musicTakesLyrics, musicHowtoLines } from '../music-ui'

describe('musicTakesLyrics', () => {
  it('always offers the box locally, because every local checkpoint takes lyrics', () => {
    expect(musicTakesLyrics('local', false)).toBe(true)
    expect(musicTakesLyrics('local', true)).toBe(true)
  })

  it('follows the catalog flag on cloud, where only ace-step-1.5 has the input', () => {
    expect(musicTakesLyrics('cloud', true)).toBe(true)
    expect(musicTakesLyrics('cloud', false)).toBe(false)
  })
})

describe('musicHowtoLines', () => {
  const local = musicHowtoLines('local').join('\n').toLowerCase()
  const cloud = musicHowtoLines('cloud').join('\n').toLowerCase()

  it('never talks about billing on the local tab', () => {
    expect(local).not.toContain('bill')
    expect(cloud).toContain('bills per second')
  })

  it('never promises other music models on the local tab, where there is one', () => {
    expect(local).not.toContain('other music models')
    expect(cloud).toContain('other music models')
  })

  it('only describes the lyrics box where the box exists', () => {
    // Locally the box is always there, so mentioning it is fair.
    expect(musicTakesLyrics('local', false)).toBe(true)
    expect(local).toContain('lyrics box')
  })

  it('keeps the advice that actually applies to both, the tags and the markers', () => {
    for (const text of [local, cloud]) {
      expect(text).toContain('comma-separated tags')
      expect(text).toContain('[verse]')
    }
  })

  it('leads with the heading and stays a short panel', () => {
    expect(musicHowtoLines('local')[0]).toBe('Make it sing your words')
    expect(musicHowtoLines('local').length).toBe(5)
    expect(musicHowtoLines('cloud').length).toBe(6)
  })
})
