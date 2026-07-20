/**
 * UR15-1 — Viewport raytraced rendering driver.
 *
 * When the viewport shading mode is Rendered → Raytraced (shadePrefs.renderedMode
 * === 'ray'), this owns the progressive path-trace accumulation that the Renderer
 * draws as a fullscreen textured quad. Two engines (shadePrefs.rayEngine):
 *   - GPU: its OWN GpuTracer (a second offscreen WebGL2 context — NOT the shared
 *     one the modal F12 render window uses, so a viewport render and an F12 render
 *     can coexist without clobbering each other's accumulation state). Progressive:
 *     begin once, accumulate a small adaptive batch per frame, read back + tonemap.
 *   - CPU: the main-thread tracer (prepareScene + renderSample, exactly what
 *     worker.ts calls), one sample per frame into an owned accumulation buffer.
 *     Runs on SwiftShader in e2e (no GL needed) — slower is fine.
 *
 * ACCUMULATE-WHILE-STATIC with interaction degradation: the accumulation RESETS
 * whenever the camera view/proj changes, the scene content changes (reusing the
 * GPU repack's EXACT geometry/material/light signatures), the world/frame changes,
 * the canvas resizes, or the engine switches. While the camera is MOVING (its key
 * changed this frame) the trace drops to HALF resolution at 1 spp — noisy but live,
 * Blender-like — and the Renderer LINEAR-upscales it; on stillness it switches to
 * full resolution and accumulates to the cap. Missing a reset trigger = a stale
 * ghost image, so the trigger set is deliberately broad.
 *
 * Presentation is a byte buffer (imageBytes, imageW×imageH) the Renderer uploads
 * to a texture in the viewport GL context; this module never touches that context.
 */

import type { Scene } from '../core/scene/Scene';
import type { OrbitCamera } from '../camera/OrbitCamera';
import type { Mat4 } from '../core/math/mat4';
import type { Vec3 } from '../core/math/vec3';
import { buildSnapshot, type Snapshot } from '../renderEngine/snapshot';
import { GpuTracer, geometrySignature, materialsSignature, lightsSignature, hashBits, combine } from '../renderEngine/gpu/gpuTracer';
import { prepareScene, renderSample, type TraceScene } from '../renderEngine/tracer';
import { tonemapAccumToRgba } from '../renderEngine/renderWindow';
import { shadePrefs } from './shadePrefs';
import { viewPrefs } from './viewPrefs';

/** RNG seed shared with the F12 render engine (both converge to the same image). */
const RAY_SEED = 0x1234567;
/** Progressive accumulation cap (spp) — a still viewport converges to this. */
const RAY_MAX_SPP = 256;
/** Fenced-batch caps (2026-07-20 pacing pass — UI smoothness beats convergence
 *  speed, Ray's call). Limit GPU load halves the cap AND doubles the idle gap. */
const GPU_BATCH_MAX = 16;
const GPU_LIMIT_BATCH_MAX = 4;
/** Frames the GPU is left ENTIRELY idle between batches — guaranteed headroom
 *  for the desktop compositor, which shares the iGPU. */
const GPU_IDLE_GAP = 1;
const GPU_LIMIT_IDLE_GAP = 2;
/** Cadence for presenting the accumulating image (async readback each time). */
const PRESENT_MS = 180;

/**
 * Pure poll-count batch adapter (2026-07-20): WebGL submission is async, so
 * wall-clock around accumulate() measures nothing — the fence tells us how many
 * rAF polls the batch actually took on the GPU. Signaled by the very next poll
 * (≤1) → the batch fits inside a frame, grow; 3+ polls → it spans multiple
 * frames, halve. Clamped to [1, maxBatch].
 */
export function adaptBatchPolls(current: number, polls: number, maxBatch: number): number {
  let next = current;
  if (polls <= 1) next = current * 2;
  else if (polls >= 3) next = current >> 1;
  return Math.max(1, Math.min(maxBatch, next));
}

