import {
  Image as ImageIcon, Wand2, Scissors, Video, Film, Maximize2, Eraser,
  UserRound, Mic, Music, FastForward, PersonStanding,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { CreateBackend, CreateIntent } from '../../../stores/createStore'

export interface IntentMeta {
  id: CreateIntent
  label: string
  short: string
  icon: LucideIcon
  placeholder: string
  needsSource: boolean
  needsPrompt: boolean
  allowsMask: boolean
  isVideo: boolean
  /** Capability id (node probe) this intent depends on, if any. */
  capability?: 'rmbg' | 'inpaint-nodes' | 'dwpose'
  /** Categories with a hosted endpoint (cloud clip/teaser exists). */
  cloudOnly?: true
  /** 2.5.8: cloudOnly categories that ALSO run on the local ComfyUI backend
   *  (mirrors createStore's LOCAL_LANE_OPS). The IntentBar unlocks these in
   *  local mode; the cloud glyph becomes a "Try cloud" affordance. */
  hasLocalLane?: true
  /** Local model files this intent needs (gates the Download & install card). */
  requiresModels?: 'image' | 'video' | 'audio' | 'lipsync' | 'motion'
  examples: string[]
}

export const INTENTS: IntentMeta[] = [
  {
    id: 'image', label: 'Image', short: 'Image', icon: ImageIcon,
    placeholder: 'Describe your image…',
    needsSource: false, needsPrompt: true, allowsMask: false, isVideo: false,
    requiresModels: 'image',
    examples: [
      'a lighthouse at dusk, dramatic storm clouds, cinematic',
      'a neon alley in the rain, reflections, moody',
      'a cozy reading nook by a window, warm morning light',
    ],
  },
  {
    // This IS the image-to-image tab. Source + empty mask restyles the WHOLE
    // image (VAEEncode at denoise 0.7, dynamic-workflow isI2I); painting a mask
    // switches to inpaint (VAEEncodeForInpaint / InpaintModelConditioning) on
    // the SDXL/SD1.5 checkpoint path. Cloud keeps its hosted edit endpoint; both
    // share the MaskEditor. Renamed 2.5.9: "Edit" alone hid the i2i entry for
    // the r/SD crowd who search for "image to image" (GH D#86 jendrelele /
    // the_mr_pickles / pnwpdr4519; David committed to making it clearer).
    id: 'edit', label: 'Edit / Image to Image', short: 'Edit', icon: Wand2,
    placeholder: 'Describe the new look. Leave the mask empty to restyle the whole image, or paint an area to change just that…',
    needsSource: true, needsPrompt: true, allowsMask: true, isVideo: false,
    capability: 'inpaint-nodes', requiresModels: 'image',
    examples: ['turn this photo into a watercolor painting', 'make it a snowy winter scene', 'repaint it in a neon cyberpunk style'],
  },
  {
    id: 'removebg', label: 'Remove Background', short: 'Cutout', icon: Scissors,
    placeholder: '',
    needsSource: true, needsPrompt: false, allowsMask: false, isVideo: false,
    capability: 'rmbg',
    examples: [],
  },
  {
    id: 'upscale', label: 'Upscale', short: 'Upscale', icon: Maximize2,
    placeholder: '',
    needsSource: true, needsPrompt: false, allowsMask: false, isVideo: false,
    cloudOnly: true,
    examples: [],
  },
  {
    id: 'eraser', label: 'Erase Object', short: 'Erase', icon: Eraser,
    placeholder: '',
    needsSource: true, needsPrompt: false, allowsMask: true, isVideo: false,
    cloudOnly: true,
    examples: [],
  },
  {
    id: 'video', label: 'Video', short: 'Video', icon: Video,
    placeholder: 'Describe the motion and the scene…',
    needsSource: false, needsPrompt: true, allowsMask: false, isVideo: true,
    requiresModels: 'video',
    examples: ['a wave breaking on rocks in slow motion, cinematic', 'timelapse of clouds over a mountain range'],
  },
  {
    // Local lane restored 2026-07-17 (David): the lu-labs port had marked
    // animate cloudOnly, which silently dropped the local I2V the old Create
    // tab always had. Local builds route through buildDynamicWorkflow's
    // family-specific I2V wiring (WAN/WAN2.2/Hunyuan/LTX/Cosmos/SVD/FramePack);
    // the model picker only offers i2v-capable models here.
    id: 'animate', label: 'Animate Image', short: 'Animate', icon: Film,
    placeholder: 'Describe how the image should move…',
    needsSource: true, needsPrompt: true, allowsMask: false, isVideo: true,
    requiresModels: 'video',
    examples: ['slow zoom in, subtle parallax', 'hair and clothes moving in the wind'],
  },

  // ── 2.5.8 specialized categories (2026-07-17 David). All have hosted
  // endpoints (cloudOnly = cloud clip/teaser exists); music, lipsync, extend
  // and motion ALSO run locally (hasLocalLane) on core ComfyUI node families
  // (ACE audio, Wan S2V, I2V last-frame chain, Wan VACE/Animate). Their
  // composer surfaces own the extra inputs (training set, audio, driving
  // video, extend pick), so needsSource / needsPrompt describe only the
  // shared composer scaffolding. ──
  {
    // Character training is CLOUD-FIRST (David 2026-07-19): the local lane
    // needs a whole trainer runtime (musubi-tuner venv) that 2.5.8 does not
    // ship, so no hasLocalLane until that exists.
    id: 'character', label: 'Character Studio', short: 'Character', icon: UserRound,
    placeholder: 'Describe the scene for your character…',
    needsSource: false, needsPrompt: false, allowsMask: false, isVideo: false,
    cloudOnly: true,
    examples: [],
  },
  {
    // Inputs (portrait or base clip + speech audio) are composer chips, not
    // the Stage source slot — which input the model needs depends on the
    // picked endpoint (photo-avatar vs re-sync).
    id: 'lipsync', label: 'Talking Character', short: 'Lipsync', icon: Mic,
    placeholder: '',
    needsSource: false, needsPrompt: false, allowsMask: false, isVideo: true,
    cloudOnly: true, hasLocalLane: true, requiresModels: 'lipsync',
    examples: [],
  },
  {
    id: 'music', label: 'Music', short: 'Music', icon: Music,
    placeholder: 'Describe the track. Genre, mood, tempo, instruments…',
    needsSource: false, needsPrompt: true, allowsMask: false, isVideo: false,
    cloudOnly: true, hasLocalLane: true, requiresModels: 'audio',
    examples: [
      'dreamy lofi hip hop, vinyl crackle, mellow keys',
      'epic orchestral trailer, driving percussion',
      'upbeat synthwave, retro 80s arps',
    ],
  },
  {
    // Local lane: the picked clip's LAST FRAME becomes the I2V start image,
    // so it gates on the regular video models like animate does.
    id: 'extend', label: 'Extend Video', short: 'Extend', icon: FastForward,
    placeholder: 'Describe how the clip should continue…',
    needsSource: false, needsPrompt: true, allowsMask: false, isVideo: true,
    cloudOnly: true, hasLocalLane: true, requiresModels: 'video',
    examples: [],
  },
  {
    // Local lane on Wan VACE/Animate + DWPose (comfyui_controlnet_aux).
    // DWPose imports fine on Windows (falls back to OpenCV on CPU when
    // onnxruntime-gpu is absent — slower, not broken); the pack only shows
    // up after a ComfyUI restart, which installCapability performs.
    id: 'motion', label: 'Motion Control', short: 'Motion', icon: PersonStanding,
    placeholder: 'Optional: extra style/scene hints…',
    needsSource: false, needsPrompt: false, allowsMask: false, isVideo: true,
    capability: 'dwpose',
    cloudOnly: true, hasLocalLane: true, requiresModels: 'motion',
    examples: [],
  },
]

export const INTENT_MAP: Record<CreateIntent, IntentMeta> =
  Object.fromEntries(INTENTS.map((i) => [i.id, i])) as Record<CreateIntent, IntentMeta>

/**
 * The intents that have a REAL local pipeline on an MLX host (Apple Silicon
 * Mac). Every local lane above is a ComfyUI graph, and the Mac has no ComfyUI
 * at all — its local media is the in-process MLX path (api/mlx-image.ts,
 * api/mlx-video.ts). MLX generate accepts prompt / steps / seed / size /
 * negative and nothing else, and there is no ComfyUI /upload/image to stage a
 * source through (loadImageRef's local branch uploads there), so plain
 * text-to-image and text-to-video are the only intents that actually run.
 *
 * Everything else must NOT look like a working local tab — see visibleIntents
 * / isIntentLocked below.
 */
const MLX_LOCAL_INTENTS: ReadonlySet<CreateIntent> = new Set<CreateIntent>(['image', 'video'])

/**
 * The intents to surface for a given backend + host. Pure so the rule is unit
 * tested instead of buried in the IntentBar's JSX.
 *
 * Cloud shows everything. Local (ComfyUI, Windows/Linux) also shows
 * everything — the hosted-only tools render as locked cloud teasers rather
 * than disappearing. Local on an MLX Mac hides the intents that have neither a
 * local MLX path nor a hosted teaser sheet (edit, removebg, animate): they
 * need a ComfyUI node or a ComfyUI-staged source image, so leaving them
 * selectable is a dead affordance that either errors on submit or — worse, the
 * MLX case — silently drops the source and returns an unrelated fresh image.
 */
export function visibleIntents(backend: CreateBackend, mlxHost: boolean): IntentMeta[] {
  if (backend === 'cloud' || !mlxHost) return INTENTS
  return INTENTS.filter((m) => MLX_LOCAL_INTENTS.has(m.id) || m.cloudOnly === true)
}

/**
 * Whether an intent renders as a locked cloud teaser instead of a selectable
 * local tab. Cloud never locks. On local ComfyUI hosts only the genuinely
 * hosted-only tools lock (the 2.5.8 lanes with hasLocalLane are real local
 * tabs). On an MLX Mac every non-MLX intent that survives visibleIntents locks
 * — those lanes' "local" implementation is a ComfyUI graph this host does not
 * have, so the honest state is the cloud teaser, not a working-looking pill.
 */
export function isIntentLocked(meta: IntentMeta, backend: CreateBackend, mlxHost: boolean): boolean {
  if (backend === 'cloud') return false
  if (mlxHost) return !MLX_LOCAL_INTENTS.has(meta.id)
  return meta.cloudOnly === true && !meta.hasLocalLane
}

/**
 * Whether an intent is reachable as a working tab (shown AND not a locked
 * teaser) for this backend + host. Same rule as the IntentBar, exposed for the
 * result actions that FORCE-switch to an intent — "Edit with mask" on a
 * finished image used to set 'edit' even where that lane cannot run.
 */
export function isIntentAvailable(id: CreateIntent, backend: CreateBackend, mlxHost: boolean): boolean {
  const meta = INTENT_MAP[id]
  return visibleIntents(backend, mlxHost).includes(meta) && !isIntentLocked(meta, backend, mlxHost)
}
