import { useCreateStore } from '../../../stores/createStore'
import { useCreateExp } from './CreateContext'
import { intentToJob } from '../../../lib/render/cloud-jobs'
import { defaultCloudModel, resolveOpPick, runCredits } from '../../../stores/cloudCatalogStore'
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
  const topup = quota.topup?.credits ?? 0
  // The 0029 caps. Video's monthly room is extended by the wallet (packs are
  // exempt from the sub-budget); trainings are a hard count the wallet cannot
  // buy past. Absent fields (a pre-0029 server) mean uncapped: never gate on
  // data we do not have.
  const isTraining = op === 'lora-train'
  const isVideoBudget = kind === 'video' && !isTraining
  const videoRoom = quota.video ? quota.video.remaining + topup : Infinity
  const trainingsLeft = quota.trainings ? quota.trainings.remaining : Infinity
  const enough = remaining >= cost
  const videoEnough = !isVideoBudget || videoRoom >= cost
  const trainingsEnough = !isTraining || trainingsLeft > 0
  const pct = limit > 0 ? Math.max(0, Math.min(1, remaining / limit)) : 0

  if (!enough) {
    return (
      <button
        onClick={() => void openExternal(`${CLOUD_BASE}/pricing?tab=credits`)}
        className="t-control px-2 h-[var(--control-h-sm)] inline-flex items-center rounded-md bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 transition-colors"
      >
        {remaining <= 0 ? 'Out of credits, top up' : `Needs ${cost} credits (${remaining} left)`}
      </button>
    )
  }
  if (!trainingsEnough) {
    return (
      <button
        onClick={() => void openExternal(`${CLOUD_BASE}/pricing`)}
        className="t-control px-2 h-[var(--control-h-sm)] inline-flex items-center rounded-md bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 transition-colors"
      >
        No trainings left this month. Upgrade
      </button>
    )
  }
  if (!videoEnough) {
    return (
      <button
        onClick={() => void openExternal(`${CLOUD_BASE}/pricing?tab=credits`)}
        className="t-control px-2 h-[var(--control-h-sm)] inline-flex items-center rounded-md bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 transition-colors"
      >
        Video budget used up. Top up
      </button>
    )
  }

  // "How many more like this one" is the number a person actually wants from
  // a meter. Video counts against the smaller of the shared pool and its
  // sub-budget; trainings show the monthly count directly.
  const runsPool = isVideoBudget ? Math.min(remaining, videoRoom) : remaining
  const runsLeft = isTraining
    ? Math.min(trainingsLeft, Math.floor(runsPool / cost))
    : Math.floor(runsPool / cost)
  const unit = isTraining
    ? runsLeft === 1 ? 'training' : 'trainings'
    : kind === 'video'
      ? runsLeft === 1 ? 'clip' : 'clips'
      : kind === 'audio'
        ? runsLeft === 1 ? 'track' : 'tracks'
        : runsLeft === 1 ? 'image' : 'images'

  return (
    <Tooltip
      content={`${remaining} of ${limit} credits left this billing period. This ${
        isTraining ? 'training' : kind === 'video' ? 'clip' : kind === 'audio' ? 'track' : 'image'
      } uses ${cost}, about ${runsLeft} more like it${
        isVideoBudget && quota.video ? ` (monthly video budget: ${quota.video.remaining} of ${quota.video.limit} credits left)` : ''
      }${isTraining && quota.trainings ? ` (${trainingsLeft} of ${quota.trainings.limit} trainings left)` : ''}.`}
    >
      <div className="flex items-center gap-1.5 px-2 h-[var(--control-h-sm)] rounded-md bg-white/[0.04] text-gray-400 t-control">
        <div className="w-12 h-1 rounded-full bg-white/10 overflow-hidden">
          <div
            className={cn('h-full rounded-full', pct > 0.25 ? 'bg-emerald-400/80' : 'bg-amber-400/80')}
            style={{ width: `${pct * 100}%` }}
          />
        </div>
        <span className="tabular-nums">{remaining}</span>
        <span className="text-gray-600">·</span>
        <span className="tabular-nums whitespace-nowrap">≈{runsLeft} {unit}</span>
      </div>
    </Tooltip>
  )
}
