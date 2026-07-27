/**
 * staged-apply — the one trusted write path shared by the Pending panel's
 * Apply buttons and Codex auto-apply (codexAutoApply).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../api/backend', () => ({
  backendCall: vi.fn(),
}))
const { addMessage } = vi.hoisted(() => ({ addMessage: vi.fn() }))
vi.mock('../../stores/chatStore', () => ({
  useChatStore: { getState: () => ({ addMessage }) },
}))

import { backendCall } from '../../api/backend'
import { applyStagedChange, applyAllStagedChanges } from '../staged-apply'
import { useStagedChangesStore } from '../../stores/stagedChangesStore'

const fsWrite = backendCall as unknown as ReturnType<typeof vi.fn>
const CHAT = 'chat-1'

const stage = (path: string, over: Record<string, unknown> = {}) =>
  useStagedChangesStore.getState().stage(CHAT, {
    path,
    oldContent: '',
    newContent: `content of ${path}`,
    diff: '',
    ...over,
  })

describe('applyStagedChange', () => {
  beforeEach(() => {
    fsWrite.mockReset()
    addMessage.mockClear()
    useStagedChangesStore.getState().clear(CHAT)
  })

  it('writes via fs_write with the stage-time jail root and dequeues the entry', async () => {
    fsWrite.mockResolvedValue({ status: 'saved', path: '/proj/gui.py' })
    stage('gui.py', { resolvedPath: '/proj/gui.py', workingDirectory: '/proj' })
    const change = useStagedChangesStore.getState().list(CHAT)[0]

    await applyStagedChange(CHAT, change)

    expect(fsWrite).toHaveBeenCalledWith('fs_write', {
      path: '/proj/gui.py',
      content: 'content of gui.py',
      chatId: CHAT,
      workingDirectory: '/proj',
    })
    expect(useStagedChangesStore.getState().list(CHAT)).toHaveLength(0)
    expect(addMessage).toHaveBeenCalledOnce()
  })

  it('treats "unchanged" as success but throws on any other status, keeping the entry', async () => {
    fsWrite.mockResolvedValue({ status: 'unchanged', path: '/p/a.py' })
    stage('a.py')
    await applyStagedChange(CHAT, useStagedChangesStore.getState().list(CHAT)[0])
    expect(useStagedChangesStore.getState().list(CHAT)).toHaveLength(0)

    fsWrite.mockResolvedValue({ status: 'denied' })
    stage('b.py')
    const bad = useStagedChangesStore.getState().list(CHAT)[0]
    await expect(applyStagedChange(CHAT, bad)).rejects.toThrow(/denied/)
    expect(useStagedChangesStore.getState().list(CHAT)).toHaveLength(1)
  })
})

describe('applyAllStagedChanges', () => {
  beforeEach(() => {
    fsWrite.mockReset()
    addMessage.mockClear()
    useStagedChangesStore.getState().clear(CHAT)
  })

  it('applies everything and reports the paths', async () => {
    fsWrite.mockResolvedValue({ status: 'saved' })
    stage('one.py')
    stage('two.py')
    const res = await applyAllStagedChanges(CHAT)
    expect(res.applied.sort()).toEqual(['one.py', 'two.py'])
    expect(res.failed).toEqual([])
    expect(useStagedChangesStore.getState().list(CHAT)).toHaveLength(0)
  })

  it('one failing write never blocks the rest — it stays queued and is reported', async () => {
    stage('good.py')
    stage('bad.py')
    fsWrite.mockImplementation((_cmd: string, args: { path: string }) =>
      args.path.includes('bad')
        ? Promise.reject(new Error('disk full'))
        : Promise.resolve({ status: 'saved' }),
    )
    const res = await applyAllStagedChanges(CHAT)
    expect(res.applied).toEqual(['good.py'])
    expect(res.failed).toEqual(['bad.py'])
    const left = useStagedChangesStore.getState().list(CHAT)
    expect(left).toHaveLength(1)
    expect(left[0].path).toBe('bad.py')
  })
})
