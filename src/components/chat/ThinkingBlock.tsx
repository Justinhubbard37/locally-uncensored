import { useState, useEffect, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronDown, Brain } from 'lucide-react'
import { MarkdownRenderer } from './MarkdownRenderer'
import { stripModelNoise } from '../../lib/strip-model-noise'

interface Props {
    thinking: string
    /** True while the model is actively producing this turn. Auto-expands the
     *  block so the reasoning is visible STREAMING in real time (David 2026-06-04),
     *  then auto-collapses once the turn finishes. The user can still toggle. */
    streaming?: boolean
}

export function ThinkingBlock({ thinking, streaming }: Props) {
    // null = follow `streaming` automatically; true/false = user override.
    const [userToggled, setUserToggled] = useState<boolean | null>(null)
    const open = userToggled !== null ? userToggled : !!streaming
    // When the turn ends, drop the manual override so the NEXT turn auto-expands.
    useEffect(() => { if (!streaming) setUserToggled(null) }, [streaming])

    // Strip orchestration out of the reasoning too (2.5.9): Qwen3-32B writes
    // its planned call as a raw <tool_call> tag inside the thought, and that
    // call is already rendered properly as its own block right below. Guard on
    // the CLEANED text so a thought that was nothing but a tag does not leave
    // an empty "Thinking" header behind.
    const cleaned = useMemo(() => stripModelNoise(thinking || ''), [thinking])
    if (!cleaned) return null

    return (
        <div className="mb-0.5">
            <button
                onClick={() => setUserToggled(!open)}
                className="flex items-center gap-1.5 py-0.5 text-left hover:opacity-80 transition-opacity"
                aria-label="Toggle thinking details"
            >
                <Brain size={10} className="text-blue-400/70 shrink-0" />
                <span className="text-[0.6rem] text-blue-400/70">Thinking</span>
                <ChevronDown
                    size={9}
                    className={`text-blue-400/50 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
                />
            </button>

            <AnimatePresence>
                {open && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.15 }}
                        className="overflow-hidden"
                    >
                        <div className="pl-4 pb-1 pt-0.5">
                            <div className="text-[0.65rem] leading-relaxed italic text-blue-200/40">
                                <MarkdownRenderer content={cleaned} />
                            </div>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    )
}
