import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Settings, Persona } from '../types/settings'
import { DEFAULT_SETTINGS, BUILT_IN_PERSONAS } from '../lib/constants'

// v5 (Feature EE v2.5.0): added settings.exclusiveVramMode. The migrate below
// already merges { ...DEFAULT_SETTINGS, ...persisted.settings }, so bumping the
// version is all that's needed — the new default fills in while every existing
// user value is preserved. Rehydration is NOT broken: a persisted v4 blob runs
// the same merge path that has handled every prior additive field.
// v6 (uselu design port): added settings.personasEnabled (master persona
// switch, default true). Bumped so existing users get the default ON instead
// of an undefined → falsy "personas off" surprise.
// v7 (Small-Model Mode v2.5.0): added settings.smallModelMode (lean profile
// for 3B-8B local models, default false). Same additive merge path below
// ({ ...DEFAULT_SETTINGS, ...persisted.settings }) fills the new default in
// while preserving every existing user value — existing users get it OFF.
// v8: added settings.userAvatarDataUrl (user profile picture, default ''),
// backfilled by the same additive merge — existing users keep the default icon.
// v9 (v2.5.3): added the model-picker preferences preferredImageModel /
// preferredVideoT2VModel / preferredVideoI2VModel (all default '' = "ask
// before the VRAM swap"). Same additive merge path — existing users simply
// see the picker on their next generation.
// v10 (2026-06-16): one-time RESET of those three picker preferences. Video had
// kept a silently-saved model and only offered "Change model"; David wants the
// full picker to come FIRST again on both image AND video. Clearing the saved
// picks once on upgrade makes the picker the default until the user deliberately
// saves a model again via the picker's Remember.
// v11 (2.5.7): added settings.appMode (global Local/Cloud switch, default
// 'local'). Same additive merge backfills it — without the bump, v10 blobs
// skip migrate entirely and the header ModeSwitch renders with appMode
// undefined, highlighting neither Local nor Cloud.
// v12 (2.5.7): added settings.comfyGpuMode ('auto'|'cpu'|'gpu', default
// 'auto') for the AMD ComfyUI GPU path (rhodium92). Additive — the merge
// fills the default while preserving every existing value; NVIDIA unaffected.
// v13 (2.5.7): added settings.cloudOnboardingSeen — REMOVED in 2.6.0: the
// one-time onboarding moved into the web checkout (#91); stale persisted
// values are ignored by the merge.
// v14 (2.5.8): added settings.cloudTeasersEnabled (Cloud discovery in Local
// mode: locked Create tabs + hosted-model picker rows, default true). Additive.
// v15 (2.5.9): added settings.codexCloudConfirmShell (default true). The cloud
// shell-confirm was hard-wired in useCodex, so the existing confirm toggle did
// nothing on a cloud model. Additive merge backfills the default — behaviour is
// byte-for-byte what 2.5.8 did until the user turns the new switch off.
// v16 (2.5.9): added settings.loopMaxPasses (default 0 = unlimited). Additive,
// but the bump is what makes the merge RUN — without it an existing profile
// keeps the field undefined and the Settings number box renders empty, which
// is how this was caught on the ship exe (2026-07-25). Behaviour was already
// correct via `?? 0`; this is so the UI shows the real value.
// v17 (2.5.10): added settings.codexAutoApply (default false) — auto-apply
// staged changes when the run finishes. Additive merge backfills the default;
// stage-mode behaviour is unchanged until the user turns the new switch on.
// v18 (2.6.0): added settings.builtinEngine (expert tuning for the bundled
// llama-server: ctx, flash attention, KV-cache quant, threads, GPU layers,
// mlock/mmap; defaults = the exact pre-2.6.0 argv). Additive merge backfills
// the default object; engine behaviour is unchanged until the user edits it.
// v19 (2.6.0): the macOS Cloud-only wall is lifted — the Mac app is a full
// local+cloud app again. Existing Mac installs were force-pinned to appMode
// 'cloud' with no real choice, so reset them to the local default ONCE so they
// land in the now-built local mode; the visible switch flips back anytime.
// Windows/Linux appMode reflects a real user choice and is never touched.
const STORE_VERSION = 19

