/**
 * What a bundle card should say: Installed, Installing, Retry or Get.
 *
 * GH #113, JonnFlauty on Windows 11 with an RTX 5070 Ti: a video download
 * failed midway, he retried, and afterwards the model "doesn't shown in the
 * installed section and for some reason every model in the list shown retry".
 *
 * The download store is keyed by FILENAME, and bundles share files. Seven of
 * the thirteen video bundles ship the same umt5_xxl_fp8_e4m3fn_scaled text
 * encoder and six the same wan_2.1_vae, so one attempt on one bundle writes
 * rows that every other bundle in the list then reads as if they were about
 * itself:
 *
 *   - one error row on a shared file made every bundle carrying that filename
 *     count as NOT installed, even the ones sitting complete on disk, because
 *     the error veto ran before the disk answer;
 *   - one FINISHED shared file made every bundle carrying it look half
 *     downloaded, which is the Retry button on every card in the list.
 *
 * So the rule is: the disk is the only source that speaks about this bundle
 * and nothing else, and a download row only says something about this bundle
 * when it is about a file this bundle is still missing.
 *
 * Pure on purpose. The component holds the store and the disk verdicts; the
 * decision is here where it can be proven without either.
 */

/** The one field of a download row any of this depends on. */
export interface DownloadRow {
  status: string
}

/** A bundle file, narrowed to what the state machine reads. */
export interface BundleFileRef {
  filename?: string
}

type Rows = Record<string, DownloadRow | undefined>

/** Files of the bundle that actually have a name to look up. */
function named(files: BundleFileRef[]): string[] {
  return files.map((f) => f.filename).filter((n): n is string => !!n)
}

/**
 * Installed.
 *
 * `diskInstalled` is checkBundlesInstalled's verdict: every file present at
 * its full size AND visible to the running ComfyUI. It is asked FIRST because
 * it is the only signal that is about this bundle alone. The old order let a
 * stale error row on a shared filename overrule a bundle that was completely
 * and verifiably on disk.
 */
export function bundleIsComplete(
  files: BundleFileRef[],
  downloads: Rows,
  diskInstalled: boolean,
): boolean {
  if (diskInstalled) return true
  const names = named(files)
  // Session fallback: everything this bundle needs finished in this run. An
  // error row cannot pass this either, so the old separate veto bought
  // nothing here beyond the false negative it caused.
  return names.length > 0 && names.every((n) => downloads[n]?.status === 'complete')
}

/** Something of this bundle is moving right now. */
export function bundleIsDownloading(files: BundleFileRef[], downloads: Rows): boolean {
  return named(files).some((n) => {
    const s = downloads[n]?.status
    return s === 'downloading' || s === 'connecting'
  })
}

/**
 * Retry, meaning this bundle really did stop halfway.
 *
 * An explicit error row still counts, whatever it is on: a shared file that
 * cannot be fetched blocks this bundle just as much as its own.
 *
 * The half-downloaded case is the one that had to change. "Some files
 * complete, not all" is true of every bundle that merely shares a finished
 * file with an installed sibling, which is how one good install turned the
 * whole list red. It only means something when the part that is MISSING was
 * attempted too, so there is a row for a file that is not complete.
 */
export function bundleHasErrors(
  files: BundleFileRef[],
  downloads: Rows,
  diskInstalled: boolean,
): boolean {
  const names = named(files)
  if (names.some((n) => downloads[n]?.status === 'error')) return true
  if (diskInstalled) return false
  const done = names.filter((n) => downloads[n]?.status === 'complete')
  if (done.length === 0 || done.length === names.length) return false
  return names.some((n) => {
    const row = downloads[n]
    return row !== undefined && row.status !== 'complete'
  })
}
