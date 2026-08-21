import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type View = 'chat' | 'models' | 'settings' | 'create' | 'benchmark'

/** Which Cloud teaser sheet is open (Local-mode discovery, 2.5.8).
 *  'intent' = a locked Create tab (the cloud-only intents incl. the five
 *  2.5.8 categories); 'create-model' = a hosted model row in the Create
 *  picker (modelId = the tapped catalog id). The chat picker's Cloud rows
 *  open the CloudGateModal directly, no sheet there. */
export type CloudTeaserTarget =
  | {
      surface: 'intent'
      intent: 'upscale' | 'eraser' | 'character' | 'lipsync' | 'music' | 'extend' | 'motion'
    }
  | { surface: 'create-model'; kind: 'image' | 'video'; modelId: string }

/** Explorer panel geometry (2.6.6 C3). 280px is wide enough for a nested
 *  path, 200 is the floor where names stop being readable, and the ceiling is
 *  half the window so the panel can never eat the transcript. */
export const EXPLORER_DEFAULT_WIDTH = 280
export const EXPLORER_MIN_WIDTH = 200

/** Clamp a dragged width against the current window. Pure so the drag maths
 *  is testable without a DOM. */
export function clampExplorerWidth(width: number, viewportWidth: number): number {
  if (!Number.isFinite(width)) return EXPLORER_DEFAULT_WIDTH
  const half = Math.floor((Number.isFinite(viewportWidth) ? viewportWidth : 0) / 2)
  const max = Math.max(EXPLORER_MIN_WIDTH, half)
  return Math.round(Math.min(Math.max(width, EXPLORER_MIN_WIDTH), max))
}

interface UIState {
  currentView: View
  sidebarOpen: boolean
  /** CloudGateModal (login, plan, beta gate), opened by the header's
   *  Cloud switch when the cloud side isn't usable yet. */
  cloudGateOpen: boolean
  /** CloudTeaserModal, null = closed. */
  cloudTeaser: CloudTeaserTarget | null
  /** Explorer panel width in px, persisted. */
  explorerWidth: number
  /** Explorer panel collapsed to its rail, persisted. */
  explorerCollapsed: boolean
  setView: (view: View) => void
  toggleSidebar: () => void
  setSidebarOpen: (open: boolean) => void
  setCloudGateOpen: (open: boolean) => void
  setCloudTeaser: (target: CloudTeaserTarget | null) => void
  setExplorerWidth: (width: number, viewportWidth: number) => void
  setExplorerCollapsed: (collapsed: boolean) => void
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      currentView: 'chat',
      sidebarOpen: true,
      cloudGateOpen: false,
      cloudTeaser: null,
      explorerWidth: EXPLORER_DEFAULT_WIDTH,
      explorerCollapsed: false,

      // Sidebar visibility follows the view: it's the conversation list, which
      // only makes sense in Chat. The hamburger toggle still works on other views;
      // it just resets to the view's default on the next setView() call.
      setView: (view) => set({ currentView: view, sidebarOpen: view === 'chat' }),
      toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
      setSidebarOpen: (open) => set({ sidebarOpen: open }),
      setCloudGateOpen: (open) => set({ cloudGateOpen: open }),
      setCloudTeaser: (target) => set({ cloudTeaser: target }),
      setExplorerWidth: (width, viewportWidth) =>
        set({ explorerWidth: clampExplorerWidth(width, viewportWidth) }),
      setExplorerCollapsed: (collapsed) => set({ explorerCollapsed: collapsed }),
    }),
    {
      name: 'locally-uncensored-ui',
      // EXACTLY the two explorer fields (plan C3 / R1). This store was not
      // persisted at all before, and persisting it naively would carry
      // currentView and cloudGateOpen across restarts: the app would reopen on
      // whatever tab was left behind, or come up with the cloud gate on screen.
      partialize: (state) => ({
        explorerWidth: state.explorerWidth,
        explorerCollapsed: state.explorerCollapsed,
      }),
    },
  ),
)
