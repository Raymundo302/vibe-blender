import type { Scene } from '../core/scene/Scene';
import type { OrbitCamera } from '../camera/OrbitCamera';
import { RenderWindow } from './renderWindow';
import { buildSnapshot } from './snapshot';
import { getGpuTracer } from './gpu/sharedTracer';
import { viewPrefs, loadViewPrefs, saveViewPrefs, type RenderEngine } from '../render/viewPrefs';
import { adaptBatchPolls, initialRows, rowsForSample } from '../render/viewportRay';

/** Everything the render engine needs from the app shell. */
export interface RenderEngineContext {
  scene: Scene;
  camera: OrbitCamera;
  setStatus: (text: string) => void;
  /** Host element the render-result window mounts into (document.body). */
  host: HTMLElement;
}

/**
 * Wire up the F12 render engine (P8-4, GPU backend UR12-3). F12 toggles a
 * progressive path-traced render of the scene (from the active camera, else the
 * viewport view) in a DOM window. Two backends via the window's Engine select:
 *   - CPU: the original Web Worker tracer (worker.ts) — app stays live while the
 *     worker traces.
 *   - GPU: the shared WebGL2 fragment-shader tracer (gpu/gpuTracer.ts), driven on
 *     the main thread as a progressive rAF loop that accumulates samples and
 *     reads back to the window canvas at a steady ~4 Hz (NOT per sample).
 * While the window is open, Esc closes it (stopPropagation so it doesn't leak
 * into other window-level handlers); F12 always toggles. The engine preference is
 * persisted (viewPrefs); GPU is the default when the context+extensions probe
 * succeeds, else CPU (with the reason shown as the select's tooltip).
 */
/** Controls handed back to the app shell (topbar Render button). */
export interface RenderEngineControls {
  /** Open + start a render, or close the window if it is open (F12 behavior). */
  toggle(): void;
}

/** The render window of the live engine (set by initRenderEngine). */
let activeRenderWindow: RenderWindow | null = null;

/**
 * The last completed F12 render's canvas, or null if nothing has rendered yet.
 * The render window's canvas retains its pixels after the window closes, so the
 * Image Viewer (P13-2) can display the last result at any time. Additive
 * read-only accessor — the engine's behavior is unchanged.
 */
export function getLastRender(): HTMLCanvasElement | null {
  return activeRenderWindow && activeRenderWindow.sample > 0 ? activeRenderWindow.canvas : null;
}

/** Base RNG seed shared by both backends (matches animRender ANIM_SEED_BASE). */
const RENDER_SEED = 0x1234567;
/** Progressive GPU render: per-batch spp CAP when NOT limiting GPU load. Since
 *  the 2026-07-20 pacing pass batches are FENCED (one in flight, sized by real
 *  fence timing via adaptBatchPolls) so the queue can never pile up — the cap
 *  only bounds the adaptation. */
const GPU_BATCH = 16;
/** Limit GPU load (UR16-3): smaller batch cap + an idle frame between batches
 *  (Ray's Vega mouse-stutter guard — guaranteed compositor headroom). */
const GPU_LIMIT_BATCH_MAX = 8;
const GPU_LIMIT_IDLE_GAP = 1;
/** Steady readback cadence (~4 Hz) — blit far less often than we accumulate.
 *  Readbacks are ASYNC (PBO + fence): presented when they land, never blocking. */
const GPU_BLIT_MS = 250;

