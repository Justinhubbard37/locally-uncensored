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

// A staged change carries the file as it looked at stage time. The user reviews
// the diff, edits the file themselves in the meantime, then clicks Apply — the
// write used to silently revert their edit, with no undo.
describe('applyStagedChange refuses to overwrite a file that moved on', () => {
  beforeEach(() => {
    fsWrite.mockReset()
    addMessage.mockClear()
    useStagedChangesStore.getState().clear(CHAT)
  })

  const route = (disk: string | Error) =>
    fsWrite.mockImplementation((cmd: string) => {
      if (cmd === 'fs_read') {
        return disk instanceof Error ? Promise.reject(disk) : Promise.resolve({ content: disk })
      }
      return Promise.resolve({ status: 'saved' })
    })

  it('throws and keeps the entry when the file changed since staging', async () => {
    route('the user edited this')
    stage('a.py', { resolvedPath: '/proj/a.py', workingDirectory: '/proj', oldContent: 'as staged' })
    const change = useStagedChangesStore.getState().list(CHAT)[0]

    await expect(applyStagedChange(CHAT, change)).rejects.toThrow(/changed on disk/)
    expect(fsWrite).not.toHaveBeenCalledWith('fs_write', expect.anything())
    expect(useStagedChangesStore.getState().list(CHAT)).toHaveLength(1)
  })

  it('writes when the file still matches the stage-time content', async () => {
    route('as staged')
    stage('a.py', { resolvedPath: '/proj/a.py', workingDirectory: '/proj', oldContent: 'as staged' })
    await applyStagedChange(CHAT, useStagedChangesStore.getState().list(CHAT)[0])
    expect(useStagedChangesStore.getState().list(CHAT)).toHaveLength(0)
  })

  it('does not read at all for a new file (no baseline to compare against)', async () => {
    fsWrite.mockResolvedValue({ status: 'saved' })
    stage('new.py', { oldContent: '' })
    await applyStagedChange(CHAT, useStagedChangesStore.getState().list(CHAT)[0])
    expect(fsWrite).toHaveBeenCalledTimes(1)
    expect(fsWrite.mock.calls[0][0]).toBe('fs_write')
  })

  it('still writes when the file is gone — the write recreates it', async () => {
    route(new Error('no such file'))
    stage('a.py', { oldContent: 'as staged' })
    await applyStagedChange(CHAT, useStagedChangesStore.getState().list(CHAT)[0])
    expect(useStagedChangesStore.getState().list(CHAT)).toHaveLength(0)
  })

  // Refusing was too blunt: in Morgan's run (2026-08-11) every file had moved
  // on, so a finished plan wrote nothing at all. A foreign edit somewhere else
  // in the file is not a reason to drop work the user approved.
  it('merges a foreign edit elsewhere in the file and says so', async () => {
    route('a\nb\nc\nadded by another tool')
    stage('a.py', {
      resolvedPath: '/proj/a.py',
      workingDirectory: '/proj',
      oldContent: 'a\nb\nc',
      newContent: 'a\nCHANGED\nc',
    })
    await applyStagedChange(CHAT, useStagedChangesStore.getState().list(CHAT)[0])

    expect(fsWrite).toHaveBeenCalledWith('fs_write', {
      path: '/proj/a.py',
      content: 'a\nCHANGED\nc\nadded by another tool',
      chatId: CHAT,
      workingDirectory: '/proj',
    })
    expect(useStagedChangesStore.getState().list(CHAT)).toHaveLength(0)
    expect(addMessage.mock.calls[0][1].content).toMatch(/merged with 1 change made on disk/)
  })

  it('counts an already-applied file as done instead of failing it', async () => {
    route('a\nCHANGED\nc')
    stage('a.py', { oldContent: 'a\nb\nc', newContent: 'a\nCHANGED\nc' })
    await applyStagedChange(CHAT, useStagedChangesStore.getState().list(CHAT)[0])
    expect(useStagedChangesStore.getState().list(CHAT)).toHaveLength(0)
    expect(addMessage.mock.calls[0][1].content).not.toMatch(/merged/)
  })

  it('names the collision when the same lines moved on both sides', async () => {
    route('a\nTHEIRS\nc')
    stage('a.py', { oldContent: 'a\nb\nc', newContent: 'a\nOURS\nc' })
    await expect(
      applyStagedChange(CHAT, useStagedChangesStore.getState().list(CHAT)[0]),
    ).rejects.toThrow(/same place this edit touches/)
    expect(fsWrite).not.toHaveBeenCalledWith('fs_write', expect.anything())
  })

  it('one drifted file never blocks the rest of an apply-all', async () => {
    stage('good.py', { oldContent: 'base' })
    stage('drifted.py', { oldContent: 'base' })
    fsWrite.mockImplementation((cmd: string, args: { path: string }) => {
      if (cmd === 'fs_read') {
        return Promise.resolve({ content: args.path.includes('drifted') ? 'moved on' : 'base' })
      }
      return Promise.resolve({ status: 'saved' })
    })
    const res = await applyAllStagedChanges(CHAT)
    expect(res.applied).toEqual(['good.py'])
    expect(res.failed).toEqual(['drifted.py'])
  })
})