// --- sample band-tiling (2026-07-20) ------------------------------------------
// A heavy scene can cost SECONDS of GPU per fullscreen sample. One draw that
// size is a single unpreemptable GPU job: it can trip the amdgpu watchdog
// (context loss → stranded on the CPU tracer), and — measured on the Vega 7 —
// the browser's WHOLE frame pipeline stalls behind whatever is queued, even
// when the sample is split into many flushed draws submitted together. So each
// sample is tiled into scissored row-bands and the driver keeps exactly ONE
// band in flight (fence-gated), sized to ~BAND_TARGET_MS of GPU.

/** Aim each band at roughly this much GPU time — the worst case the compositor
 *  (and this page's rAF) waits behind the tracer. */
const BAND_TARGET_MS = 45;
const BAND_MIN_MS = 12;
const BANDS_MAX = 256;

/** First-guess band count from the pixel count (~32k px per band) — refined by
 *  adaptStrips() as soon as real fence timings exist. */
export function initialStrips(pixels: number): number {
  return Math.max(1, Math.min(BANDS_MAX, Math.ceil(pixels / 32768)));
}

/** Pure band-count adapter: per-band GPU time over target → split finer;
 *  comfortably under → merge (fewer submissions). Clamped to [1, BANDS_MAX]. */
export function adaptStrips(current: number, perStripMs: number): number {
  let next = current;
  if (perStripMs > BAND_TARGET_MS) next = current * 2;
  else if (perStripMs < BAND_MIN_MS) next = current >> 1;
  return Math.max(1, Math.min(BANDS_MAX, next));
}

/** How often the FULL content signature (a buildSnapshot + hash sweep — ~100ms
 *  on a heavy scene) runs while the viewport is otherwise idle. Edits that the
 *  cheap per-frame keys can't see (direct mutations outside the undo stack)
 *  reset within this window instead of instantly. */
const CONTENT_CHECK_MS = 500;

/** The camera pose the tracer uses, extracted from the resolved viewport view so
 *  the traced image aligns pixel-for-pixel with the depth-primed overlays. */
export interface RayView {
  view: Mat4;
  eye: Vec3;
  fovY: number;
}

type Engine = 'gpu' | 'cpu';

export class ViewportRay {
  /** Own GpuTracer (constructed lazily on first GPU tick). */
  private gpu: GpuTracer | null = null;
  private gpuTried = false;
  private gpuStarted = false;
  private gpuBatch = 1;
  /** Set when the GPU context is lost mid-render — the driver permanently falls
   *  back to CPU (like the F12 engine), so it never spins on a dead context. */
  private gpuDead = false;
  /** Fenced pacing (2026-07-20): one batch in flight, idle-gap frames between
   *  batches, async cadenced readbacks. See gpuStep(). */
  private gpuInFlight = false;
  private idleGap = 0;
  private lastPresentTs = 0;
  private presentedSpp = 0;
  private rgbScratch: Float32Array | null = null;
  /** Band-tiling state: bands per sample (0 = derive from pixel count on the
   *  next accumulation), the cursor of the next band to submit, the band count
   *  locked for the CURRENT sample (strips may only change between samples),
   *  accumulated band time for the sample, and submit bookkeeping. */
  private strips = 0;
  private band = 0;
  private curBands = 1;
  private bandMsAcc = 0;
  private submitTs = 0;
  private submitN = 0;
  /** Moving-camera resolution divisor (2 = half res). Doubles up to 8 when even
   *  a single reduced-res sample is too slow to track the camera. */
  private movingDiv = 2;
  /** Cheap per-frame change keys (2026-07-20): the full buildSnapshot + content
   *  hash sweep costs ~100ms on a heavy scene, so it only runs when one of these
   *  fires or every CONTENT_CHECK_MS. Camera comes from the resolved view (rv),
   *  edits from the undo position (wired by main.ts) + coarse scene fields. */
  private cheapCamK = 0;
  private cheapEditK = 0;
  private lastContentTs = 0;
  private readonly camScratch = new Float32Array(20);
  /** App-level undo position probe (undo isn't reachable from the Scene). */
  undoProbe: (() => number) | null = null;
  /** Bumped on every new presented image — the Renderer only re-uploads the
   *  present texture when this changed (no per-frame texSubImage of a stale
   *  image). */
  imageVersion = 0;
  /** Pacing counters (e2e + tuning probes; monotonic per driver lifetime). */
  readonly stats = { submits: 0, skips: 0, gaps: 0, readbacks: 0, presents: 0 };

