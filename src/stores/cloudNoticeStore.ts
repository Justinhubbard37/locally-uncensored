import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * How long a cloud render stays retrievable. Single source of truth for the
 * copy so the number never drifts between surfaces.
 *
 * ⚠️ Server reality (verified 2026-07-24, lu-labs @ services/render-worker):
 * `RESULT_SIGNED_URL_TTL_SEC` defaults to 604800 (7 days) — that is the signed
 * URL lifetime, and the desktop silently re-signs an expired one via the job id
 * (galleryUrl.ts refreshResultUrl). The only deleting sweep, reaper.ts, targets
 * the render-INPUTS bucket (48h grace) and is OFF unless REAP_ORPHAN_INPUTS is
 * set. Nothing currently deletes the RESULTS bucket. So this notice states a
 * policy the backend does not enforce yet; it needs a results-bucket reaper
 * before the claim is literally true.
 */
export const CLOUD_RETENTION_DAYS = 7;

/**
 * Gallery retention notice for cloud mode (David 2026-07-24). Shown while the
 * Create surface is on the cloud backend so nobody treats the cloud gallery as
 * permanent storage.
 *
 * `retentionNoticeSeen` (persisted) is the ONLY thing that hides it, and it is
 * once ever: no auto-hide, no close X, and it does NOT come back after an
 * update. Dismissing is a deliberate click on "Do not show again", matching the
 * one-time-onboarding rule the Try local / Try cloud popups follow.
 */
interface CloudNoticeState {
  retentionNoticeSeen: boolean;
  setRetentionNoticeSeen: (v: boolean) => void;
}

export const useCloudNoticeStore = create<CloudNoticeState>()(
  persist(
    (set) => ({
      retentionNoticeSeen: false,
      setRetentionNoticeSeen: (v) => set({ retentionNoticeSeen: v }),
    }),
    { name: "lu_cloud_notice" },
  ),
);

/**
 * Visibility rule for the retention notice, kept pure so it is unit-testable
 * (the JSX condition would otherwise only be provable via a live E2E). Cloud
 * backend only — a local render never leaves the machine, so the warning would
 * be a lie there — and never again once dismissed.
 */
export function shouldShowRetentionNotice(
  backend: "local" | "cloud",
  retentionNoticeSeen: boolean,
): boolean {
  return backend === "cloud" && !retentionNoticeSeen;
}
