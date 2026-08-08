import { useCreateStore } from '../../../stores/createStore'
import { useCreateExp } from './CreateContext'
import { intentToJob } from '../../../lib/render/cloud-jobs'
import { defaultCloudModel, resolveOpPick, runCredits } from '../../../stores/cloudCatalogStore'
import { meterState } from '../../../lib/render/credits-meter'
import { Tooltip } from '../ui/Tooltip'
import { openExternal } from '../../../api/backend'
import { CLOUD_BASE } from '../../../api/cloud/config'
import { cn } from '../ui/cn'

// Compact credits meter for the cloud backend: remaining vs monthly budget,
// plus the cost of the run the user is about to start. One shared pool —
// images and clips draw from the same number. At 0 (or not enough for this
// run) it becomes the upsell chip and the Create button is gated off.
export function CreditsMeter() {
  const { quota } = useCreateExp()
  const intent = useCreateStore((s) => s.intent())
  const cloudImageModel = useCreateStore((s) => s.cloudImageModel)
  const cloudVideoModel = useCreateStore((s) => s.cloudVideoModel)
  const cloudOpModel = useCreateStore((s) => s.cloudOpModel)
  const characterTab = useCreateStore((s) => s.characterTab)
  const frames = useCreateStore((s) => s.frames)
  const fps = useCreateStore((s) => s.fps)
  const musicDuration = useCreateStore((s) => s.musicDuration)
  const targetResolution = useCreateStore((s) => s.targetResolution)
  if (!quota) return null

  let { kind, op } = intentToJob(intent)
  // Mirror Composer's creditsOk pick exactly — meter and gate must show the
  // same number: the character use-surface is a plain LoRA image generate, the
  // specialized 2.5.8 ops run the op picker's model (audio has no classic
  // entries at all), everything else prices the per-kind picker's model.
  const characterUse = intent === 'character' && characterTab === 'use'
  if (characterUse) {
    kind = 'image'
    op = 'generate'
  }
  const special =
    op === 'lipsync' || op === 'extend' || op === 'motion' ||
    op === 'music' || op === 'tts' || op === 'lora-train'
  const picked = characterUse
    ? 'flux-schnell-lora'
    : special
      ? resolveOpPick(op, cloudOpModel)
      : (kind === 'video' ? cloudVideoModel : cloudImageModel) || defaultCloudModel(kind)?.id || ''
  const seconds =
    op === 'music'
      ? musicDuration
      : kind === 'video' && (op === 'generate' || op === 'animate') && fps > 0
        ? frames / fps
        : undefined
  const cost = runCredits(
    kind, op, picked, seconds, quota.costs[kind === 'audio' ? 'image' : kind], targetResolution,
  )
  const remaining = quota.remaining.credits
  const limit = quota.limits.credits
  const state = meterState(quota, cost, kind, op)
  // A wallet-fixable shortfall (credits, video budget) lands on the credits
  // tab; the training count is a plan property, so that one goes to the plans.
  const upsell = (label: string, tab?: 'credits') => (
    <button
      onClick={() => void openExternal(`${CLOUD_BASE}/pricing${tab ? '?tab=credits' : ''}`)}
      className="t-control px-2 h-[var(--control-h-sm)] inline-flex items-center rounded-md bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 transition-colors"
    >
      {label}
    </button>
  )

  if (state.kind === 'insufficient') {
    return upsell(
      state.remaining <= 0
        ? 'Out of credits, top up'
        : `Needs ${state.cost} credits (${state.remaining} left)`,
      'credits',
    )
  }
  if (state.kind === 'no-trainings') return upsell('No trainings left this month, upgrade')
  if (state.kind === 'no-video-budget') return upsell('Video budget used up, top up', 'credits')

  const noun = op === 'lora-train' ? 'training' : kind === 'video' ? 'clip' : kind === 'audio' ? 'track' : 'image'
  const tail = state.runsLeft === null ? '' : `, about ${state.runsLeft} more like it`
  const videoTail =
    state.showVideoBudget && quota.video
      ? ` (monthly video budget: ${quota.video.remaining} of ${quota.video.limit} credits left)`
      : ''
  const trainingTail =
    op === 'lora-train' && quota.trainings
      ? ` (${quota.trainings.remaining} of ${quota.trainings.limit} trainings left)`
      : ''

  return (
    <Tooltip
      content={`${remaining} of ${limit} credits left this billing period. This ${noun} uses ${cost}${tail}${videoTail}${trainingTail}.`}
    >
      <div className="flex items-center gap-1.5 px-2 h-[var(--control-h-sm)] rounded-md bg-white/[0.04] text-gray-400 t-control">
        <div className="w-12 h-1 rounded-full bg-white/10 overflow-hidden">
          <div
            className={cn('h-full rounded-full', state.pct > 0.25 ? 'bg-emerald-400/80' : 'bg-amber-400/80')}
            style={{ width: `${state.pct * 100}%` }}
          />
        </div>
        <span className="tabular-nums">{remaining}</span>
        {state.runsLeft !== null && (
          <>
            <span className="text-gray-600">·</span>
            <span className="tabular-nums whitespace-nowrap">≈{state.runsLeft} {state.unit}</span>
          </>
        )}
      </div>
    </Tooltip>
  )
}