  /** CPU main-thread accumulation. */
  private cpuScene: TraceScene | null = null;
  private cpuAccum: Float32Array | null = null;
  private cpuSample = 0;

  /** Current presented image (RGBA bytes, row 0 = top). */
  imageBytes: Uint8ClampedArray | null = null;
  imageW = 0;
  imageH = 0;
  /** Samples accumulated into the current image (exposed on __app for e2e). */
  spp = 0;
  /** Which backend actually ran this frame ('gpu' | 'cpu'), or null before first tick. */
  engine: Engine | null = null;

  /** Reset-detection keys (reused EXACTLY from the GPU repack granularity for
   *  content; camera/world/frame/resolution added on top). */
  private contentKey = 0;
  private lastW = 0;
  private lastH = 0;
  private lastEngine: Engine | null = null;
  /** False when the driver hasn't ticked recently (e.g. mode was switched away);
   *  the next tick forces a reset so re-entering ray mode never shows a ghost. */
  private active = false;

  /** True when the GPU tracer probe succeeded (context + float targets) AND the
   *  context has not been lost this session. */
  get gpuAvailable(): boolean {
    this.ensureGpu();
    return (this.gpu?.available ?? false) && !this.gpuDead;
  }

  /** Reason the GPU tracer is unavailable (null when available). */
  get gpuReason(): string | null {
    this.ensureGpu();
    return this.gpu?.unavailableReason ?? null;
  }

  /** Human label for the viewport chip ("GPU" / "CPU"). */
  get engineLabel(): string {
    return this.engine === 'gpu' ? 'GPU' : 'CPU';
  }

  /** True once the current accumulation has reached the cap. */
  get converged(): boolean {
    return this.spp >= RAY_MAX_SPP;
  }

  private ensureGpu(): void {
    if (this.gpuTried) return;
    this.gpuTried = true;
    try {
      this.gpu = new GpuTracer();
    } catch {
      this.gpu = null;
    }
  }

  /** The Renderer calls this on every non-ray frame so re-entering ray mode
   *  forces a fresh accumulation (covers the mode-switch reset trigger). */
  markInactive(): void {
    this.active = false;
  }

