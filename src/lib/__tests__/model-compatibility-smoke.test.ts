/**
 * Comprehensive smoke tests for the model compatibility system.
 *
 * Tests all exported functions that control which features are available
 * for which models across all providers (Ollama, OpenAI, Anthropic).
 *
 * Coverage:
 * - isAgentCompatible (tool calling support)
 * - isThinkingCompatible (native think parameter)
 * - isPlainTextPlanner (Gemma 3/4 bypass logic)
 * - getToolCallingStrategy (native vs hermes_xml)
 * - getRecommendedAgentModels
 * - Abliterated model handling
 * - Provider-aware routing (cloud always supports)
 */
import { describe, it, expect } from 'vitest'
import {
  isAgentCompatible,
  isToolCallingModel,
  hasNativeToolCalling,
  isThinkingCompatible,
  isPlainTextPlanner,
  getToolCallingStrategy,
  getRecommendedAgentModels,
  isVisionCompatible,
} from '../model-compatibility'

// ── Agent Compatibility ─────────────────────────────────────────────────

describe('isAgentCompatible', () => {
  it('returns true for standard tool-calling models', () => {
    expect(isAgentCompatible('qwen3-coder:30b')).toBe(true)
    expect(isAgentCompatible('llama3.1:8b')).toBe(true)
    expect(isAgentCompatible('gemma4:12b')).toBe(true)
    expect(isAgentCompatible('hermes3:8b')).toBe(true)
    expect(isAgentCompatible('mistral:latest')).toBe(true)
    expect(isAgentCompatible('phi-4:14b')).toBe(true)
    expect(isAgentCompatible('deepseek-v3:latest')).toBe(true)
  })

  it('returns false for models without tool calling', () => {
    expect(isAgentCompatible('llama2:7b')).toBe(false)
    expect(isAgentCompatible('vicuna:7b')).toBe(false)
    expect(isAgentCompatible('codellama:7b')).toBe(false)
    expect(isAgentCompatible('tinyllama:latest')).toBe(false)
  })

  it('returns true for all cloud provider models', () => {
    expect(isAgentCompatible('openai::gpt-4o')).toBe(true)
    expect(isAgentCompatible('openai::gpt-4o-mini')).toBe(true)
    expect(isAgentCompatible('anthropic::claude-opus-4-20250514')).toBe(true)
    expect(isAgentCompatible('anthropic::claude-sonnet-4-20250514')).toBe(true)
  })

  it('handles abliterated models correctly', () => {
    // Hermes abliterated retains native tool calling
    expect(isAgentCompatible('hermes3-abliterated:8b')).toBe(true)
    // qwen3-coder abliterated retains it
    expect(isAgentCompatible('qwen3-coder-abliterated:30b')).toBe(true)
    // Random abliterated model without native support
    expect(isAgentCompatible('llama2-abliterated:7b')).toBe(false)
  })

  it('returns false for null/empty', () => {
    expect(isAgentCompatible(null)).toBe(false)
    expect(isAgentCompatible('')).toBe(false)
  })

  it('aliases work identically', () => {
    expect(isToolCallingModel('gemma4:12b')).toBe(true)
    expect(hasNativeToolCalling('gemma4:12b')).toBe(true)
    expect(isToolCallingModel('llama2:7b')).toBe(false)
  })
})

// ── Thinking Compatibility ──────────────────────────────────────────────

describe('isThinkingCompatible', () => {
  it('returns true for thinking-capable models', () => {
    expect(isThinkingCompatible('qwq:32b')).toBe(true)
    expect(isThinkingCompatible('deepseek-r1:8b')).toBe(true)
    expect(isThinkingCompatible('qwen3:8b')).toBe(true)
    expect(isThinkingCompatible('gemma3:9b')).toBe(true)
    expect(isThinkingCompatible('gemma4:12b')).toBe(true)
    expect(isThinkingCompatible('qwen3-coder:30b')).toBe(true)
  })

  it('returns false for non-thinking models', () => {
    expect(isThinkingCompatible('llama3.1:8b')).toBe(false)
    expect(isThinkingCompatible('hermes3:8b')).toBe(false)
    expect(isThinkingCompatible('mistral:latest')).toBe(false)
  })

  it('returns true for all cloud providers', () => {
    expect(isThinkingCompatible('openai::gpt-4o')).toBe(true)
    expect(isThinkingCompatible('anthropic::claude-sonnet-4-20250514')).toBe(true)
  })

  it('returns false for null', () => {
    expect(isThinkingCompatible(null)).toBe(false)
  })
})

