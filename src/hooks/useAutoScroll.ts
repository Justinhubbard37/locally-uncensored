import { useEffect, useRef } from 'react'

/**
 * Keep a chat list pinned to its bottom edge while the user is following.
 *
 * G33 (David 2026-08-07): on send the list jumped down "but never all the
 * way". Two mechanisms, both height that appears BELOW the fold without the
 * `dependency` string changing: the Working anchor mounts on a prop flip
 * (isGenerating), and a reasoning model streams into a thinking BLOCK while
 * `lastMessage.content` stays empty, so the trigger never fires and the view
 * parks one anchor-height short of the bottom for the whole thinking phase.
 *
 * So the pin no longer depends on guessing every trigger: a ResizeObserver on
 * the content wrapper re-pins whenever the content grows, as long as the user
 * is following. Scrolling up more than the threshold disengages following
 * (reading history during a run stays possible); `resumeKey` re-engages it —
 * the caller passes the last USER message id, because sending a message is an
 * explicit "take me to the newest", whatever the scroll position was.
 */
export function useAutoScroll(dependency: unknown, resumeKey?: unknown) {
  const ref = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const shouldScroll = useRef(true)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = el
      shouldScroll.current = scrollHeight - scrollTop - clientHeight < 100
    }

    el.addEventListener('scroll', handleScroll)
    return () => el.removeEventListener('scroll', handleScroll)
  }, [])

  // Follow every content-height change, not just the ones a trigger string
  // anticipated. Pinning inside the observer cannot loop: setting scrollTop
  // does not resize the content.
  useEffect(() => {
    const content = contentRef.current
    if (!content || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      const el = ref.current
      if (shouldScroll.current && el) el.scrollTop = el.scrollHeight
    })
    ro.observe(content)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (resumeKey === undefined) return
    shouldScroll.current = true
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [resumeKey])

  useEffect(() => {
    if (shouldScroll.current && ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight
    }
  }, [dependency])

  return { ref, contentRef }
}