  /**
   * Advance the accumulation one frame and refresh the presented image. `w×h` is
   * the FULL viewport pixel size; while the camera is moving the trace runs at
   * half that and the Renderer upscales. Returns true when a presentable image is
   * available.
   */
  tick(scene: Scene, orbit: OrbitCamera, rv: RayView, w: number, h: number): boolean {
    if (w < 1 || h < 1) return false;

    // Choose the engine (honor the pref; downgrade GPU→CPU when unavailable).
    const wantGpu = shadePrefs.rayEngine === 'gpu' && this.gpuAvailable;
    const engine: Engine = wantGpu ? 'gpu' : 'cpu';
    const now = performance.now();

    // --- cheap per-frame reset detection (2026-07-20) ---
    // The camera key comes straight from the resolved view (exactly what the
    // trace uses); the edit key from the undo position + coarse scene fields.
    // The EXPENSIVE full sweep (buildSnapshot ~100ms on a heavy scene + content
    // hashes) runs only when a cheap key fires, on the CONTENT_CHECK_MS cadence,
    // or when a reset needs the snapshot anyway — an idle converged viewport
    // ticks in microseconds.
    const camK = this.cheapCamKey(rv);
    const editK = this.cheapEditKey(scene);
    const cameraChanged = this.active && camK !== this.cheapCamK;
    const editChanged = this.active && editK !== this.cheapEditK;
    // Interaction degradation: while the camera moves, reduced resolution +
    // 1 spp. The divisor adapts (2→8) so heavy scenes keep tracking the camera.
    const moving = cameraChanged;
    const tw = moving ? Math.max(1, Math.floor(w / this.movingDiv)) : w;
    const th = moving ? Math.max(1, Math.floor(h / this.movingDiv)) : h;
    const engineChanged = engine !== this.lastEngine;
    const resChanged = tw !== this.lastW || th !== this.lastH;
    const contentDue = editChanged || now - this.lastContentTs > CONTENT_CHECK_MS;

    let snap: Snapshot | null = null;
    let contentChanged = false;
    if (!this.active || cameraChanged || engineChanged || resChanged || contentDue) {
      snap = this.buildSnap(scene, orbit, rv);
      if (contentDue || !this.active) {
        const ck = this.contentSignature(snap, scene);
        contentChanged = this.active && ck !== this.contentKey;
        this.contentKey = ck;
        this.lastContentTs = now;
      }
    }
    const needReset = !this.active || cameraChanged || contentChanged || engineChanged || resChanged;

    this.cheapCamK = camK;
    this.cheapEditK = editK;
    this.active = true;
    this.engine = engine;
    this.currentGlare = this.glareForFrame(scene);

    if (needReset && snap) {
      this.lastW = tw;
      this.lastH = th;
      this.lastEngine = engine;
      this.startAccumulation(engine, snap, tw, th, contentChanged || engineChanged || resChanged);
    }

    // Advance + present. GPU still frames run the FENCED pipeline (one bounded
    // batch in flight, idle-gap frames between batches, async readback) so the
    // main thread never blocks and the compositor always gets GPU time. While
    // MOVING the trace is a single half-res sample + small sync readback per
    // frame — bounded by construction, and the image must track the camera.
    if (engine === 'gpu') {
      if (moving) {
        if (!this.converged) this.gpuStepMoving();
      } else {
        this.gpuStep();
        this.presentGpu();
      }
    } else {
      // CPU: once converged, keep the cached image — zero per-frame work.
      if (!this.converged) {
        this.cpuStep();
        this.presentCpu();
      }
    }
    return this.imageBytes !== null;
  }

  /** Build the snapshot + override the camera with the resolved viewport pose so
   *  the traced image aligns with the viewport / overlays. Keeps buildSnapshot's
   *  aperture/focus (matches F12 for the DoF-camera case). Transparent film
   *  (UR16-3) is an F12/Ctrl+F12 OUTPUT setting only — forced off so toggling
   *  the render's transparent flag never blanks the viewport sky. */
  private buildSnap(scene: Scene, orbit: OrbitCamera, rv: RayView): Snapshot {
    const snap = buildSnapshot(scene, orbit);
    snap.transparent = false;
    const m = rv.view.m;
    snap.camera.position = [rv.eye.x, rv.eye.y, rv.eye.z];
    snap.camera.forward = [-m[2], -m[6], -m[10]];
    snap.camera.right = [m[0], m[4], m[8]];
    snap.camera.up = [m[1], m[5], m[9]];
    snap.camera.fovY = rv.fovY;
    return snap;
  }

  /** Per-frame camera key straight from the resolved view (no snapshot). */
  private cheapCamKey(rv: RayView): number {
    const s = this.camScratch;
    const m = rv.view.m;
    for (let i = 0; i < 16; i++) s[i] = m[i];
    s[16] = rv.eye.x;
    s[17] = rv.eye.y;
    s[18] = rv.eye.z;
    s[19] = rv.fovY;
    return hashBits(s);
  }

  /** Per-frame edit key: undo position (all command-based edits) + coarse scene
   *  fields. Direct mutations that bypass the undo stack are caught by the
   *  CONTENT_CHECK_MS full sweep instead. */
  private cheapEditKey(scene: Scene): number {
    let h = combine(scene.objects.length >>> 0, scene.frameCurrent | 0);
    h = combine(h, (scene.activeCamera?.id ?? -1) >>> 0);
    if (this.undoProbe) h = combine(h, this.undoProbe() >>> 0);
    return h >>> 0;
  }

