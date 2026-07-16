/**
 * Matcap gallery registry (Ray's request, 2026-07-16): the built-in procedural
 * "Studio" matcap plus the image matcaps split from his two sphere sheets
 * (assets/matcaps/*.png, 256², bundled by vite as hashed URLs so dev and the
 * gh-pages `base:'./'` build both resolve).
 *
 * The selected matcap is an APP PREFERENCE (shadePrefs.matcap, persisted); the
 * Renderer uploads/caches textures lazily and MeshPass samples whichever is
 * active. GAIN: the mesh shader multiplies the matcap by gain·objectColor —
 * the procedural map was authored around the historical ×2.0 (mid-grey map ×
 * default 0.69 grey object ≈ the classic look); image matcaps are authored at
 * display brightness, so their gain is 1/0.69 ≈ 1.45: a default-grey object
 * shows the sphere exactly as painted, and object colors tint relative to it.
 */

export interface MatcapEntry {
  /** Stable id persisted in shadePrefs.matcap. */
  id: string;
  /** Display name in the gallery. */
  name: string;
  /** Bundled image URL; undefined = the procedural Studio texture. */
  url?: string;
  /** Shader gain (see header comment). */
  gain: number;
}

/** The historical mesh-shader exposure for the procedural map. */
export const MATCAP_GAIN_PROCEDURAL = 2.0;
/** Image matcaps: 1/default-grey so they display as authored. */
export const MATCAP_GAIN_IMAGE = 1.45;

// Vite bundles every matcap PNG and hands back hashed URLs (query '?url' is
// the non-deprecated eager-glob form in vite 6).
const urls = import.meta.glob('../assets/matcaps/*.png', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

function url(name: string): string {
  const key = `../assets/matcaps/${name}.png`;
  const u = urls[key];
  if (!u) throw new Error(`matcap asset missing: ${name}`);
  return u;
}

/** Gallery order: Studio first (the default), then Ray's sheets — monochrome
 *  set, then the colored set. */
export const MATCAPS: readonly MatcapEntry[] = [
  { id: 'studio', name: 'Studio', gain: MATCAP_GAIN_PROCEDURAL },
  { id: 'pearl', name: 'Pearl', url: url('pearl'), gain: MATCAP_GAIN_IMAGE },
  { id: 'jet', name: 'Jet', url: url('jet'), gain: MATCAP_GAIN_IMAGE },
  { id: 'slate', name: 'Slate', url: url('slate'), gain: MATCAP_GAIN_IMAGE },
  { id: 'zebra', name: 'Zebra', url: url('zebra'), gain: MATCAP_GAIN_IMAGE },
  { id: 'gold', name: 'Gold', url: url('gold'), gain: MATCAP_GAIN_IMAGE },
  { id: 'chrome', name: 'Chrome', url: url('chrome'), gain: MATCAP_GAIN_IMAGE },
  { id: 'bronze', name: 'Bronze', url: url('bronze'), gain: MATCAP_GAIN_IMAGE },
  { id: 'lava', name: 'Lava', url: url('lava'), gain: MATCAP_GAIN_IMAGE },
  { id: 'ice', name: 'Ice', url: url('ice'), gain: MATCAP_GAIN_IMAGE },
  { id: 'opal', name: 'Opal', url: url('opal'), gain: MATCAP_GAIN_IMAGE },
  { id: 'nebula', name: 'Nebula', url: url('nebula'), gain: MATCAP_GAIN_IMAGE },
  { id: 'circuit', name: 'Circuit', url: url('circuit'), gain: MATCAP_GAIN_IMAGE },
];

/** Entry by id; unknown ids resolve to Studio (stale storage, renamed sets). */
export function matcapById(id: string): MatcapEntry {
  return MATCAPS.find((m) => m.id === id) ?? MATCAPS[0];
}