export function initRenderEngine(ctx: RenderEngineContext): RenderEngineControls {
  const win = new RenderWindow(ctx.host);
  activeRenderWindow = win;
  let worker: Worker | null = null;
  let startTime = 0;
  // Monotonic token: bumping it invalidates any in-flight GPU rAF loop (cancel).
  let gpuToken = 0;
  let gpuRAF = 0;
  /** Largest per-batch spp used in the last GPU render (UR16-3 pacing probe). */
  let gpuLastMaxBatch = 0;

  // Ensure the persisted engine pref is loaded, then probe GPU availability once
  // (constructs the shared tracer / GL context up front so the select tooltip is
  // accurate and later renders reuse the same context).
  loadViewPrefs();
  const probe = getGpuTracer();
  win.setGpuAvailability(probe.available, probe.unavailableReason);
  win.setEngine(viewPrefs.renderEngine);
  win.setSamples(viewPrefs.renderSamples);

  const stopWorker = (): void => {
    if (worker) {
      worker.postMessage({ type: 'stop' });
      worker.terminate();
      worker = null;
    }
  };

  const stopGpu = (): void => {
    gpuToken++; // any pending step() sees a stale token and returns
    if (gpuRAF) { cancelAnimationFrame(gpuRAF); gpuRAF = 0; }
  };

  /** Build the snapshot + apply the window's aperture/focus/glare overrides —
   *  shared by both backends so DoF + Camera Glare behave identically. */
  const prepareSnapshot = () => {
    const snapshot = buildSnapshot(ctx.scene, ctx.camera);
    // DoF (UR10-2 C): the active camera's fStop already seeded camera.aperture.
    // The window's manual aperture overrides only when opened (> 0) — mainly the
    // viewport-view case with no active camera to carry an fStop.
    if (win.aperture > 0) snapshot.camera.aperture = win.aperture;
    // Camera Glare (UR10-2 B): applied identically in the tonemap seam for BOTH
    // backends (the GPU result is read back then routed through the same seam).
    win.glare = ctx.scene.activeCamera?.camera?.glare ?? null;
    win.showAutoFocus(snapshot.camera.focusDistance ?? 5);
    if (win.focusDistance !== null && !snapshot.camera.focusFromObject) {
      snapshot.camera.focusDistance = win.focusDistance;
    }
    return snapshot;
  };

  const openForRender = (): void => {
    win.open();
    win.reset();
    startTime = performance.now();
  };

  // --- CPU backend (Web Worker) ---------------------------------------------
  const startCpuRender = (snapshot = prepareSnapshot()): void => {
    stopWorker();
    const camLabel = ctx.scene.activeCamera ? 'active camera' : 'viewport view';
    ctx.setStatus(`Rendering (CPU · ${camLabel})…`);
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data;
      if (msg && msg.type === 'frame') {
        win.updateFrame(
          msg.accum as Float32Array, msg.sample as number,
          performance.now() - startTime,
          (msg.coverage as Float32Array | undefined) ?? null,
        );
      }
    };
    worker.postMessage({
      type: 'start',
      snapshot,
      width: win.width,
      height: win.height,
      seed: RENDER_SEED,
      maxSamples: win.samples,
    });
  };

  // --- GPU backend (shared WebGL2 tracer, progressive rAF loop) --------------
  /** Convert the GPU's averaged RGBA readback into the summed-RGB accumulation
   *  buffer the render window's tonemap seam expects (updateFrame divides by the
   *  sample count → back to averaged → glare → Reinhard, identical to CPU). */
  const presentGpu = (avg: Float32Array, sampleCount: number, elapsed: number): void => {
    const n = win.width * win.height;
    const rgb = new Float32Array(n * 3);
    // Transparent film (UR16-3): the GPU alpha channel is the coverage FRACTION
    // (hits/samples). Rebuild the summed coverage the tonemap seam wants so it can
    // present straight alpha exactly like the CPU path.
    const transparent = ctx.scene.renderSettings.transparent ?? false;
    const cov = transparent ? new Float32Array(n) : null;
    for (let i = 0; i < n; i++) {
      rgb[i * 3] = avg[i * 4] * sampleCount;
      rgb[i * 3 + 1] = avg[i * 4 + 1] * sampleCount;
      rgb[i * 3 + 2] = avg[i * 4 + 2] * sampleCount;
      if (cov) cov[i] = avg[i * 4 + 3] * sampleCount;
    }
    win.updateFrame(rgb, sampleCount, elapsed, cov);
  };

  const startGpuRender = (snapshot = prepareSnapshot()): void => {
    const tracer = getGpuTracer();
    if (!tracer.available) { startCpuRender(snapshot); return; }
    stopGpu();
    const myToken = ++gpuToken;
    const camLabel = ctx.scene.activeCamera ? 'active camera' : 'viewport view';
    ctx.setStatus(`Rendering (GPU · ${camLabel})…`);
    tracer.setSnapshot(snapshot);
    const w = win.width, h = win.height;
    if (!tracer.beginProgressive(w, h, RENDER_SEED)) { startCpuRender(snapshot); return; }
    let lastBlit = 0;
    const maxSamples = win.samples;
    // Fenced pacing (2026-07-20): ONE batch in flight, sized by real fence
    // timing. The old loop submitted a fixed batch per rAF with no backpressure —
    // the GPU queue grew unboundedly, the compositor starved behind it, and the
    // amdgpu watchdog could kill the context. Limit GPU load → smaller cap + an
    // idle frame between batches.
    const limit = viewPrefs.limitGpuLoad;
    const batchCap = limit ? GPU_LIMIT_BATCH_MAX : GPU_BATCH;
    let batch = limit ? 1 : 4;
    let inFlight = false;
    let idleGap = 0;
    let presentedSamples = 0;
    // Row-slice each sample and keep ONE slice in flight (2026-07-20): the
    // browser's frame pipeline stalls behind the QUEUED TOTAL of GPU work
    // (regardless of job boundaries), and a multi-second monolithic sample can
    // trip the amdgpu watchdog. The tracer's row cursor lets the slice height
    // adapt after EVERY submission; cheap scenes grow to whole-sample batches.
    let unitRows = initialRows(w, h);
    let submitTs = 0;
    let submitN = 0;
    let sampleMsAcc = 0;
    gpuLastMaxBatch = 0;

    const onLost = (): void => {
      stopGpu();
      ctx.setStatus('GPU context lost — falling back to CPU');
      // Continue the job on CPU from sample 0 (failure honesty, UR12-3 §5).
      startCpuRender(snapshot);
    };

    const step = (): void => {
      if (myToken !== gpuToken) return; // superseded / cancelled
      if (tracer.contextLost) { onLost(); return; }
      const now = performance.now();

      // Present a completed async readback, if one landed.
      const buf = tracer.tryReadback();
      if (buf) {
        presentedSamples = tracer.lastReadbackSamples;
        presentGpu(buf, presentedSamples, now - startTime);
      }

      // While the fenced unit executes, yield the WHOLE frame to the rest of
      // the machine (compositor included) — just come back next rAF.
      if (inFlight) {
        if (tracer.batchPending()) { gpuRAF = requestAnimationFrame(step); return; }
        inFlight = false;
        const unitMs = now - submitTs;
        if (unitRows < h) {
          // Growing only at sample boundaries from the whole sample's cost
          // (per-slice growth is unsafe — region costs lie; rowsForSample);
          // shrinking mid-sample is safe and tames the first sample fast.
          sampleMsAcc += unitMs;
          if (unitMs > 90) unitRows = Math.max(1, unitRows >> 1);
          if (tracer.rowCursor === 0) {
            unitRows = rowsForSample(h, sampleMsAcc);
            sampleMsAcc = 0;
          }
        } else {
          batch = adaptBatchPolls(batch, tracer.lastFencePolls, batchCap);
          if (submitN === 1 && unitMs > 90) { unitRows = rowsForSample(h, unitMs); batch = 1; }
        }
        if (limit) idleGap = GPU_LIMIT_IDLE_GAP;
      }

      const done = tracer.rowCursor === 0 && tracer.accumulatedSamples >= maxSamples;
      if (!done) {
        if (idleGap > 0) { idleGap--; gpuRAF = requestAnimationFrame(step); return; }
        // Blit cadence: request the readback on an EMPTY queue and let it drain
        // before submitting more work — getBufferSubData blocks the main thread
        // until everything queued before it completes, so slices piling in
        // behind the readPixels turned the eventual copy into a ~1.4s stall.
        if (now - lastBlit > GPU_BLIT_MS && !tracer.readbackPending
          && tracer.accumulatedSamples > presentedSamples) {
          tracer.requestReadback();
          lastBlit = now;
          gpuRAF = requestAnimationFrame(step);
          return;
        }
        if (tracer.readbackPending) { gpuRAF = requestAnimationFrame(step); return; }
        if (unitRows < h) {
          tracer.accumulateRowsFenced(unitRows);
          submitN = 1;
          if (gpuLastMaxBatch < 1) gpuLastMaxBatch = 1;
        } else {
          const thisBatch = Math.min(batch, maxSamples - tracer.accumulatedSamples);
          if (thisBatch > gpuLastMaxBatch) gpuLastMaxBatch = thisBatch;
          tracer.accumulateFenced(thisBatch, 1);
          submitN = thisBatch;
        }
        if (tracer.contextLost) { onLost(); return; }
        inFlight = true;
        submitTs = now;
        gpuRAF = requestAnimationFrame(step);
        return;
      }

      // Accumulation finished — get the final image out, then stop looping.
      if (presentedSamples >= maxSamples) return;
      if (!tracer.readbackPending) tracer.requestReadback();
      gpuRAF = requestAnimationFrame(step);
    };
    gpuRAF = requestAnimationFrame(step);
  };

  const startRender = (): void => {
    stopWorker();
    stopGpu();
    // Render at the scene's OUTPUT resolution (UR5-5): window + tracer buffers are
    // sized to scene.renderSettings so the output aspect matches the through-camera
    // passepartout frame and what F12 produces is the real frame.
    const rs = ctx.scene.renderSettings;
    win.resize(rs.width, rs.height);
    // Transparent film (UR16-3): show a checker behind the canvas so alpha reads.
    win.setTransparentPreview(rs.transparent ?? false);
    const snapshot = prepareSnapshot();
    openForRender();
    // Pick the backend: honor the pref, but downgrade GPU→CPU when unavailable.
    const tracer = getGpuTracer();
    const engine: RenderEngine =
      viewPrefs.renderEngine === 'gpu' && tracer.available ? 'gpu' : 'cpu';
    win.setEngine(engine);
    if (engine === 'gpu') startGpuRender(snapshot);
    else startCpuRender(snapshot);
  };

  const close = (): void => {
    stopWorker();
    stopGpu();
    win.close();
    ctx.setStatus('Render closed');
  };

  win.onClose = close;
  // Changing aperture / focus distance re-renders from scratch.
  win.onParamsChange = () => { if (win.isOpen) startRender(); };
  // Changing the Engine select persists the pref and re-renders on the new backend.
  win.onEngineChange = () => {
    viewPrefs.renderEngine = win.engine;
    saveViewPrefs();
    if (win.isOpen) startRender();
  };
  // Changing the Samples field persists the pref (Render tab syncs) + re-renders.
  win.onSamplesChange = () => {
    viewPrefs.renderSamples = win.samples;
    saveViewPrefs();
    if (win.isOpen) startRender();
  };

  window.addEventListener('keydown', (e) => {
    if (e.key === 'F12') {
      e.preventDefault();
      if (win.isOpen) close();
      else startRender();
      return;
    }
    if (win.isOpen && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });

  // Debug handle for e2e (mirrors the __app pattern; harmless in production).
  (window as unknown as Record<string, unknown>).__renderEngine = {
    isOpen: () => win.isOpen,
    sample: () => win.sample,
    canvas: () => win.canvas,
    start: startRender,
    close,
    /** Current backend actually in use (reflects availability downgrade). */
    engine: () => win.engine,
    /** Persisted engine preference. */
    enginePref: () => viewPrefs.renderEngine,
    /** True when the GPU tracer probe succeeded. */
    gpuAvailable: () => getGpuTracer().available,
    /** GPU-unavailable reason (null when available). */
    gpuReason: () => getGpuTracer().unavailableReason,
    /** Current F12 samples cap (UR16-3). */
    samples: () => win.samples,
    /** Set + persist the samples cap and re-render if open (Render tab + e2e). */
    setSamples: (n: number) => {
      win.setSamples(n);
      viewPrefs.renderSamples = win.samples;
      saveViewPrefs();
      if (win.isOpen) startRender();
    },
    /** Whether the GPU-load limiter is on (UR16-3 pacing probe). */
    limitGpuLoad: () => viewPrefs.limitGpuLoad,
    /** The per-batch spp cap in effect (limited → small; unlimited → the fixed
     *  batch). e2e asserts this shrinks when Limit GPU load is on. */
    gpuBatchCap: () => (viewPrefs.limitGpuLoad ? GPU_LIMIT_BATCH_MAX : GPU_BATCH),
    /** Largest per-batch spp actually used in the last GPU render (pacing probe). */
    gpuLastMaxBatch: () => gpuLastMaxBatch,
    /** Set + persist the engine pref and re-render if open (used by e2e + the
     *  CPU-path regression suites to pin the backend). */
    setEngine: (e: RenderEngine) => {
      const eng: RenderEngine = e === 'cpu' ? 'cpu' : 'gpu';
      viewPrefs.renderEngine = eng;
      win.setEngine(eng);
      saveViewPrefs();
      if (win.isOpen) startRender();
    },
    /** Force a GPU context loss mid-render (failure-honesty e2e). */
    loseGpuContext: () => getGpuTracer().loseContextForTest(),
    /** Set aperture radius (0 = pinhole) and re-render if open. */
    setAperture: (v: number) => { win.setAperture(v); if (win.isOpen) startRender(); },
    /** Set focus distance (null = auto) and re-render if open. */
    setFocusDistance: (v: number | null) => { win.setFocusDistance(v); if (win.isOpen) startRender(); },
  };

  return { toggle: () => (win.isOpen ? close() : startRender()) };
}