  /** Content signature reusing the GPU repack's EXACT granularity (geometry +
   *  materials + lights), plus world + frame so those edits also reset. */
  private contentSignature(snap: Snapshot, scene: Scene): number {
    let h = combine(geometrySignature(snap), materialsSignature(snap.materials));
    h = combine(h, lightsSignature(snap.lights));
    if (snap.world) {
      const wv = snap.world;
      h = combine(h, hashBits(new Float32Array([
        wv.mode, wv.strength,
        wv.color[0], wv.color[1], wv.color[2],
        wv.horizon[0], wv.horizon[1], wv.horizon[2],
        wv.zenith[0], wv.zenith[1], wv.zenith[2],
        wv.hdri ? 1 : 0,
      ])));
    }
    return combine(h, scene.frameCurrent | 0) >>> 0;
  }

  private glareForFrame(scene: Scene) {
    return scene.activeCamera?.camera?.glare ?? null;
  }

  private startAccumulation(engine: Engine, snap: Snapshot, tw: number, th: number, rebuildContent: boolean): void {
    if (engine === 'gpu') {
      this.ensureGpu();
      const gpu = this.gpu;
      if (gpu && gpu.available) {
        // Incremental after the first upload: a camera-only change re-packs
        // nothing (skips the BVH rebuild); a content change re-packs what changed.
        gpu.setSnapshot(snap, this.gpuStarted);
        this.gpuStarted = true;
        gpu.beginProgressive(tw, th, RAY_SEED); // also aborts stale fences/readbacks
        this.gpuBatch = 1;
        this.gpuInFlight = false;
        this.idleGap = 0;
        this.presentedSpp = 0;
        this.band = 0;
        this.bandMsAcc = 0;
        this.spp = 0;
        return;
      }
      // GPU became unavailable — fall through to CPU.
    }
    // CPU: rebuild the traced scene only when geometry/materials/lights/world
    // changed; a camera-only reset just swaps the camera (no BVH rebuild).
    if (rebuildContent || !this.cpuScene) {
      this.cpuScene = prepareScene(snap);
    } else {
      this.cpuScene.camera = snap.camera;
    }
    this.cpuAccum = new Float32Array(tw * th * 3);
    this.cpuSample = 0;
    this.spp = 0;
  }

