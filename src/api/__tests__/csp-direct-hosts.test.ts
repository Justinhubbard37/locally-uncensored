import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isDirectFetchAllowed } from '../backend'

// The webview may only fetch hosts the pinned CSP lists — anything else dies
// inside the webview before it reaches the network, so it has to take the Rust
// proxy instead. isDirectFetchAllowed() mirrors that list by hand; if the two
// drift apart a provider breaks with an unexplainable network error.
describe('CSP direct-fetch allow-list', () => {
  const conf = JSON.parse(
    readFileSync(resolve(process.cwd(), 'src-tauri/tauri.conf.json'), 'utf8'),
  )
  const csp: string = conf.app.security.csp
  const connectSrc = csp.split(';').map(p => p.trim()).find(p => p.startsWith('connect-src')) ?? ''
  const httpsHosts = connectSrc
    .split(/\s+/)
    .filter(t => t.startsWith('https://'))
    .map(t => t.slice('https://'.length))

  it('mirrors every https host the CSP allows', () => {
    expect(httpsHosts.length).toBeGreaterThan(5)
    for (const host of httpsHosts) {
      const probe = host.startsWith('*.') ? `sub.${host.slice(2)}` : host
      expect(isDirectFetchAllowed(probe), `${probe} is in the CSP but not in CSP_DIRECT_HOSTS`).toBe(true)
    }
  })

  it('routes a user-configured cloud endpoint through the proxy', () => {
    for (const host of ['api.fireworks.ai', 'api.x.ai', 'api.cerebras.ai', 'llm.example.com']) {
      expect(isDirectFetchAllowed(host), `${host} must not use a direct fetch`).toBe(false)
    }
  })

  it('ignores case and empty hosts', () => {
    expect(isDirectFetchAllowed('API.GROQ.COM')).toBe(true)
    expect(isDirectFetchAllowed('')).toBe(false)
  })
})
