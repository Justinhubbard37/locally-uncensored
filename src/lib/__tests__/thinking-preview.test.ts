/**
 * Thinking stays folded, streaming shows a bounded window (G14-7, David
 * 2026-08-07): the thinking bubble is collapsed by default everywhere and
 * while the model is reasoning a 3-4 line self-scrolling peek streams inside
 * the collapsed block. Supersedes the 2026-06-04 auto-expand rule.
 *
 * Run: npx vitest run src/lib/__tests__/thinking-preview.test.ts
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(resolve(here, rel), 'utf8')
const block = read('../../components/chat/ThinkingBlock.tsx')

describe('collapsed by default, everywhere', () => {
  it('open starts false and never follows the streaming flag', () => {
    expect(block).toContain('useState(false)')
    // the old auto-expand mechanics are gone, not just bypassed
    expect(block).not.toContain('userToggled')
    expect(block).not.toMatch(/open\s*=[^=].*streaming/)
  })

  it('both surfaces still mount it with a streaming flag', () => {
    for (const f of ['MessageBubble', 'CodexView']) {
      const src = read(`../../components/chat/${f}.tsx`)
      expect(src, f).toContain('<ThinkingBlock')
      expect(src, f).toContain('streaming=')
    }
  })
})

describe('the streaming peek', () => {
  it('is bounded to a few lines and clips the rest', () => {
    expect(block).toMatch(/PREVIEW_MAX_H = 'max-h-\[\d+px\]'/)
    const px = Number(block.match(/max-h-\[(\d+)px\]/)![1])
    // 3-4 lines of 0.65rem leading-relaxed text, not a full transcript
    expect(px).toBeGreaterThanOrEqual(48)
    expect(px).toBeLessThanOrEqual(80)
    expect(block).toContain('overflow-hidden pointer-events-none')
  })

  it('self-scrolls to the newest reasoning while streaming and collapsed', () => {
    expect(block).toContain('if (streaming && !open && previewRef.current)')
    expect(block).toContain('previewRef.current.scrollTop = previewRef.current.scrollHeight')
  })

  it('fades the top so old lines scroll out of view, like SlashStepsBlock', () => {
    expect(block).toContain('[mask-image:linear-gradient(to_bottom,transparent,#000_20px)]')
    expect(read('../../components/chat/SlashStepsBlock.tsx')).toContain('mask-image:linear-gradient(to_bottom,transparent')
  })

  it('NEGATIVE CONTROL: no peek once the turn is over or the block is open', () => {
    expect(block).toContain('{!open && streaming && (')
  })

  it('NEGATIVE CONTROL: expanding still yields the full unbounded text', () => {
    const expanded = block.slice(block.indexOf('<AnimatePresence>'))
    expect(expanded).toContain('<MarkdownRenderer content={cleaned} />')
    expect(expanded).not.toContain('max-h-')
  })

  it('NEGATIVE CONTROL: the empty-thought guard survived the rewrite', () => {
    expect(block).toContain('if (!cleaned) return null')
  })

  it('the header shimmers like a live tool name, only while still thinking', () => {
    expect(block).toContain("${streaming ? 'lu-tool-shimmer' : ''}")
    expect(read('../../index.css')).toContain('.lu-tool-shimmer')
  })
})
