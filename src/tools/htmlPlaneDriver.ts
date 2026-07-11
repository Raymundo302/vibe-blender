import type { Scene, SceneObject } from '../core/scene/Scene';
import type { Material } from '../core/scene/objectData';
import { clampHtmlFps } from '../core/scene/objectData';
import { findCurve } from '../core/anim/fcurve';
import { pageTime } from '../core/anim/pageTime';
import { rasterizeHtmlAt, decodeTexImageLinear } from './htmlPlane';

/**
 * HTML-plane playback driver (UR7-1) — re-rasterizes each HTML plane's page as
 * the page clock advances and swaps the result into the plane's material texture
 * in place (the same texDataUrl / texImage seam UR4-4 Live reuses; the Rendered
 * viewport re-uploads on a url change, the tracer reads texImage).
 *
 * Three playback paths, matching the spec:
 *  1. Timeline playing OR scrubbing (scene.frameCurrent changed since last tick):
 *     re-raster at pageTime(frameCurrent). Throttled to html.fps, LATEST wins, and
 *     skipped when pageTime is unchanged (a playing=0 span → identical raster).
 *  2. Free viewport (timeline stopped) with html.playing AND no playing-channel
 *     keys: advance a per-plane WALL CLOCK at real time, re-raster at html.fps
 *     (preview). With keys present, the timeline rules — no wall-clock drift.
 *  3. Ctrl+F12 ({@link prepareFrame}): AWAIT an exact raster at pageTime(frame)
 *     per plane before the animation renderer captures — fully deterministic.
 *
 * Rasterization is async; a per-plane in-flight guard keeps only the newest
 * request (no queue buildup). {@link suspend}/{@link resume} park the live tick
 * while the animation renderer drives frames deterministically.
 */

interface PlaneState {
  /** pageTime seconds most recently committed to a raster (null = never). */
  committed: number | null;
  /** Newest requested pageTime seconds (latest-wins). */
  desired: number | null;
  /** html.scrollY most recently committed to a raster (null = never). */
  committedScroll: number | null;
  /** Newest requested html.scrollY (latest-wins) — the browse-mode wheel. */
  desiredScroll: number;
  /** Free-preview wall clock (seconds), kept in sync with the timeline. */
  wallClock: number;
  inFlight: boolean;
  /** performance.now() when the last raster started (throttle gate). */
  lastRasterAt: number;
}

const EPS = 1e-9;

/**
 * Objects whose page must be re-rasterized on the next tick regardless of the
 * pageTime/scrollY equality skip (UR7-2 C "Re-rasterize" button — e.g. after a
 * web font finished loading and changed the layout). Keyed by object identity,
 * consumed the moment the forced raster fires.
 */
const forced = new WeakSet<SceneObject>();

/** Force a fresh raster of `obj`'s page on the next driver tick. */
export function requestHtmlReraster(obj: SceneObject): void {
  forced.add(obj);
}

export class HtmlPlaneDriver {
  private readonly states = new WeakMap<SceneObject, PlaneState>();
  private lastFrame: number | null = null;
  private lastNow: number | null = null;
  private suspended = false;

  /**
   * @param renderer optional — when present, {@link prepareFrame} also awaits the
   *   GL texture upload so the VIEWPORT engine is deterministic too (not only the
   *   path tracer, which reads texImage). Kept structural to avoid a hard
   *   Renderer import cycle.
   */
  constructor(
    private readonly scene: Scene,
    private readonly renderer?: { ensureMaterialTexture(mat: Material): Promise<void> },
  ) {}

  /** Pause the live tick (the animation renderer drives frames itself). */
  suspend(): void {
    this.suspended = true;
  }

  /** Resume the live tick; the next tick re-syncs from scene.frameCurrent. */
  resume(): void {
    this.suspended = false;
    this.lastFrame = null;
    this.lastNow = null;
  }

  private htmlPlanes(): SceneObject[] {
    // Only kind 'file' planes are re-rasterized here. kind 'url' planes are LIVE
    // portals (ui/htmlPortals.ts) — their `source` is an address, not HTML text,
    // so rasterizing it would just draw an error card. Their paused texture is
    // owned by the portal manager.
    return this.scene.objects.filter((o) => o.html !== undefined && o.html.kind !== 'url');
  }

  private stateFor(obj: SceneObject): PlaneState {
    let st = this.states.get(obj);
    if (!st) {
      st = {
        committed: null, desired: null,
        committedScroll: null, desiredScroll: 0,
        wallClock: 0, inFlight: false, lastRasterAt: -Infinity,
      };
      this.states.set(obj, st);
    }
    return st;
  }

  private hasPlayingKeys(obj: SceneObject): boolean {
    if (!obj.anim) return false;
    const c = findCurve(obj.anim, 'html.playing');
    return !!c && c.keys.length > 0;
  }

  private materialFor(obj: SceneObject): Material | null {
    if (obj.materialId === null) return null;
    const mat = this.scene.getMaterial(obj.materialId);
    return mat && mat.texKind === 'image' ? mat : null;
  }