interface SettingsState {
  settings: Settings
  personas: Persona[]
  activePersonaId: string
  _version: number
  updateSettings: (partial: Partial<Settings>) => void
  resetSettings: () => void
  /** GitHub #59 — reset only the given settings keys to their defaults
   *  (per-section reset; leaves everything else untouched). */
  resetSettingsKeys: (keys: (keyof Settings)[]) => void
  addPersona: (persona: Persona) => void
  removePersona: (id: string) => void
  updatePersona: (id: string, partial: Partial<Persona>) => void
  setActivePersona: (id: string) => void
  getActivePersona: () => Persona | undefined
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      settings: DEFAULT_SETTINGS,
      personas: BUILT_IN_PERSONAS,
      activePersonaId: 'unrestricted',
      _version: STORE_VERSION,

      updateSettings: (partial) =>
        set((state) => ({ settings: { ...state.settings, ...partial } })),

      resetSettings: () => set((state) => ({ settings: { ...DEFAULT_SETTINGS, onboardingDone: state.settings.onboardingDone } })),

      resetSettingsKeys: (keys) =>
        set((state) => {
          const next = { ...state.settings }
          for (const k of keys) {
            // onboardingDone is a lifecycle marker, not a preference — never
            // reset it (same guard the full resetSettings applies).
            if (k === 'onboardingDone') continue
            ;(next as Record<string, unknown>)[k] = DEFAULT_SETTINGS[k]
          }
          return { settings: next }
        }),

      addPersona: (persona) =>
        set((state) => ({ personas: [...state.personas, persona] })),

      removePersona: (id) =>
        set((state) => ({
          personas: state.personas.filter((p) => p.id !== id),
          activePersonaId: state.activePersonaId === id ? 'unrestricted' : state.activePersonaId,
        })),

      updatePersona: (id, partial) =>
        set((state) => ({
          personas: state.personas.map((p) => (p.id === id ? { ...p, ...partial } : p)),
        })),

      setActivePersona: (id) => set({ activePersonaId: id }),

      getActivePersona: () => {
        const { personas, activePersonaId } = get()
        return personas.find((p) => p.id === activePersonaId)
      },
    }),
    {
      name: 'chat-settings',
      version: STORE_VERSION,
      migrate: (persisted: any, version: number) => {
        if (version < STORE_VERSION) {
          const customPersonas = (persisted.personas || []).filter((p: Persona) => !p.isBuiltIn)
          // Merge new default settings into existing (fills missing fields like thinkingEnabled)
          const mergedSettings = { ...DEFAULT_SETTINGS, ...(persisted.settings || {}) }
          // v10: clear the saved model-picker preferences ONCE so the picker is
          // shown first again on image + video (David 2026-06-16). The additive
          // merge above would otherwise preserve a previously-saved pick.
          if (version < 10) {
            mergedSettings.preferredImageModel = ''
            mergedSettings.preferredVideoT2VModel = ''
            mergedSettings.preferredVideoI2VModel = ''
          }
          // v19: release the Mac cloud lock (see the version log above).
          if (version < 19) {
            const isMac = typeof navigator !== 'undefined' &&
              (/Mac|iPhone|iPad|iPod/.test(navigator.platform || '') ||
               /Mac OS X|Macintosh/.test(navigator.userAgent || ''))
            if (isMac) mergedSettings.appMode = 'local'
          }
          return {
            ...persisted,
            settings: mergedSettings,
            personas: [...BUILT_IN_PERSONAS, ...customPersonas],
            activePersonaId: persisted.activePersonaId || 'unrestricted',
            _version: STORE_VERSION,
          }
        }
        return persisted
      },
    }
  )
)
