// D#93 (stasicby): Wan's native training sizes were not reachable in one
// click, and there was no way to flip a video between portrait and landscape
// without retyping both fields. Pure math here, the UI just writes the same
// width/height the fields already own.

export interface ResPreset { label: string; width: number; height: number }

// Wan 2.1/2.2 train on exactly these (D#93): 480p in both flavours, and 720p.
export const VIDEO_RES_PRESETS: ResPreset[] = [
  { label: '480p', width: 832, height: 480 },
  { label: '480p 4:3', width: 720, height: 480 },
  { label: '720p', width: 1280, height: 720 },
]

export const ASPECT_RATIOS = [
  { label: '16:9', w: 16, h: 9 },
  { label: '9:16', w: 9, h: 16 },
  { label: '4:3', w: 4, h: 3 },
  { label: '3:4', w: 3, h: 4 },
  { label: '1:1', w: 1, h: 1 },
] as const

// Every local family accepts multiples of 16; finer grids (the latent 8) are
// a subset. Clamped to the same bounds as the NumberFields.
const GRID = 16
const snap = (v: number) => Math.min(4096, Math.max(64, Math.round(v / GRID) * GRID))

/** New dims in the given ratio, spending roughly the same pixel budget the
 *  user has set, snapped to the grid. Changing the ratio must not silently
 *  double the render cost. */
export function applyAspect(width: number, height: number, rw: number, rh: number): { width: number; height: number } {
  const area = width * height
  const w = Math.sqrt((area * rw) / rh)
  return { width: snap(w), height: snap((w * rh) / rw) }
}

/** A preset keeps the user's current orientation: picking 480p on a portrait
 *  canvas gives 480x832, not a silent flip back to landscape. */
export function presetForOrientation(p: ResPreset, portrait: boolean): { width: number; height: number } {
  const long = Math.max(p.width, p.height)
  const short = Math.min(p.width, p.height)
  return portrait ? { width: short, height: long } : { width: long, height: short }
}

/** True when the current canvas is this preset in either orientation, so the
 *  chip can light up without caring which way the video points. */
export function matchesPreset(width: number, height: number, p: ResPreset): boolean {
  return (
    (width === p.width && height === p.height) ||
    (width === p.height && height === p.width)
  )
}
