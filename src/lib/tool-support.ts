/**
 * One answer to "can this model use tools, and how" (2.5.9).
 *
 * Three signals existed and every surface combined them differently, so the
 * dropdown, the Agent toggle and the Code run could disagree about the same
 * model:
 *
 *   1. the reactive cache (api/tool-capability) — a run PROVED the model
 *      rejects a `tools` payload (cloud 405, ollama "does not support tools")
 *   2. the server's own answer — LU Cloud `/models` returns `supports_tools`,
 *      false for the roleplay and story models it hosts (Hermes 3, Euryale,
 *      MythoMax, Llama 4 Maverick, …)
 *   3. the family-name heuristic in model-compatibility
 *
 * AgentModeToggle already layered 1 > 2 > 3 correctly. The chat dropdown used
 * a different pair for its icon, and useCodex used none of them: it hardcoded
 * `native` for every non-Ollama provider, so picking a declared-no-tools cloud
 * model in Code sent the request anyway, ate a 405, cached the negative, and
 * repeated the whole thing 24 h later when the negative expired.
 *
 * This module is that precedence, once, so all of them move together.
 */

import { getToolCapability } from '../api/tool-capability'
import { getToolCallingStrategy, isAgentCompatible, type ToolCallingStrategy } from './model-compatibility'
import { getProviderIdFromModel } from '../api/providers'

/**
 * How a model can call tools.
 *   'native'  — OpenAI-style function calling in the request payload
 *   'hermes'  — no native channel, but the prompt-injected <tool_call> XML
 *               path can still drive it (small local models mostly land here)
 *   'none'    — tools are off the table; Agent and Code cannot run on it
 */
export type ToolSupport = 'native' | 'hermes' | 'none'

export interface ToolSupportInput {
  /** The model id as the picker knows it (may carry a `provider::` prefix). */
  name: string
  /** `supports_tools` from the provider's own model list, when it says. */
  supportsTools?: boolean
}

export function resolveToolSupport({ name, supportsTools }: ToolSupportInput): ToolSupport {
  if (!name) return 'none'

  const provider = getProviderIdFromModel(name)
  const proven = getToolCapability(name)

  // A proven rejection and a server-declared `false` both mean the same thing:
  // do not put `tools` in the request. For a LOCAL model that is not the end of
  // it — the XML path is pure prompting and often still works, which is how
  // small Ollama models have driven the agent since 2.5.3. For a HOSTED model
  // it is the end of it: LU Cloud sets the flag on its story/roleplay models,
  // which will happily narrate a tool call instead of emitting one, and the
  // user pays per token to find that out.
  if (proven === 'unsupported' || supportsTools === false) {
    return provider === 'lu-cloud' ? 'none' : 'hermes'
  }

  // Nothing says no. Ollama still needs the family check (its catalogue is
  // full of base models with no tool template); everything else speaks the
  // OpenAI schema.
  if (provider === 'ollama') {
    return isAgentCompatible(name) ? 'native' : 'hermes'
  }
  return 'native'
}

/** Can this model drive Agent mode or the coding agent at all? */
export function canUseTools(input: ToolSupportInput): boolean {
  return resolveToolSupport(input) !== 'none'
}

/**
 * The strategy the run should actually use. Mirrors resolveToolSupport so a
 * model the UI offered as tool-capable never gets a request shape it already
 * told us it rejects. 'none' still returns 'hermes_xml' rather than throwing:
 * callers gate on canUseTools first, and a surprise here should degrade to the
 * weakest working path, not to a crash.
 */
export function toolStrategyFor(input: ToolSupportInput): ToolCallingStrategy {
  const support = resolveToolSupport(input)
  if (support === 'native') {
    // Preserve the template_fix branch the Ollama path relies on.
    return getProviderIdFromModel(input.name) === 'ollama'
      ? getToolCallingStrategy(input.name)
      : 'native'
  }
  return 'hermes_xml'
}
