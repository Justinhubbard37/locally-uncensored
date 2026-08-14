#!/usr/bin/env node
/**
 * Put an "old release" banner on every release except the current one.
 *
 * Why: GitHub keeps every release page public and Google ranks them. In the two
 * weeks to 2026-08-05 the release pages for v2.5.8 and v2.5.10 drew more unique
 * visitors than v2.6.2 did, and the in-app waitlist was still logging sign-ups
 * from 2.5.5 and 2.5.6 builds. Someone arriving from a search result had nothing
 * on the page telling them they were looking at an old version.
 *
 * Doing this by hand ages badly, which is the same failure the pinned download
 * route had. So it runs on every release: the new one gets its banner stripped
 * (in case it carried one), everything else gets one added. Idempotent, so a
 * re-run or a manual dispatch is free.
 */

import { MARKER, BANNER, withoutBanner, shouldCarryBanner } from './release-banner-rules.mjs'

const repo = process.env.GITHUB_REPOSITORY ?? 'PurpleDoubleD/locally-uncensored'
const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
if (!token) {
  console.error('GITHUB_TOKEN missing')
  process.exit(1)
}

const api = async (path, init = {}) => {
  const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'lu-mark-old-releases',
      ...(init.headers ?? {}),
    },
  })
  if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status} ${await res.text()}`)
  return res.json()
}

const releases = []
for (let page = 1; ; page++) {
  const batch = await api(`/releases?per_page=100&page=${page}`)
  releases.push(...batch)
  if (batch.length < 100) break
}

// `/releases/latest` is the release flagged Latest, which is a deliberate choice
// (we publish as a prerelease and flip it once verified), not simply the newest.
const latest = await api('/releases/latest')
console.log(`${releases.length} releases, current is ${latest.tag_name}`)

let added = 0
let removed = 0
for (const rel of releases) {
  const wants = shouldCarryBanner(rel, latest)
  const has = (rel.body ?? '').includes(MARKER)
  if (wants === has) continue // already in the right state

  const body = wants ? BANNER + withoutBanner(rel.body) : withoutBanner(rel.body)
  await api(`/releases/${rel.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ body }),
  })
  wants ? added++ : removed++
  console.log(`  ${wants ? 'banner ' : 'cleared'} ${rel.tag_name}`)
}

console.log(`done: ${added} banner added, ${removed} cleared`)