// ── Gemma Plain-Text Planner Bypass ─────────────────────────────────────

describe('isPlainTextPlanner', () => {
  it('returns true for Gemma 3 and Gemma 4', () => {
    expect(isPlainTextPlanner('gemma3:9b')).toBe(true)
    expect(isPlainTextPlanner('gemma4:12b')).toBe(true)
    expect(isPlainTextPlanner('gemma4:26b')).toBe(true)
  })

  it('returns false for non-Gemma models', () => {
    expect(isPlainTextPlanner('qwen3:8b')).toBe(false)
    expect(isPlainTextPlanner('llama3.1:8b')).toBe(false)
    expect(isPlainTextPlanner('hermes3:8b')).toBe(false)
  })

  it('handles abliterated Gemma', () => {
    expect(isPlainTextPlanner('gemma4-abliterated:12b')).toBe(true)
  })

  it('returns false for null', () => {
    expect(isPlainTextPlanner(null)).toBe(false)
  })
})

// ── Tool Calling Strategy ───────────────────────────────────────────────

describe('getToolCallingStrategy', () => {
  it('cloud providers always get native strategy', () => {
    expect(getToolCallingStrategy('openai::gpt-4o')).toBe('native')
    expect(getToolCallingStrategy('anthropic::claude-opus-4-20250514')).toBe('native')
  })

  it('Ollama compatible models get native', () => {
    expect(getToolCallingStrategy('qwen3:8b')).toBe('native')
    expect(getToolCallingStrategy('gemma4:12b')).toBe('native')
    expect(getToolCallingStrategy('hermes3:8b')).toBe('native')
  })

  it('Ollama incompatible models get hermes_xml fallback', () => {
    expect(getToolCallingStrategy('llama2:7b')).toBe('hermes_xml')
    expect(getToolCallingStrategy('tinyllama:latest')).toBe('hermes_xml')
  })
})

// ── Recommended Models ──────────────────────────────────────────────────

describe('getRecommendedAgentModels', () => {
  it('returns a non-empty list', () => {
    const models = getRecommendedAgentModels()
    expect(models.length).toBeGreaterThan(0)
  })

  it('all recommended models are agent-compatible', () => {
    const models = getRecommendedAgentModels()
    for (const m of models) {
      expect(isAgentCompatible(m.name)).toBe(true)
    }
  })

  it('includes both local and cloud models', () => {
    const models = getRecommendedAgentModels()
    const providers = new Set(models.map(m => m.provider))
    expect(providers.has('ollama')).toBe(true)
    expect(providers.has('anthropic')).toBe(true)
  })

  it('has at least one HOT pick', () => {
    const models = getRecommendedAgentModels()
    expect(models.some(m => m.hot)).toBe(true)
  })

  it('all entries have required fields', () => {
    const models = getRecommendedAgentModels()
    for (const m of models) {
      expect(m.name).toBeTruthy()
      expect(m.label).toBeTruthy()
      expect(m.reason).toBeTruthy()
    }
  })
})

// ── Qwen 3.8 (August 2026) ──────────────────────────────────────────────
// The family arrives on three routes with three different name shapes: an
// Ollama tag, a GGUF file name in the built-in engine, and LM Studio's
// quant-less publisher key. All three have to reach the same verdict, or the
// image button and the Think toggle disagree with the model that is loaded.

describe('Qwen 3.8 across all three routes', () => {
  const names = [
    'qwen3.8:latest',
    'qwen3.8:27b',
    'Qwen3.8-27B-UD-Q4_K_M.gguf',
    'Qwen3.8-27B-Uncensored-Q4_K_M.gguf',
    'Huihui-Qwen3.8-27B-abliterated-Q4_K.gguf',
    'huihui_ai/Qwen3.8-abliterated:27b',
    'qwen/qwen3.8-27b',
  ]

  it('reads images on every route', () => {
    for (const n of names) expect(isVisionCompatible(n), n).toBe(true)
  })

  it('takes tools and the think parameter on every route', () => {
    for (const n of names) {
      expect(isAgentCompatible(n), n).toBe(true)
      expect(isThinkingCompatible(n), n).toBe(true)
    }
  })

  it('does not bleed into unrelated families', () => {
    expect(isVisionCompatible('llama3.1:8b')).toBe(false)
    expect(isVisionCompatible('hermes3:8b')).toBe(false)
  })

  it('offers Qwen 3.8 as a recommended local pick', () => {
    expect(getRecommendedAgentModels().some(m => m.name === 'qwen3.8:latest')).toBe(true)
  })
})
