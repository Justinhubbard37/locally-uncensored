
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from './cn'
import { tooltipPosition, type TooltipPlacement } from './tooltip-position'

interface Props {
  content: React.ReactNode
  children: React.ReactNode
  side?: 'top' | 'bottom'
  delay?: number
  className?: string
}

export function Tooltip({ content, children, side = 'top', delay = 400, className }: Props) {
  const [show, setShow] = useState(false)
  // The bubble is portalled to the body, so its coordinates are computed
  // rather than inherited. Until the first measurement it stays hidden — one
  // frame of a bubble in the top-left corner would be worse than none.
  const [place, setPlace] = useState<TooltipPlacement | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const anchor = useRef<HTMLSpanElement>(null)
  const bubble = useRef<HTMLSpanElement>(null)

const open = () => {
  if (timer.current) {
    clearTimeout(timer.current)
  }

  timer.current = setTimeout(() => {
    setShow(true)
    timer.current = null
  }, delay)
}

const close = () => {
  if (timer.current) {
    clearTimeout(timer.current)
    timer.current = null
  }

  setShow(false)
  setPlace(null)
}

const handleFocus = (
  event: React.FocusEvent<HTMLSpanElement>,
) => {
  const target = event.target as HTMLElement

  // Show focus tooltips for keyboard navigation, but not when a mouse
  // click leaves the wrapped button focused.
  if (target.matches(':focus-visible')) {
    open()
  }
}

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  // Measure before paint, then again whenever the page moves under the bubble.
  useLayoutEffect(() => {
    if (!show) return
    const measure = () => {
      const a = anchor.current?.getBoundingClientRect()
      const b = bubble.current?.getBoundingClientRect()
      if (!a || !b) return
      setPlace(tooltipPosition(
        { top: a.top, left: a.left, width: a.width, height: a.height },
        { width: b.width, height: b.height },
        { width: window.innerWidth, height: window.innerHeight },
        side,
      ))
    }
    measure()
    // Capture phase, because the clipping ancestor is usually the scroller.
    window.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    return () => {
      window.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
    }
  }, [show, side, content])

  return (
        <span
      ref={anchor}
      className={cn('relative inline-flex', className)}
      onMouseEnter={open}
      onMouseLeave={close}
      onPointerDown={close}
      onClick={close}
      onFocus={handleFocus}
      onBlur={close}
    >
      {children}
      {createPortal(
        <AnimatePresence>
          {show && (
            <motion.span
              ref={bubble}
              initial={{ opacity: 0, y: side === 'top' ? 3 : -3 }}
              animate={{ opacity: place ? 1 : 0, y: 0 }}
              exit={{ opacity: 0, y: side === 'top' ? 3 : -3 }}
              transition={{ duration: 0.12 }}
              role="tooltip"
              style={{ top: place?.top ?? 0, left: place?.left ?? 0 }}
              className="lu-elevated pointer-events-none fixed z-[60] w-max max-w-[220px] px-2.5 py-1.5 rounded-lg t-body text-gray-200"
            >
              {content}
              <span
                style={{ left: place?.arrowLeft ?? 0 }}
                className={cn(
                  'absolute -translate-x-1/2 w-2 h-2 rotate-45 bg-lu-overlay border-white/[0.08]',
                  (place?.side ?? side) === 'top' ? 'top-full -mt-1 border-b border-r' : 'bottom-full -mb-1 border-t border-l',
                )}
              />
            </motion.span>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </span>
  )
}
