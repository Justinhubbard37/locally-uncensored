// The MLX install slots live in Rust and were only ever polled by whichever
// page started the install (Settings, Model Manager, Create). The download
// tray in the titlebar, the one place the user actually watches, never saw
// them, so a 2.6 GB model pull showed nothing but a spinning "Installing…"
// button (David, 2026-07-31). This store is the tray's window into those
// slots: watch() follows one install to its terminal state, adopt() picks up
// an install that is already running when the tray mounts.

import { create } from 'zustand'
import { getMlxImageInstallStatus, getMlxImageEngineStatus, type MlxInstallStatus } from '../api/mlx-image'
import { getMlxInstallStatus, getModelInstallStatus, type InstallStatus } from '../api/mlx-video'

const POLL_MS = 1200

export type MlxInstallKind = 'image-engine' | 'image-model' | 'video-engine' | 'video-model'

export interface MlxInstallEntry {
  kind: MlxInstallKind
  label: string
  status: 'installing' | 'complete' | 'error'
  progress: number
  total: number
  speed: number
  lastLog: string
  error: string | null
}

const READERS: Record<MlxInstallKind, () => Promise<MlxInstallStatus | InstallStatus>> = {
  'image-engine': getMlxImageEngineStatus,
  'image-model': getMlxImageInstallStatus,
  'video-engine': getMlxInstallStatus,
  'video-model': getModelInstallStatus,
}

const ADOPT_LABELS: Record<MlxInstallKind, string> = {
  'image-engine': 'MLX image engine',
  'image-model': 'Image model',
  'video-engine': 'MLX video engine',
  'video-model': 'Video model',
}

interface MlxInstallStoreState {
  entries: Record<string, MlxInstallEntry>
  watch: (kind: MlxInstallKind, label: string) => void
  adopt: () => Promise<void>
  dismiss: (kind: MlxInstallKind) => void
}

const timers: Partial<Record<MlxInstallKind, ReturnType<typeof setInterval>>> = {}

export const useMlxInstallStore = create<MlxInstallStoreState>()((set, get) => ({
  entries: {},

  watch: (kind, label) => {
    if (timers[kind]) return
    set((s) => ({
      entries: {
        ...s.entries,
        [kind]: { kind, label, status: 'installing', progress: 0, total: 0, speed: 0, lastLog: '', error: null },
      },
    }))
    const tick = async () => {
      let s: MlxInstallStatus | InstallStatus
      try {
        s = await READERS[kind]()
      } catch {
        return // transient: the slot is being written; next tick retries
      }
      // 'idle' can only mean the app restarted under us; the install is gone.
      const status = s.status === 'installing' ? 'installing' : s.status === 'complete' ? 'complete' : s.status === 'error' ? 'error' : null
      if (status === null) {
        clearInterval(timers[kind])
        delete timers[kind]
        get().dismiss(kind)
        return
      }
      set((st) => ({
        entries: {
          ...st.entries,
          [kind]: {
            kind,
            label: st.entries[kind]?.label ?? label,
            status,
            progress: s.download_progress,
            total: s.download_total,
            speed: s.download_speed,
            lastLog: s.logs.length ? String(s.logs[s.logs.length - 1]) : '',
            error: s.error,
          },
        },
      }))
      if (status !== 'installing') {
        clearInterval(timers[kind])
        delete timers[kind]
      }
    }
    timers[kind] = setInterval(tick, POLL_MS)
    void tick()
  },

  // Pick up installs already running in Rust that nobody is watching, e.g.
  // the user started one in Settings, the view unmounted, and the tray is the
  // only surface left. Callers gate this on macOS; the commands 400 elsewhere.
  adopt: async () => {
    await Promise.all(
      (Object.keys(READERS) as MlxInstallKind[]).map(async (kind) => {
        if (timers[kind] || get().entries[kind]) return
        const s = await READERS[kind]().catch(() => null)
        if (s?.status === 'installing') get().watch(kind, ADOPT_LABELS[kind])
      }),
    )
  },

  dismiss: (kind) => {
    set((s) => {
      const entries = { ...s.entries }
      delete entries[kind]
      return { entries }
    })
  },
}))