  /**
   * Frame-loop tick. `nowMs` defaults to performance.now(); pass it explicitly in
   * tests. Detects a frameCurrent change (scrub/playback), advances the free
   * preview clock otherwise, then flushes any due raster per plane.
   */
  tick(nowMs: number = now()): void {
    const scene = this.scene;
    const dt = this.lastNow === null ? 0 : Math.max(0, (nowMs - this.lastNow) / 1000);
    const frameChanged = this.lastFrame !== null && scene.frameCurrent !== this.lastFrame;

    if (!this.suspended) {
      for (const obj of this.htmlPlanes()) {
        const st = this.stateFor(obj);
        // Browse-mode scroll (UR7-2): track html.scrollY every tick so a wheel
        // scroll re-rasters even when the page clock is unchanged (playing=0 span).
        st.desiredScroll = obj.html!.scrollY;
        // Free preview: real-time advance (only when Play is on statically, no
        // keys, timeline stopped, and the frame isn't being scrubbed).
        const freePreview =
          obj.html!.playing && !this.hasPlayingKeys(obj) && !scene.playing &&
          !frameChanged && this.lastFrame !== null;
        if (freePreview) {
          st.wallClock += dt;
          st.desired = st.wallClock;
        } else {
          // Timeline drives (scrub/playback, the initial sync, AND every idle
          // tick so a plane added mid-session — or a scroll — still has a target).
          const t = pageTime(obj, scene.frameCurrent, scene.fps, scene.frameStart);
          st.desired = t;
          st.wallClock = t; // leaving playback later continues from here
        }
      }
    }

    // Flush (retried every tick so a stopped scrub still lands its final pose).
    if (!this.suspended) {
      for (const obj of this.htmlPlanes()) this.flush(obj, nowMs);
    }

    this.lastNow = nowMs;
    this.lastFrame = scene.frameCurrent;
  }

  private flush(obj: SceneObject, nowMs: number): void {
    const st = this.stateFor(obj);
    if (st.desired === null || st.inFlight) return;
    const force = forced.has(obj);
    const timeSame = st.committed !== null && Math.abs(st.desired - st.committed) < EPS;
    const scrollSame = st.committedScroll !== null && st.committedScroll === st.desiredScroll;
    if (!force && timeSame && scrollSame) return;
    const mat = this.materialFor(obj);
    if (!mat) return;
    const minInterval = 1000 / clampHtmlFps(obj.html!.fps);
    if (!force && nowMs - st.lastRasterAt < minInterval) return; // throttled — retried next tick
    forced.delete(obj); // consumed only once we actually raster
    this.raster(obj, st, mat, st.desired, st.desiredScroll, nowMs);
  }

  private raster(obj: SceneObject, st: PlaneState, mat: Material, target: number, scrollY: number, nowMs: number): void {
    st.inFlight = true;
    st.lastRasterAt = nowMs;
    st.committed = target;
    st.committedScroll = scrollY;
    rasterizeHtmlAt(obj.html!.source, target, rasterOptsFor(obj, scrollY))
      .then(async ({ dataUrl }) => {
        mat.texDataUrl = dataUrl; // Rendered viewport re-uploads on url change
        const tex = await decodeTexImageLinear(dataUrl);
        if (tex && mat.texDataUrl === dataUrl) mat.texImage = tex; // F12 / tracer
      })
      .catch(() => { /* keep the last good frame */ })
      .finally(() => {
        st.inFlight = false;
        // A newer target (pageTime or scroll) arrived while rasterizing → chase it.
        const timeSame = st.desired !== null && Math.abs(st.desired - st.committed!) < EPS;
        const scrollSame = st.committedScroll === st.desiredScroll;
        if ((!timeSame || !scrollSame || forced.has(obj)) && st.desired !== null) {
          this.flush(obj, now());
        }
      });
  }

  /**
   * Await an EXACT raster of every HTML plane at pageTime(frame) — the Ctrl+F12
   * path. Updates texDataUrl + texImage (and, when a renderer was supplied, the
   * GL texture) so both the viewport and path-traced engines capture the correct
   * pose. Keeps the live state in sync so resuming doesn't re-raster the same pose.
   */
  async prepareFrame(frame: number): Promise<void> {
    const scene = this.scene;
    for (const obj of this.htmlPlanes()) {
      const mat = this.materialFor(obj);
      if (!mat) continue;
      const t = pageTime(obj, frame, scene.fps, scene.frameStart);
      const { dataUrl } = await rasterizeHtmlAt(obj.html!.source, t, rasterOptsFor(obj, obj.html!.scrollY));
      mat.texDataUrl = dataUrl;
      const tex = await decodeTexImageLinear(dataUrl);
      if (tex) mat.texImage = tex;
      if (this.renderer) await this.renderer.ensureMaterialTexture(mat);
      const st = this.stateFor(obj);
      st.committed = t;
      st.desired = t;
      st.committedScroll = scrollY;
      st.desiredScroll = scrollY;
      st.wallClock = t;
    }
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * Raster options for a re-raster of `obj`'s page (UR8-3). A TRANSPARENT / cropped
 * fragment plane re-rasters from the base 1024×768 with transparent+autoCrop so
 * the crop (and its alpha) reproduce identically — pageW/pageH are the stored crop
 * box, not the raster size, so they must NOT be passed as w/h here. An ordinary
 * (opaque) page re-rasters at pageW×pageH as before.
 */
function rasterOptsFor(obj: SceneObject, scrollY: number): { w?: number; h?: number; scrollY: number; transparent?: boolean; autoCrop?: boolean } {
  const h = obj.html!;
  if (h.autoCrop) return { scrollY, transparent: true, autoCrop: true };
  return { w: h.pageW, h: h.pageH, scrollY, transparent: h.transparent };
}
