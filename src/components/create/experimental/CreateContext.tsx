import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react'
import { useCreate } from '../../../hooks/useCreate'
import { useCloudCreate, hasActiveCloudRun } from '../../../hooks/useCloudCreate'
import { useCloudSession } from '../../../hooks/useCloudSession'
import { useCreateStore, type GalleryItem } from '../../../stores/createStore'
import { getLoraModels, getVAEModels, getCheckpoints, getDiffusionModels, getCLIPModels, getGgufUnetModels, checkComfyConnection, refreshComfyModels } from '../../../api/comfyui'
import { getAllNodeInfo, clearNodeCache } from '../../../api/comfyui-nodes'
import { installCustomNodes, getImageBundles, getVideoBundles, getAudioBundles, getLipsyncBundles, getMotionBundles, startModelDownload, getDownloadProgress, normalizeModelBase, ENUM_SUBFOLDERS } from '../../../api/discover'
import { backendCall, isMacOS } from '../../../api/backend'
import { installMlxStack } from '../../../api/mlx-install'
import { useDownloadStore } from '../../../stores/downloadStore'
import { downloadBundleFiles, waitOrAbort, waitForModelsVisible } from '../../../lib/bundle-install'
import { ensureLocalFilename } from './loadImage'
import { comfyStartupError } from './comfyError'
import type { CloudQuota } from '../../../lib/render/cloud-jobs'

/** Restart ComfyUI so a freshly installed node pack registers (packs only load
 *  on startup). stop_comfyui can only kill the ComfyUI that LU itself spawned:
 *  if the engine was started outside LU (user's own terminal/script), the old
 *  process keeps the port and keeps serving the stale node list — the pack
 *  would look installed but never show up, and the register-poll would burn
 *  40s to end in a misleading error. Detect that case and state the real fix. */
/** Hold until nothing is rendering, so a heal never lands on a live job.
 *  Bounded: a render that never reports finished must not park an install
 *  forever, and the caller falls back to the plain-language error either way. */
async function waitForIdleRender(signal?: AbortSignal, attempts = 120): Promise<void> {
  for (let i = 0; i < attempts && useCreateStore.getState().isGenerating; i++) {
    await waitOrAbort(5000, signal)
  }
}

/** Poll until the engine answers again, on the same budget this file uses for
 *  a warm start (ensureComfyRunning: 15 rounds of 2s). Deliberately does NOT
 *  fall through to install_comfyui the way ensureComfyRunning does: after a
 *  restart the engine is installed by definition, and a multi gigabyte install
 *  is not something to start behind a model download. */
async function waitForComfyBack(onStatus?: (m: string) => void, signal?: AbortSignal): Promise<boolean> {
  for (let i = 0; i < 15; i++) {
    if (await checkComfyConnection()) return true
    onStatus?.(`Waiting for ComfyUI to come back up… ${i * 2}s`)
    await waitOrAbort(2000, signal)
  }
  return await checkComfyConnection()
}

async function restartComfyForNewNodes(): Promise<void> {
  try { await backendCall('stop_comfyui') } catch { /* may already be stopped */ }
  // stop_comfyui reaps its child before returning, so LU's own engine is down
  // by now — poll a few extra rounds anyway instead of trusting one sleep.
  // Whatever still answers after that is an engine LU does not own.
  let stillUp = await checkComfyConnection()
  for (let i = 0; stillUp && i < 5; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    stillUp = await checkComfyConnection()
  }
  if (stillUp) {
    throw new Error(
      'Your ComfyUI is running outside LU, so LU cannot restart it. New node packs only load on startup: restart your ComfyUI yourself, then come back here.',
    )
  }
  await backendCall('start_comfyui')
}

/**
 * The seam between the redesigned Create surface and the live backend. Replaces
 * the sandbox mockStore's non-persisted actions (generate/cancel) and mockComfy
 * (uploadImage/installCapability/capability lists). Everything else the ported
 * components need is read straight from useCreateStore.
 */
