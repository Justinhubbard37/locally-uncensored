import { useEffect, useState } from 'react'
import { Minus, Square, Copy, X } from 'lucide-react'
import { isMacOS } from '../../api/backend'

const isTauri = typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__

export function Titlebar() {
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    if (!isTauri) return

    let unlisten: (() => void) | undefined

    import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      const win = getCurrentWindow()
      // Check initial state
      win.isMaximized().then(setIsMaximized)

      // Listen for resize to update maximize state
      win.onResized(() => {
        win.isMaximized().then(setIsMaximized)
      }).then((fn) => { unlisten = fn })
    })

    return () => { unlisten?.() }
  }, [])

  if (!isTauri) return null

  const handleMinimize = async () => {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    getCurrentWindow().minimize()
  }

  const handleToggleMaximize = async () => {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    getCurrentWindow().toggleMaximize()
  }

  const handleClose = async () => {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    getCurrentWindow().close()
  }

  const btnBase = 'inline-flex items-center justify-center w-[46px] h-8 transition-colors'

  // macOS uses the OS-native traffic lights (close/minimize/zoom) rendered on
  // the LEFT by titleBarStyle:"Overlay" (tauri.macos.conf.json). So on mac we
  // draw NO custom window buttons — we just reserve space on the left for the
  // native lights and move the LU logo to the RIGHT (David 2026-07-11). The
  // whole strip stays a drag region.
  if (isMacOS()) {
    return (
      <div
        data-tauri-drag-region
        className="h-8 flex items-center justify-end bg-gray-100 dark:bg-[#141414] select-none pl-[80px] pr-3"
      >
        <img src="/LU-monogram-bw.png" alt="" width={18} height={18} className="pointer-events-none dark:invert-0 invert opacity-80" />
      </div>
    )
  }

  return (
    <div
      data-tauri-drag-region
      className="h-8 flex items-center justify-between bg-gray-100 dark:bg-[#141414] select-none"
    >
      {/* Left: App icon + title */}
      <div data-tauri-drag-region className="flex items-center gap-1.5 pl-3">
        <img src="/LU-monogram-bw.png" alt="" width={18} height={18} className="pointer-events-none dark:invert-0 invert opacity-80" />
      </div>

      {/* Right: Window controls (Windows/Linux — custom, since decorations:false) */}
      <div className="flex items-center">
        <button
          onClick={handleMinimize}
          className={`${btnBase} text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/10`}
          aria-label="Minimize"
        >
          <Minus size={14} strokeWidth={1.5} />
        </button>
        <button
          onClick={handleToggleMaximize}
          className={`${btnBase} text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/10`}
          aria-label={isMaximized ? 'Restore' : 'Maximize'}
        >
          {isMaximized ? <Copy size={11} strokeWidth={1.5} /> : <Square size={11} strokeWidth={1.5} />}
        </button>
        <button
          onClick={handleClose}
          className={`${btnBase} text-gray-500 dark:text-gray-400 hover:bg-red-500 hover:text-white`}
          aria-label="Close"
        >
          <X size={14} strokeWidth={1.5} />
        </button>
      </div>
    </div>
  )
}
