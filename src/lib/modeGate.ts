import { getProviderIdFromModel } from '../api/providers'

/**
 * The Cloud switch is a MONEY gate: a model from the wrong mode must never
 * reach a provider. Discord bug-reports 2026-08-09 (helpslowlydying): with no
 * local model installed, flipping the switch to Local left the lu-cloud model
 * silently active and every chat kept billing credits. The AppShell reselect
 * keeps the header honest; this predicate is what the send path enforces.
 *
 * True = the selected model belongs to the OTHER mode and must not be used.
 * A null selection is never out of mode (there is nothing to block).
 */
export function modelOutOfMode(
  modelName: string | null | undefined,
  appMode: string | undefined,
): boolean {
  if (!modelName) return false
  const cloudSelected = getProviderIdFromModel(modelName) === 'lu-cloud'
  return cloudSelected !== (appMode === 'cloud')
}
