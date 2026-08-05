/**
 * B1 (Morgan, promised for 2.6.3): the agent can open a folder and start a
 * program.
 *
 * The whole point of these two tools is that they act on the user's actual
 * desktop, so the interesting part is not that they work but what they refuse
 * and how tightly they are scoped. The Rust side proves the refusals
 * (src-tauri/src/commands/system.rs tests: URLs are not paths, a name that
 * could break out of a Windows command line is rejected). This file proves the
 * contract the MODEL sees: the arguments that reach the backend, the shape of
 * the schema, and that neither tool quietly grew a way to pass arguments to a
 * launched program.
 *
 * Run: npx vitest run src/api/__tests__/desktop-open-tools.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const backendCall = vi.fn()
vi.mock('../backend', () => ({
  backendCall: (...args: any[]) => backendCall(...args),
  fetchExternal: vi.fn(),
}))

const { toolRegistry } = await import('../mcp')

const toolNamed = (n: string) => toolRegistry.getAll().find((t) => t.name === n)!
const run = (n: string, args: Record<string, any>) => toolRegistry.execute(n, args)

beforeEach(() => backendCall.mockReset())

describe('desktop_open', () => {
  it('is offered as a desktop tool with path required and reveal optional', () => {
    const t = toolNamed('desktop_open')
    expect(t.category).toBe('desktop')
    expect(t.inputSchema.required).toEqual(['path'])
    expect(t.inputSchema.properties.path.type).toBe('string')
    expect(t.inputSchema.properties.reveal.type).toBe('boolean')
  })

  it('tells the model plainly that a link is not what this is for', () => {
    // The model reaching for desktop_open on a URL is the mistake worth
    // preventing in the prompt, not just in the backend.
    const d = toolNamed('desktop_open').description
    expect(d).toMatch(/https?:\/\//)
    expect(d).toMatch(/web_fetch/)
  })

  it('passes the path through and defaults reveal to false', async () => {
    backendCall.mockResolvedValue({ path: '/Users/x/Downloads', kind: 'folder', revealed: false })
    const out = await run('desktop_open', { path: '/Users/x/Downloads' })
    expect(backendCall).toHaveBeenCalledWith('desktop_open', {
      path: '/Users/x/Downloads',
      reveal: false,
    })
    expect(out).toBe('Folder opened: /Users/x/Downloads')
  })

  it('forwards reveal and says the item was revealed, not opened', async () => {
    backendCall.mockResolvedValue({ path: '/Users/x/a.txt', kind: 'file', revealed: true })
    const out = await run('desktop_open', { path: '/Users/x/a.txt', reveal: true })
    expect(backendCall).toHaveBeenCalledWith('desktop_open', { path: '/Users/x/a.txt', reveal: true })
    expect(out).toBe('File revealed in the file manager: /Users/x/a.txt')
  })

  it('only ever sends reveal as a real boolean', async () => {
    // A prompt-transport model can hand over the STRING "true", and "false" is
    // truthy in JavaScript. Anything that is not exactly true means false here.
    backendCall.mockResolvedValue({ path: '/p', kind: 'folder', revealed: false })
    await run('desktop_open', { path: '/p', reveal: 'false' as any })
    expect(backendCall.mock.calls[0][1].reveal).toBe(false)
  })

  it('refuses an empty path without touching the backend', async () => {
    const out = await run('desktop_open', { path: '   ' })
    expect(out).toMatch(/needs a path/)
    expect(backendCall).not.toHaveBeenCalled()
  })
})

describe('app_launch', () => {
  it('takes a name and nothing else, deliberately', () => {
    // No args parameter. An application plus model-chosen argv is a much
    // larger surface than "start Notepad", and shell_execute already exists
    // for the case that genuinely needs arguments.
    const t = toolNamed('app_launch')
    expect(t.category).toBe('desktop')
    expect(Object.keys(t.inputSchema.properties)).toEqual(['name'])
    expect(t.inputSchema.required).toEqual(['name'])
    expect(t.description).toMatch(/shell_execute/)
  })

  it('passes the trimmed name and reports what started', async () => {
    backendCall.mockResolvedValue({ launched: 'Google Chrome' })
    const out = await run('app_launch', { name: '  Google Chrome  ' })
    expect(backendCall).toHaveBeenCalledWith('app_launch', { name: 'Google Chrome' })
    expect(out).toBe('Launched Google Chrome.')
  })

  it('refuses an empty name without touching the backend', async () => {
    const out = await run('app_launch', { name: '' })
    expect(out).toMatch(/needs an application name/)
    expect(backendCall).not.toHaveBeenCalled()
  })

  it('never forwards anything the schema did not declare', async () => {
    // If a model invents `args`, it must not reach the backend just because it
    // was in the object.
    backendCall.mockResolvedValue({ launched: 'Notepad' })
    await run('app_launch', { name: 'Notepad', args: ['--evil'], cwd: '/' })
    expect(backendCall).toHaveBeenCalledWith('app_launch', { name: 'Notepad' })
  })
})
