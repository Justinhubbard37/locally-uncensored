// What the credits meter says, and what the Create button gates on. One rule,
// two surfaces, so the chip can never promise a run the button refuses.
//
// The web Studio decides this inline in its CreditsMeter JSX. That is why its
// training branch has never had a test and why the desktop copy silently drifted
// behind it: the desktop meter knew only about credits, so a user who had spent
// their monthly character trainings saw a healthy green bar, pressed Create and
// got a 429 from the server. The server has sent `video`, `trainings` and
// `topup` since migration 0029; only the client ignored them.

import type { CloudQuota, RenderKind, RenderOp } from './cloud-jobs'

export type MeterState =
  | { kind: 'insufficient'; remaining: number; cost: number }
  | { kind: 'no-trainings' }
  | { kind: 'no-video-budget' }
  | {
      kind: 'ok'
      /** null when the run's cost is not known yet (catalogue still loading),
       *  so the chip shows the balance without inventing a count. */
      runsLeft: number | null
      unit: string
      pct: number
      /** Name the video sub-budget only when it is really the binding limit. */
      showVideoBudget: boolean
    }

/** Video renders draw the 0029 sub-budget. A character training never does; it
 *  draws the separate monthly COUNT instead. */
export function drawsVideoBudget(kind: RenderKind, op: RenderOp): boolean {
  return kind === 'video' && op !== 'lora-train'
}

function unitFor(kind: RenderKind, isTraining: boolean, n: number): string {
  if (isTraining) return n === 1 ? 'training' : 'trainings'
  if (kind === 'video') return n === 1 ? 'clip' : 'clips'
  if (kind === 'audio') return n === 1 ? 'track' : 'tracks'
  return n === 1 ? 'image' : 'images'
}

export function meterState(
  quota: CloudQuota,
  cost: number,
  kind: RenderKind,
  op: RenderOp,
): MeterState {
  const remaining = quota.remaining.credits
  const limit = quota.limits.credits
  const topup = quota.topup?.credits ?? 0
  const isTraining = op === 'lora-train'
  const isVideoBudget = drawsVideoBudget(kind, op)

  // Absent fields mean a pre-0029 server: uncapped, never gate on data we do
  // not have. Video's monthly room is extended by the wallet because top-up
  // credits are exempt from the sub-budget; the training count is a hard count
  // the wallet cannot buy past.
  const videoRoom = quota.video ? quota.video.remaining + topup : Infinity
  const trainingsLeft = quota.trainings ? quota.trainings.remaining : Infinity

  if (remaining < cost) return { kind: 'insufficient', remaining, cost }
  if (isTraining && trainingsLeft <= 0) return { kind: 'no-trainings' }
  if (isVideoBudget && videoRoom < cost) return { kind: 'no-video-budget' }

  const runsPool = isVideoBudget ? Math.min(remaining, videoRoom) : remaining
  const byCredits = cost > 0 ? Math.floor(runsPool / cost) : null
  const runsLeft =
    byCredits === null ? null : isTraining ? Math.min(trainingsLeft, byCredits) : byCredits

  // No tier caps video below its pool since 2026-08-05, so on a plain plan
  // videoRoom always covers `remaining` and this stays false. It turns itself
  // back on the day a real cap returns, rather than being deleted and forgotten.
  const showVideoBudget = isVideoBudget && quota.video != null && videoRoom < remaining

  return {
    kind: 'ok',
    runsLeft,
    unit: unitFor(kind, isTraining, runsLeft ?? 0),
    pct: limit > 0 ? Math.max(0, Math.min(1, remaining / limit)) : 0,
    showVideoBudget,
  }
}