interface CreateExpValue {
  generate: () => void | Promise<void>
  cancel: () => void | Promise<void>
  /** Video super-resolution on a finished cloud render (Lightbox "Enhance"). */
  enhanceVideo: (item: GalleryItem, targetResolution?: '720p' | '1080p') => Promise<void>
  /** Talking-character voice maker (qwen3-tts) — lands an audio gallery item
   *  and pre-selects it as the lipsync voice. Cloud-only. */
  makeVoice: (opts: {
    text: string
    mode: 'speak' | 'design'
    voice?: string
    description?: string
  }) => Promise<void>
  /** ComfyUI /object_info sampler + scheduler names (fallback lists until loaded). */
  samplerList: string[]
  schedulerList: string[]
  /** Installed LoRA + VAE filenames for the Advanced drawer. */
  loraList: string[]
  vaeList: string[]
  connected: boolean | null
  modelsLoaded: boolean
  modelLoadError: string | null
  /** macOS: which local lanes still have no MLX model. `null` off-Mac and until
   *  the first probe answers, so the setup card never flashes during startup. */
  mlxMissing: { image: boolean; video: boolean } | null
  /** True while the ComfyUI that LU launched runs with --cpu (shd_scorpion,
   *  RX 7900 XTX): surfaces the honest slow-mode warning instead of a silent
   *  20-minute timeout. */
  comfyOnCpu: boolean
  /** Install a missing capability in place: ensure ComfyUI runs (installing it
   *  first if needed), download the custom node when one is required, restart,
   *  and re-probe until available. Reports progress via the optional callback
   *  and throws on failure. 'rmbg' = the RMBG cutout node; 'inpaint-nodes' =
   *  ComfyUI's core inpaint nodes (nothing to clone — present on any current
   *  install once ComfyUI is up). */
  installCapability: (cap: 'rmbg' | 'inpaint-nodes' | 'dwpose', onProgress?: (msg: string) => void, signal?: AbortSignal) => Promise<void>
  /** One-click "everything you need" for a fresh PC: ensure ComfyUI runs
   *  (installing it first if needed), then download the default starter
   *  bundle for the intent kind (image → SDXL checkpoint, video → Wan 2.1,
   *  2.5.8 lanes → ACE / S2V / VACE starters incl. their node packs)
   *  with streamed progress, refresh ComfyUI's model enums and re-fetch the
   *  model lists. Throws on failure. */
  installModelBundle: (kind: 'image' | 'video' | 'audio' | 'lipsync' | 'motion', onProgress?: (msg: string) => void, signal?: AbortSignal) => Promise<void>
  /** Runtime backend axis: hosted rendering offered for this session? */
  cloudAvailable: boolean
  quota: CloudQuota | null
  refreshQuota: () => Promise<void>
}

const Ctx = createContext<CreateExpValue | null>(null)

export function useCreateExp(): CreateExpValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useCreateExp must be used within <CreateExpProvider>')
  return v
}