  /**
   * Still-frame GPU tick — the fenced band pipeline (2026-07-20):
   *  1. While the in-flight unit executes, this frame does ZERO GPU work (that
   *     slot belongs to the compositor). On completion, adapt sizes from the
   *     REAL submit→signal time (wall-clock around an async submit measures
   *     nothing — that trap produced both the old 22ms "target" that never
   *     regulated anything and the ledger's fantasy ms/spp figures).
   *  2. Kick an ASYNC readback at a low cadence (first image ASAP, then every
   *     PRESENT_MS, one final at convergence) — presentGpu() polls for it.
   *     Readbacks always see the last COMPLETE sample (progSrc), so they are
   *     safe mid-sample.
   *  3. Submit the next unit and fence it. The unit is ONE row-band of a sample
   *     when the scene is heavy (bands sized ~BAND_TARGET_MS), or a small batch
   *     of whole samples when cheap. One unit in flight, ever: bounded GPU
   *     queue → the compositor stays fluid, the amdgpu watchdog never fires,
   *     and rAF (which stalls behind the queued total, not per-job) keeps
   *     ticking.
   */
  private gpuStep(): void {
    const gpu = this.gpu;
    if (!gpu || !gpu.available) return;
    if (gpu.contextLost) { this.gpuDead = true; this.engine = 'cpu'; return; }

    if (this.gpuInFlight) {
      if (gpu.batchPending()) { this.stats.skips++; return; }
      this.gpuInFlight = false;
      const unitMs = performance.now() - this.submitTs;
      if (this.curBands > 1) {
        // One band landed; adapt tiling only at the sample boundary.
        this.bandMsAcc += unitMs;
        this.band = (this.band + 1) % this.curBands;
        if (this.band === 0) {
          this.spp = gpu.accumulatedSamples;
          this.strips = adaptStrips(this.strips, this.bandMsAcc / this.curBands);
          this.bandMsAcc = 0;
        }
      } else {
        this.spp = gpu.accumulatedSamples;
        const cap = viewPrefs.limitGpuLoad ? GPU_LIMIT_BATCH_MAX : GPU_BATCH_MAX;
        this.gpuBatch = adaptBatchPolls(this.gpuBatch, gpu.lastFencePolls, cap);
        this.strips = adaptStrips(this.strips, unitMs / Math.max(1, this.submitN));
      }
      this.idleGap = viewPrefs.limitGpuLoad ? GPU_LIMIT_IDLE_GAP : GPU_IDLE_GAP;
    }

    const now = performance.now();
    if (!gpu.readbackPending && this.spp > this.presentedSpp
      && (this.presentedSpp === 0 || this.converged || now - this.lastPresentTs > PRESENT_MS)) {
      if (gpu.requestReadback()) this.stats.readbacks++;
    }

    if (this.converged) return;
    if (this.idleGap > 0) { this.idleGap--; this.stats.gaps++; return; }
    if (this.band === 0) {
      // Sample boundary — safe to (re)size the tiling and check the cap.
      if (gpu.accumulatedSamples >= RAY_MAX_SPP) return;
      if (!this.strips) this.strips = initialStrips(this.lastW * this.lastH);
      this.curBands = Math.min(this.strips, this.lastH);
    }
    if (this.curBands > 1) {
      gpu.accumulateBandFenced(this.band, this.curBands);
    } else {
      const batch = Math.min(this.gpuBatch, RAY_MAX_SPP - gpu.accumulatedSamples);
      gpu.accumulateFenced(batch, 1);
      this.submitN = batch;
      this.spp = gpu.accumulatedSamples;
    }
    this.gpuInFlight = true;
    this.submitTs = now;
    this.stats.submits++;
  }

  /** Moving-camera GPU tick: the accumulation resets every frame anyway, so run
   *  ONE reduced-res sample and read it back synchronously — the image must
   *  track the camera pose with no latency. The wall time of the whole step
   *  adapts the resolution divisor (2→8) so heavy scenes stay interactive, and
   *  the sample is still strip-tiled so no single GPU job can grow unbounded. */
  private gpuStepMoving(): void {
    const gpu = this.gpu;
    if (!gpu || !gpu.available) return;
    if (gpu.contextLost) { this.gpuDead = true; this.engine = 'cpu'; return; }
    if (!this.strips) this.strips = initialStrips(this.lastW * this.lastH);
    const t0 = performance.now();
    gpu.accumulate(1, this.strips);
    this.spp = gpu.accumulatedSamples;
    const avg = gpu.readbackProgressive(); // sync — bounded by the reduced res
    if (avg) this.presentAvg(avg, this.spp, this.lastW, this.lastH);
    const dt = performance.now() - t0;
    if (dt > 150 && this.movingDiv < 8) this.movingDiv *= 2;
    else if (dt < 40 && this.movingDiv > 2) this.movingDiv = Math.floor(this.movingDiv / 2);
  }

  private cpuStep(): void {
    if (!this.cpuScene || !this.cpuAccum) return;
    renderSample(this.cpuScene, this.cpuAccum, this.lastW, this.lastH, this.cpuSample, RAY_SEED);
    this.cpuSample++;
    this.spp = this.cpuSample;
  }

