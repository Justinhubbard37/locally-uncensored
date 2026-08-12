// One place where a run's seed becomes a real number.
//
// Before 2.6.5 four call sites rolled their own dice for `-1` (comfyui's
// getSeed, two branches of the dynamic builder, the custom-workflow injector)
// and none of them told anybody the result. The gallery therefore recorded
// `0` for every random run, so an image the user liked could never be
// reproduced (#110). The rule now: the caller that starts the run resolves the
// seed once and passes the number down. The builders keep calling this too, as
// a safety net for any other caller, but a resolved seed passes straight
// through untouched.

/** ComfyUI's KSampler takes a 32 bit signed seed. */
const SEED_MAX = 2147483647

export function resolveRunSeed(seed: number): number {
  if (!Number.isFinite(seed) || seed < 0) return Math.floor(Math.random() * SEED_MAX)
  return Math.floor(seed)
}