export function CreateExpProvider({ children }: { children: ReactNode }) {
  const {
    generate, cancel, samplerList, schedulerList,
    connected, modelsLoaded, modelLoadError, mlxMissing, checkConnection, fetchModels,
  } = useCreate()
  const { cloudAvailable, quota, refreshQuota } = useCloudSession()
  const cloud = useCloudCreate({ onQuotaChange: refreshQuota })
  const backend = useCreateStore((s) => s.backend)
  const setBackend = useCreateStore((s) => s.setBackend)
  const setCaps = useCreateStore((s) => s.setCaps)
  const [loraList, setLoraList] = useState<string[]>([])
  const [vaeList, setVaeList] = useState<string[]>(['auto'])
  const [comfyOnCpu, setComfyOnCpu] = useState(false)

  // Never strand the session on a dead axis: losing the license/logging out
  // while 'cloud' is selected falls back to local rendering.
  useEffect(() => {
    if (!cloudAvailable && backend === 'cloud') setBackend('local')
  }, [cloudAvailable, backend, setBackend])

  // Inputs picked while on cloud skip the ComfyUI staging (filename '') —
  // backfill it when the user switches to local so edit/animate keep working.
  useEffect(() => {
    if (backend !== 'local' || connected !== true) return
    const s = useCreateStore.getState()
    if (s.source && !s.source.filename) {
      ensureLocalFilename(s.source, 'source.png')
        .then((ref) => useCreateStore.getState().setSource(ref))
        .catch(() => { /* next generate surfaces the error */ })
    }
    if (s.mask && !s.mask.filename) {
      ensureLocalFilename(s.mask, 'mask.png')
        .then((ref) => useCreateStore.getState().setMask(ref))
        .catch(() => { /* next generate surfaces the error */ })
    }
  }, [backend, connected])

  // Bootstrap the backend exactly like the old CreateView mount did. On macOS
  // skip the ComfyUI probe entirely — hard rule: Mac local media is MLX-only
  // and ComfyUI never auto-starts there (process.rs::auto_start_comfyui).
  // Probing would pin `connected` to false, which is what the Stage's
  // ModelInstallCard reads as "no models" — it would cover a perfectly working
  // MLX catalog with a ComfyUI install card. Leaving it null means "not
  // applicable", which every ComfyUI-gated surface already treats as neutral.
  // fetchModels() still runs unconditionally: it's what loads the MLX
  // image/video catalogs on Mac.
  useEffect(() => {
    if (!isMacOS()) checkConnection()
    fetchModels()
  }, [checkConnection, fetchModels])

  // Surface a CPU-only ComfyUI (no usable GPU detected) so an AMD / non-NVIDIA
  // user isn't left staring at a silent 20-minute timeout. The Rust side records
  // the launch mode at every ComfyUI (re)start; re-read it whenever the
  // connection (re)establishes. Desktop-only (web has no such command → false).
  useEffect(() => {
    if (connected !== true) { setComfyOnCpu(false); return }
    let cancelled = false
    backendCall<{ startedCpu?: boolean | null }>('get_comfy_gpu_status')
      .then((s) => { if (!cancelled) setComfyOnCpu(s?.startedCpu === true) })
      .catch(() => { if (!cancelled) setComfyOnCpu(false) })
    return () => { cancelled = true }
  }, [connected])

  // Once ComfyUI is reachable, fetch LoRA/VAE lists and probe installed
  // capabilities (RMBG for cutout, inpaint nodes) so the UI gates correctly.
  useEffect(() => {
    if (connected !== true) return
    let cancelled = false
    ;(async () => {
      const [loras, vaes] = await Promise.all([
        getLoraModels().catch(() => [] as string[]),
        getVAEModels().catch(() => [] as string[]),
      ])
      if (cancelled) return
      setLoraList(loras)
      setVaeList(['auto', ...vaes])
      try {
        const nodes = await getAllNodeInfo()
        if (cancelled) return
        const names = new Set(Object.keys(nodes))
        setCaps({
          rmbg: names.has('RMBG'),
          'inpaint-nodes': names.has('VAEEncodeForInpaint') || names.has('InpaintModelConditioning'),
          dwpose: names.has('DWPreprocessor'),
        })
      } catch { /* node probe is best-effort */ }
    })()
    return () => { cancelled = true }
  }, [connected, setCaps])

  // One-click prerequisite: make sure a local ComfyUI is actually running —
  // start it if it's merely stopped, INSTALL it first if it's missing (the
  // "complete noob PC" case: every Create tab's Download & install button must
  // deliver a 100% functional run, not assume ComfyUI exists).
  // Every wait in here reports a ticking second count. A line that never
  // changes for 40s reads as frozen, which is exactly what David hit on the
  // Motion Control card: the only feedback was a spinner, so "is it doing
  // anything" had no answer. A counter answers it without promising a duration
  // we cannot know.
  const ensureComfyRunning = useCallback(async (onProgress?: (msg: string) => void, signal?: AbortSignal) => {
    if (await checkComfyConnection()) return
    onProgress?.('Starting ComfyUI…')
    try { await backendCall('start_comfyui') } catch { /* not installed yet — handled below */ }
    for (let i = 0; i < 15; i++) {
      onProgress?.(`Starting ComfyUI… ${i * 2}s`)
      await waitOrAbort(2000, signal)
      if (await checkComfyConnection()) { checkConnection(); return }
    }
    onProgress?.('ComfyUI is not installed. Downloading and installing it now, this is a one time step of a few GB…')
    await backendCall('install_comfyui')
    // Poll the same status contract the Settings installer uses. Generous cap:
    // a slow connection legitimately needs a while for the one-time install.
    for (let i = 0; i < 2700; i++) {
      await waitOrAbort(2000, signal)
      const st = await backendCall<{ status?: string; logs?: string[] }>('install_comfyui_status').catch(() => null)
      const lastLog = st?.logs?.length ? String(st.logs[st.logs.length - 1]) : ''
      if (lastLog) onProgress?.(lastLog)
      if (st?.status === 'complete') break
      if (st?.status === 'error') {
        throw new Error(lastLog || 'ComfyUI install failed. See Settings → AI Backends for details.')
      }
    }
    onProgress?.('Starting ComfyUI…')
    await backendCall('start_comfyui')
    for (let i = 0; i < 30; i++) {
      onProgress?.(`Starting ComfyUI… ${i * 2}s`)
      await waitOrAbort(2000, signal)
      if (await checkComfyConnection()) { checkConnection(); return }
      // The process died — every further poll waits on a port that will
      // never open. Fail now, with the crash instead of a guess (GH #98:
      // the shipped app has no console, so "did not come up" was a dead
      // end with nothing behind it).
      const out = await backendCall<{ lines?: string[]; exited?: boolean }>('comfyui_last_output').catch(() => null)
      if (out?.exited) throw new Error(comfyStartupError(out.lines))
    }
    const out = await backendCall<{ lines?: string[] }>('comfyui_last_output').catch(() => null)
    throw new Error(comfyStartupError(out?.lines))
  }, [checkConnection])

  // Install a capability in place — mirrors the VHS one-click flow (#72):
  // ensure ComfyUI runs, clone the custom node + pip install where one is
  // needed, restart ComfyUI so it registers, then poll /object_info (clearing
  // the node cache each round so we don't read the stale pre-install
  // catalogue) until the node shows up. The BiRefNet / RMBG-2.0 cutout model
  // is fetched by the node itself on the first run.
  const installCapability = useCallback(async (cap: 'rmbg' | 'inpaint-nodes' | 'dwpose', onProgress?: (msg: string) => void, signal?: AbortSignal) => {
    await ensureComfyRunning(onProgress, signal)
    const capsFrom = (names: Set<string>) => ({
      rmbg: names.has('RMBG'),
      'inpaint-nodes': names.has('VAEEncodeForInpaint') || names.has('InpaintModelConditioning'),
      dwpose: names.has('DWPreprocessor'),
    })
    if (cap === 'inpaint-nodes') {
      // Core ComfyUI nodes — nothing to clone. If they're still missing after
      // ComfyUI is up, the install is ancient; re-probe and say so honestly.
      const nodes = await getAllNodeInfo()
      const names = new Set(Object.keys(nodes))
      setCaps(capsFrom(names))
      if (!names.has('VAEEncodeForInpaint') && !names.has('InpaintModelConditioning')) {
        throw new Error(
          'This ComfyUI is missing its core inpaint nodes (VAEEncodeForInpaint). Update ComfyUI to a current version.',
        )
      }
      return
    }
    // Clone-and-pip capabilities share one flow: install the pack, restart
    // ComfyUI, poll /object_info (cache-cleared) until the node registers.
    const pack = cap === 'dwpose' ? 'controlnet-aux' : 'rmbg'
    const nodeClass = cap === 'dwpose' ? 'DWPreprocessor' : 'RMBG'
    onProgress?.(cap === 'dwpose'
      ? 'Downloading & installing the pose extractor (controlnet aux). This can take a minute…'
      : 'Downloading & installing the background removal node. This can take a minute…')
    await installCustomNodes([pack])
    onProgress?.('Restarting ComfyUI to register the node…')
    await restartComfyForNewNodes()
    for (let i = 0; i < 20; i++) {
      onProgress?.(`Waiting for ComfyUI to come back… ${i * 2}s`)
      await waitOrAbort(2000, signal)
      try {
        clearNodeCache()
        const nodes = await getAllNodeInfo()
        const names = new Set(Object.keys(nodes))
        if (names.has(nodeClass)) {
          setCaps(capsFrom(names))
          return
        }
      } catch { /* ComfyUI still restarting — keep polling */ }
    }
    throw new Error(
      `Installed ${pack} and restarted ComfyUI, but it still isn't listing the ${nodeClass} node. ` +
      'Open the Model Manager to finish the install, or check the ComfyUI console for a pip error.',
    )
  }, [setCaps, ensureComfyRunning])

  // One-click starter models for a fresh PC: ensure ComfyUI, then pull the
  // default bundle for the intent kind (image → SDXL checkpoint, video →
  // Wan 2.1 files, 2.5.8 lanes → their own starter bundles) through the
  // existing resumable downloader, streaming percent progress into the card,
  // then refresh ComfyUI's model enums so the new files are pickable without
  // a restart. Bundles that need a custom node pack (GGUF loader, pose
  // extractor) install + register it first — one click really means one click.
  const installModelBundle = useCallback(async (kind: 'image' | 'video' | 'audio' | 'lipsync' | 'motion', onProgress?: (msg: string) => void, signal?: AbortSignal) => {
    // macOS takes the MLX path — engine plus the smallest model of that kind.
    // Everything below this line is the ComfyUI bundle flow, which would start
    // by installing ComfyUI itself; on a Mac that is the one thing that must
    // never happen (Rust refuses it too — see process.rs::comfy_supported_here).
    // Only image and video exist locally there; the other lanes are cloud
    // teasers on a Mac and never render this card.
    if (isMacOS()) {
      if (kind !== 'image' && kind !== 'video') {
        throw new Error('This one runs in LU Cloud on a Mac — local generation covers images and video.')
      }
      await installMlxStack(kind, onProgress, signal)
      await fetchModels()
      return
    }
    await ensureComfyRunning(onProgress, signal)
    const bundle = (
      kind === 'image' ? getImageBundles()
      : kind === 'video' ? getVideoBundles()
      : kind === 'audio' ? getAudioBundles()
      : kind === 'lipsync' ? getLipsyncBundles()
      : getMotionBundles()
    )[0]
    if (!bundle) throw new Error('No starter bundle available for this intent.')
    if (bundle.customNodes?.length) {
      onProgress?.('Installing the required node packs. This can take a minute…')
      await installCustomNodes(bundle.customNodes)
      onProgress?.('Restarting ComfyUI to register the new nodes…')
      await restartComfyForNewNodes()
      for (let i = 0; i < 20; i++) {
        onProgress?.(`Waiting for ComfyUI to come back… ${i * 2}s`)
        await waitOrAbort(2000, signal)
        if (await checkComfyConnection()) break
      }
      clearNodeCache()
    }
    // Put the transfer in the header Downloads tray BEFORE the first byte.
    // Until now this path talked to the Rust downloader directly and never
    // touched the store, so the tray read "No active downloads" through a
    // 10.5 GB download and its cancel + retry buttons were unreachable
    // (David 2026-07-25). setBundleGroup collapses the files into one row,
    // setMeta is what the tray's retry needs to restart a failed file.
    const dl = useDownloadStore.getState()
    const files = bundle.files.filter((f) => f.downloadUrl && f.filename && f.subfolder)
    if (files.length > 1) dl.setBundleGroup(bundle.name, files.map((f) => f.filename!))
    for (const f of files) dl.setMeta(f.filename!, f.downloadUrl!, f.subfolder!)
    dl.startPolling()

    await downloadBundleFiles(
      files.map((f) => ({
        filename: f.filename!, subfolder: f.subfolder!, downloadUrl: f.downloadUrl!, sizeGB: f.sizeGB,
      })),
      {
        start: startModelDownload,
        progress: getDownloadProgress,
        onStatus: onProgress,
        // The tray's poller auto stops after an idle window, so re-arm it per
        // file instead of assuming the first call holds for the whole bundle.
        keepTrayLive: () => useDownloadStore.getState().startPolling(),
        // Cancel on the card must kill the Rust transfer too, or the download
        // keeps running invisibly after the card says it stopped.
        stop: (filename) => { void useDownloadStore.getState().cancel(filename) },
        signal,
      },
    )
    onProgress?.('Refreshing the model list…')
    const refreshLists = async () => {
      await refreshComfyModels().catch(() => false)
      clearNodeCache()
      await fetchModels()
    }
    await refreshLists()

    // A finished download is not a finished install. ComfyUI only offers what
    // its own directory scan has picked up, and on the big video bundles that
    // scan is still running when the last byte lands. Without this the card
    // stayed on "Refreshing the model list…" forever (C8, Voxyl AI and Aldrich
    // Ironhart 2026-08-13): the install returned happy, and Stage keeps the
    // card up until the lists refill.
    const enumFiles = files.filter((f) => ENUM_SUBFOLDERS.has(f.subfolder!))
    if (enumFiles.length > 0) {
      const wanted = enumFiles.map((f) => f.filename!)
      const stillMissing = async (): Promise<string[]> => {
        try {
          // getGgufUnetModels belongs here for the same reason getImageModels
          // needs it (comfyui.ts:658): UNETLoader only enumerates .safetensors
          // and .sft, GGUF quants are listed by ComfyUI-GGUF's own loader. The
          // default Talking Character bundle IS a .gguf in diffusion_models, so
          // without this the probe can never succeed: 20 rounds of waiting, an
          // uncalled-for engine restart in the middle of whatever the user was
          // rendering, and then an error blaming the model folder for a file
          // ComfyUI lists perfectly well.
          const lists = await Promise.all([
            getCheckpoints(), getDiffusionModels(), getVAEModels(), getCLIPModels(), getGgufUnetModels(),
          ])
          const visible = new Set(lists.flat().map(normalizeModelBase))
          return wanted.filter((n) => !visible.has(normalizeModelBase(n)))
        } catch {
          return wanted // engine unreachable, so it has confirmed nothing
        }
      }
      let missing = await waitForModelsVisible({
        missing: stillMissing, refresh: refreshLists, onStatus: onProgress, signal,
      })
      // Whatever the restart says is the PRECISE reason, and it has to outlive
      // the block so the throw below can prefer it over its own guess.
      let restartSaid = ''
      if (missing.length > 0) {
        // Heal before complaining: a restart rebuilds the model index for
        // certain, and it is the same move that registers a new node pack.
        //
        // Never while a render is in flight. An install runs on for minutes
        // after Stage swapped its card away, so without this guard a bundle
        // that finished downloading could stop the engine in the middle of
        // somebody's video and leave nothing behind but a dead job.
        if (useCreateStore.getState().isGenerating) {
          onProgress?.('Waiting for the current render to finish before restarting ComfyUI…')
          await waitForIdleRender(signal)
        }
        onProgress?.('Restarting ComfyUI so it picks up the new files…')
        try {
          await restartComfyForNewNodes()
        } catch (e) {
          restartSaid = e instanceof Error ? e.message : String(e)
        }
        // The engine has to be listening again before a scan can report
        // anything. The old code went straight into a 10 by 3s wait, which had
        // to cover the boot AND the directory scan, while this same file
        // budgets 30s for a warm boot alone and 60s after an install. On the
        // 12 GB video bundles the scan is the slow half, so a perfectly good
        // install ran out of time and got told its model folder was wrong.
        if (!restartSaid) await waitForComfyBack(onProgress, signal)
        missing = await waitForModelsVisible({
          missing: stillMissing, refresh: refreshLists, onStatus: onProgress, signal,
        })
      }
      if (missing.length > 0) {
        throw new Error(
          restartSaid ||
          `The files downloaded fine, but ComfyUI still does not list ${missing.join(', ')}. ` +
          'Either it is reading a different model folder than LU writes to, or it was started ' +
          'outside LU and cannot be restarted from here. The Model Manager shows where the ' +
          'files landed.',
        )
      }
    }
  }, [ensureComfyRunning, fetchModels])

  const value: CreateExpValue = {
    generate: backend === 'cloud' ? cloud.generate : generate,
    // Cancel routes by the backend that STARTED the run, not the current axis:
    // the header switch (or the license probe) can flip local/cloud mid-render,
    // and routing by the live value would abort a null handle while the real
    // run keeps going (a cloud job keeps billing; a local job keeps rendering).
    cancel: () => (hasActiveCloudRun() ? cloud.cancel() : cancel()),
    enhanceVideo: cloud.enhanceVideo,
    makeVoice: cloud.makeVoice,
    samplerList, schedulerList, loraList, vaeList,
    connected, modelsLoaded, modelLoadError, mlxMissing, comfyOnCpu, installCapability, installModelBundle,
    cloudAvailable, quota, refreshQuota,
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
