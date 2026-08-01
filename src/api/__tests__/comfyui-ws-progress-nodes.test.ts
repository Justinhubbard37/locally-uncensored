import { describe, it, expect } from 'vitest'
import {
  LOADER_NODES, CLIP_LOADER_NODES, VAE_LOADER_NODES, SAMPLER_NODES, DECODE_NODES,
} from '../comfyui-ws'

// These sets drive the phase labels of the Create progress bar. A node type
// missing here does not break the run, it breaks the STORY the bar tells:
// the GGUF video path showed no "Loading model" phase at all because
// UnetLoaderGGUF was unknown (David 2026-08-02).
describe('progress phase node sets', () => {
  it('recognises the GGUF unet loaders as model loading', () => {
    expect(LOADER_NODES.has('UnetLoaderGGUF')).toBe(true)
    expect(LOADER_NODES.has('UnetLoaderGGUFAdvanced')).toBe(true)
  })

  it('still recognises the classic loaders', () => {
    expect(LOADER_NODES.has('CheckpointLoaderSimple')).toBe(true)
    expect(LOADER_NODES.has('UNETLoader')).toBe(true)
  })

  it('keeps the wan video pipeline phases mapped', () => {
    expect(CLIP_LOADER_NODES.has('CLIPLoader')).toBe(true)
    expect(VAE_LOADER_NODES.has('VAELoader')).toBe(true)
    expect(SAMPLER_NODES.has('KSampler')).toBe(true)
    expect(DECODE_NODES.has('VAEDecode')).toBe(true)
  })
})
