/**
 * normalizeModelBase — shared identity for the installed-visibility check and
 * the fuzzy variant fallback (pnwpdr4519: bundle "installed" on disk must not
 * survive when the running ComfyUI cannot see the file).
 * Run: npx vitest run src/api/__tests__/discover-visibility.test.ts
 */
import { describe, it, expect } from 'vitest'
import { normalizeModelBase } from '../discover'

describe('normalizeModelBase', () => {
  it('strips extension and lowercases', () => {
    expect(normalizeModelBase('JuggernautXL_v9.safetensors')).toBe('juggernautxl_v9')
  })

  it('drops nested subdir prefixes ComfyUI enums can carry', () => {
    expect(normalizeModelBase('SDXL/juggernautXL_v9.safetensors')).toBe('juggernautxl_v9')
    expect(normalizeModelBase('SDXL\\juggernautXL_v9.safetensors')).toBe('juggernautxl_v9')
  })

  it('strips common quant suffixes so variants match', () => {
    expect(normalizeModelBase('z_image_turbo_fp8.safetensors')).toBe('z_image_turbo')
    expect(normalizeModelBase('z_image_turbo_bf16.safetensors')).toBe('z_image_turbo')
  })

  it('does NOT substring-match different models (strict base identity)', () => {
    expect(normalizeModelBase('z_image_turbo.safetensors')).not.toBe(
      normalizeModelBase('z_image_base.safetensors'),
    )
  })
})
