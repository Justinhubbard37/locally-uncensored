/**
 * Who owns a running bundle install.
 *
 * The install card used to own it, and only it. Stage swaps that card away the
 * moment a render starts or the lane's model list refills, and React unmounts
 * it, so a 12 GB install lost its status line, its Cancel button and its error
 * message while it was still running. The user saw the card vanish, read that
 * as "done", and any later failure landed in a setState on a dead component.
 *
 * The run lives here instead. A card that mounts for a lane picks up the run
 * that is already going rather than starting a second one, and the status and
 * the error survive every swap Stage makes.
 */

export interface InstallRun {
  status: string
  err: string | null
  running: boolean
}

type Runner = (onStatus: (s: string) => void, signal: AbortSignal) => Promise<void>

const runs = new Map<string, InstallRun & { ac: AbortController }>()
const listeners = new Set<() => void>()

const IDLE: InstallRun = { status: '', err: null, running: false }

function emit(): void {
  for (const l of listeners) l()
}

export function subscribeInstallRuns(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

/** Snapshot for one lane. Stable identity while nothing changes, so
 *  useSyncExternalStore does not loop. */
export function getInstallRun(kind: string): InstallRun {
  return runs.get(kind) ?? IDLE
}

/** True while this lane has a run nobody has read the outcome of yet. */
export function isInstalling(kind: string): boolean {
  return runs.get(kind)?.running === true
}

/**
 * Start an install for a lane, or do nothing if one is already going. Pressing
 * the button twice, or a remounted card auto-resuming, must never mean two
 * downloads writing the same file.
 */
export function startInstallRun(kind: string, run: Runner): void {
  if (runs.get(kind)?.running) return
  const ac = new AbortController()
  const entry = { status: 'Starting…', err: null as string | null, running: true, ac }
  runs.set(kind, entry)
  emit()

  const onStatus = (s: string) => {
    const live = runs.get(kind)
    if (!live || live.ac !== ac) return
    runs.set(kind, { ...live, status: s })
    emit()
  }

  void run(onStatus, ac.signal)
    .then(() => {
      const live = runs.get(kind)
      if (!live || live.ac !== ac) return
      runs.delete(kind)
      emit()
    })
    .catch((e: unknown) => {
      const live = runs.get(kind)
      if (!live || live.ac !== ac) return
      runs.set(kind, { ...live, running: false, err: e instanceof Error ? e.message : String(e) })
      emit()
    })
}

export function cancelInstallRun(kind: string): void {
  runs.get(kind)?.ac.abort()
}

/** The user has read the error, so the lane goes back to offering the install. */
export function clearInstallRun(kind: string): void {
  if (runs.get(kind)?.running) return
  runs.delete(kind)
  emit()
}

/** Tests only. */
export function resetInstallRuns(): void {
  for (const r of runs.values()) r.ac.abort()
  runs.clear()
  listeners.clear()
}
