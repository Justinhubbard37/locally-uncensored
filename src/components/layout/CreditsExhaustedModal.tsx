import { useEffect, useState } from 'react'
import { Zap } from 'lucide-react'
import { Modal } from '../ui/Modal'
import { CREDITS_EXHAUSTED_EVENT, TOPUP_URL } from '../../lib/credits-exhausted'
import { openExternal } from '../../api/backend'

/**
 * Globally mounted "out of credits" dialog. The OpenAI provider fires
 * CREDITS_EXHAUSTED_EVENT when LU Cloud answers `code: 'credits_exhausted'`
 * (lib/credits-exhausted.ts); this turns it into a purchase prompt with a
 * button to the website's top-up store instead of a dead-end error line.
 */
export function CreditsExhaustedModal() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const show = () => setOpen(true)
    window.addEventListener(CREDITS_EXHAUSTED_EVENT, show)
    return () => window.removeEventListener(CREDITS_EXHAUSTED_EVENT, show)
  }, [])

  return (
    <Modal open={open} onClose={() => setOpen(false)} title="You're out of credits">
      <div className="space-y-4">
        <p className="text-sm text-gray-600 dark:text-gray-300">
          Your plan credits for this month are used up. Top-up credits are
          one-time, never expire, and are only used after your monthly plan
          credits.
        </p>
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => {
              void openExternal(TOPUP_URL)
              setOpen(false)
            }}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-semibold px-4 py-2.5 transition-colors"
          >
            <Zap size={16} />
            Load up your credits
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded-xl px-4 py-2 text-sm text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white transition-colors"
          >
            Not now
          </button>
        </div>
      </div>
    </Modal>
  )
}
