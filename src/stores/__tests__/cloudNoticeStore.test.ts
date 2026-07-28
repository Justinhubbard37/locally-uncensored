import { describe, it, expect, beforeEach } from 'vitest'
import { useCloudNoticeStore, CLOUD_RETENTION_DAYS, shouldShowRetentionNotice } from '../cloudNoticeStore'

describe('cloudNoticeStore — cloud gallery retention notice (David 2026-07-24)', () => {
  beforeEach(() => {
    useCloudNoticeStore.setState({ retentionNoticeSeen: false })
  })

  it('starts undismissed so a fresh user sees the notice once', () => {
    expect(useCloudNoticeStore.getState().retentionNoticeSeen).toBe(false)
  })

  it('"Do not show again" latches permanently', () => {
    useCloudNoticeStore.getState().setRetentionNoticeSeen(true)
    expect(useCloudNoticeStore.getState().retentionNoticeSeen).toBe(true)
  })

  it('shows only on the cloud backend, never for a local render', () => {
    // A local render never leaves the machine, so a retention warning there
    // would be plain wrong.
    expect(shouldShowRetentionNotice('cloud', false)).toBe(true)
    expect(shouldShowRetentionNotice('local', false)).toBe(false)
  })

  it('stays gone once dismissed, on either backend', () => {
    // Once-ever rule: the notice must not come back after an update or after a
    // local/cloud round trip. Dismissal is persisted, so this is the whole gate.
    expect(shouldShowRetentionNotice('cloud', true)).toBe(false)
    expect(shouldShowRetentionNotice('local', true)).toBe(false)
  })

  it('exposes the retention window as one constant so copy cannot drift', () => {
    expect(CLOUD_RETENTION_DAYS).toBe(7)
  })
})