  /** Poll the async readback; present only when NEW data landed (otherwise the
   *  previously presented image stays — zero per-frame cost once converged). */
  private presentGpu(): void {
    const gpu = this.gpu;
    if (!gpu) return;
    const avg = gpu.tryReadback();
    if (!avg) return;
    this.presentAvg(avg, gpu.lastReadbackSamples, gpu.lastReadbackW, gpu.lastReadbackH);
  }

  /** Averaged RGBA → summed RGB (× spp) so the render-window tonemap seam divides
   *  by spp and applies glare on averaged HDR — identical presentation to F12. */
  private presentAvg(avg: Float32Array, spp: number, w: number, h: number): void {
    if (spp <= 0 || w < 1 || h < 1) return;
    const n = w * h;
    if (!this.rgbScratch || this.rgbScratch.length !== n * 3) this.rgbScratch = new Float32Array(n * 3);
    const rgb = this.rgbScratch;
    for (let i = 0; i < n; i++) {
      rgb[i * 3] = avg[i * 4] * spp;
      rgb[i * 3 + 1] = avg[i * 4 + 1] * spp;
      rgb[i * 3 + 2] = avg[i * 4 + 2] * spp;
    }
    this.blit(rgb, spp, w, h);
    this.presentedSpp = spp;
    this.lastPresentTs = performance.now();
    this.imageVersion++;
    this.stats.presents++;
  }

  private presentCpu(): void {
    if (!this.cpuAccum) return;
    this.blit(this.cpuAccum, this.cpuSample, this.lastW, this.lastH);
    this.presentedSpp = this.cpuSample;
    this.imageVersion++;
    this.stats.presents++;
  }

  /**
   * Synchronous escape hatch (e2e + scripted captures): block until in-flight
   * fenced work lands, then present the CURRENT accumulation. The synchronous
   * tick-loop suites call this after render() so spp/imageBytes read as if the
   * pipeline were synchronous. Production never calls it.
   */
  flushSync(): void {
    const gpu = this.gpu;
    if (this.engine !== 'gpu' || !gpu || !gpu.available || gpu.contextLost) return;
    const t0 = performance.now();
    gpu.finishPending();
    // Mid-sample? Complete the remaining bands synchronously so every
    // tick+flush nets at least one whole sample.
    while (this.band > 0 && !gpu.contextLost) {
      gpu.accumulateBandFenced(this.band, this.curBands);
      this.band = (this.band + 1) % this.curBands;
      gpu.finishPending();
    }
    gpu.tryReadback(); // drain any completed-but-unconsumed async readback
    this.gpuInFlight = false;
    this.idleGap = 0;
    this.bandMsAcc = 0;
    this.spp = gpu.accumulatedSamples;
    // Synchronous callers pay the full cost anyway — adapt from the measured
    // sync time so tick+flush loops merge bands / grow the batch and converge
    // fast (the pre-fence sync behavior).
    if (this.curBands > 1) {
      this.strips = adaptStrips(this.strips, (performance.now() - t0) / this.curBands);
      this.curBands = Math.min(this.strips, Math.max(1, this.lastH));
    } else {
      this.gpuBatch = adaptBatchPolls(this.gpuBatch, 1,
        viewPrefs.limitGpuLoad ? GPU_LIMIT_BATCH_MAX : GPU_BATCH_MAX);
    }
    const avg = gpu.readbackProgressive();
    if (avg) this.presentAvg(avg, this.spp, this.lastW, this.lastH);
  }

  /** Tonemap a summed-radiance buffer (w*h*3) into imageBytes. */
  private blit(accum: Float32Array, sample: number, w: number, h: number): void {
    if (sample <= 0) return;
    if (!this.imageBytes || this.imageW !== w || this.imageH !== h) {
      this.imageBytes = new Uint8ClampedArray(w * h * 4);
      this.imageW = w;
      this.imageH = h;
    }
    tonemapAccumToRgba(accum, sample, this.imageBytes,
      { width: w, height: h, glare: this.currentGlare });
  }

  /** Glare captured per-frame in tick (avoids re-reading the scene each present). */
  private currentGlare: ReturnType<ViewportRay['glareForFrame']> = null;
}
