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

/** RNG seed shared with the F12 render engine (both converge to the same image). */
const RAY_SEED = 0x1234567;
/** Progressive accumulation cap (spp) — a still viewport converges to this. */
const RAY_MAX_SPP = 256;
/** GPU adaptive batch: aim each accumulate() tick under this many ms. */
const GPU_TICK_TARGET_MS = 22;
const GPU_BATCH_MAX = 32;

/**
 * Pure GPU batch-size adapter (UR15-1): given the CURRENT batch and how long the
 * last accumulate() of that batch took, return the next batch — DOUBLE when the
 * tick finished comfortably under half the target, HALVE when it blew the target,
 * else hold. Clamped to [1, maxBatch]. Keeps each still-frame tick responsive
 * (~targetMs) without hard-coding a per-scene sample count.
 */
export function adaptBatch(current: number, elapsedMs: number, targetMs: number, maxBatch: number): number {
  let next = current;
  if (elapsedMs < targetMs * 0.5) next = current * 2;
  else if (elapsedMs > targetMs) next = current >> 1;
  return Math.max(1, Math.min(maxBatch, next));
}

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
  private camKey = 0;
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

    // Build the snapshot for THIS frame, then override the camera with the resolved
    // viewport pose so the traced image aligns with the viewport / overlays. Keep
    // buildSnapshot's aperture/focus (matches F12 for the DoF-camera case).
    const snap = buildSnapshot(scene, orbit);
    const m = rv.view.m;
    snap.camera.position = [rv.eye.x, rv.eye.y, rv.eye.z];
    snap.camera.forward = [-m[2], -m[6], -m[10]];
    snap.camera.right = [m[0], m[4], m[8]];
    snap.camera.up = [m[1], m[5], m[9]];
    snap.camera.fovY = rv.fovY;

    // --- reset detection ---
    const camKey = cameraKey(snap);
    const contentKey = this.contentSignature(snap, scene);
    const cameraChanged = this.active && camKey !== this.camKey;
    const contentChanged = this.active && contentKey !== this.contentKey;
    // Interaction degradation: while the camera moves, half resolution + 1 spp.
    const moving = cameraChanged;
    const tw = moving ? Math.max(1, Math.floor(w / 2)) : w;
    const th = moving ? Math.max(1, Math.floor(h / 2)) : h;
    const engineChanged = engine !== this.lastEngine;
    const resChanged = tw !== this.lastW || th !== this.lastH;
    const needReset = !this.active || cameraChanged || contentChanged || engineChanged || resChanged;

    this.camKey = camKey;
    this.contentKey = contentKey;
    this.active = true;
    this.engine = engine;
    this.currentGlare = this.glareForFrame(scene);

    if (needReset) {
      this.lastW = tw;
      this.lastH = th;
      this.lastEngine = engine;
      this.startAccumulation(engine, snap, tw, th, contentChanged || engineChanged || resChanged);
    }

    // Advance + present (skip work once converged — just keep the last image).
    if (engine === 'gpu') {
      if (!this.converged) this.gpuStep();
      this.presentGpu();
    } else {
      if (!this.converged) this.cpuStep();
      this.presentCpu();
    }
    return this.imageBytes !== null;
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
        gpu.beginProgressive(tw, th, RAY_SEED);
        this.gpuBatch = 1;
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

  private gpuStep(): void {
    const gpu = this.gpu;
    if (!gpu || !gpu.available) return;
    if (gpu.contextLost) { this.gpuDead = true; this.engine = 'cpu'; return; }
    const remaining = RAY_MAX_SPP - gpu.accumulatedSamples;
    if (remaining <= 0) return;
    const batch = Math.min(this.gpuBatch, remaining);
    const t0 = performance.now();
    gpu.accumulate(batch);
    const dt = performance.now() - t0;
    // Adapt the batch to keep each tick responsive (~GPU_TICK_TARGET_MS).
    this.gpuBatch = adaptBatch(this.gpuBatch, dt, GPU_TICK_TARGET_MS, GPU_BATCH_MAX);
    this.spp = gpu.accumulatedSamples;
  }

  private cpuStep(): void {
    if (!this.cpuScene || !this.cpuAccum) return;
    renderSample(this.cpuScene, this.cpuAccum, this.lastW, this.lastH, this.cpuSample, RAY_SEED);
    this.cpuSample++;
    this.spp = this.cpuSample;
  }

  private presentGpu(): void {
    const gpu = this.gpu;
    if (!gpu) return;
    const avg = gpu.readbackProgressive(); // averaged RGBA, row 0 = top
    if (!avg) return;
    const w = this.lastW, h = this.lastH, n = w * h;
    // Averaged RGBA → summed RGB (× spp) so the render-window tonemap seam divides
    // by spp and applies glare on averaged HDR — identical presentation to F12.
    const rgb = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      rgb[i * 3] = avg[i * 4] * this.spp;
      rgb[i * 3 + 1] = avg[i * 4 + 1] * this.spp;
      rgb[i * 3 + 2] = avg[i * 4 + 2] * this.spp;
    }
    this.blit(rgb, this.spp, w, h);
  }

  private presentCpu(): void {
    if (!this.cpuAccum) return;
    this.blit(this.cpuAccum, this.cpuSample, this.lastW, this.lastH);
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

/** Camera pose key — position + basis + fovY + DoF (any change = a view reset). */
function cameraKey(snap: Snapshot): number {
  const c = snap.camera;
  return hashBits(new Float32Array([
    c.position[0], c.position[1], c.position[2],
    c.forward[0], c.forward[1], c.forward[2],
    c.right[0], c.right[1], c.right[2],
    c.up[0], c.up[1], c.up[2],
    c.fovY, c.aperture ?? 0, c.focusDistance ?? 0,
  ]));
}
