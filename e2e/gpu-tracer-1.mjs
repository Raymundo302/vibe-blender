/**
 * UR12-1 e2e — WebGL2 GPU path tracer, stage 1 (traversal correctness).
 *
 * Renders the default cube scene through the GLSL kernel headless and asserts:
 *   - the GPU image is non-black and NaN-free,
 *   - the GPU primary-ray hit-mask agrees with the CPU tracer's hit-mask
 *     (renderHitMask on both engines) ≥ 90% on a 64×64 binary mask,
 * then reports the agreement % and a timing (ms for 16 spp at 256²).
 *
 * MUST pass on SwiftShader (default) AND on the real GPU (E2E_GPU=1). Run:
 *   flock /tmp/vibe-blender-e2e.lock node e2e/gpu-tracer-1.mjs
 *   E2E_GPU=1 E2E_PORT=9651 node e2e/gpu-tracer-1.mjs
 *
 * The GPU tracer runs in the PAGE (WebGL2 lives in the browser), driven via a
 * dynamic import of the in-repo modules. t.evaluate does NOT await promises, so
 * the async work stashes its result on window.__gpu1 and we poll for it.
 */
import { runE2e } from './harness.mjs';

const BACKEND = process.env.E2E_GPU ? 'REAL-GPU' : 'SwiftShader';

runE2e(async (t) => {
  // Default cube scene; make sure we're in object mode and drop stray non-mesh
  // objects from prior suites sharing the profile.
  await t.evaluate(`(() => {
    const s = window.__app.scene;
    if (s.editMode) s.exitEditMode();
    for (const o of [...s.objects]) if (o.kind !== 'mesh') s.remove(o.id);
    // A bright point light so lit faces read well above zero.
    const light = s.addLight('Light', 'point');
    light.light.power = 400000;
    const P = light.transform.position;
    light.transform = light.transform.withPosition(new P.constructor(5, 6, 5));
  })()`);

  // Kick off the GPU + CPU comparison in the page.
  await t.evaluate(`(() => {
    window.__gpu1 = null;
    (async () => {
      try {
        const [snapMod, tracerMod, gpuMod] = await Promise.all([
          import('/src/renderEngine/snapshot.ts'),
          import('/src/renderEngine/tracer.ts'),
          import('/src/renderEngine/gpu/gpuTracer.ts'),
        ]);
        const snap = snapMod.buildSnapshot(window.__app.scene, window.__app.camera);
        const scene = tracerMod.prepareScene(snap);

        const gpu = new gpuMod.GpuTracer();
        if (!gpu.available) { window.__gpu1 = { error: 'GPU unavailable: ' + gpu.unavailableReason }; return; }
        gpu.setSnapshot(snap);

        const W = 256, H = 256, SPP = 16;
        // Timing: 16 spp at 256².
        const t0 = performance.now();
        const img = gpu.render(W, H, SPP, 1, true);
        const gpuMs = performance.now() - t0;

        // Non-black + NaN scan over the GPU image.
        let maxLum = 0, nan = false, lit = 0;
        for (let i = 0; i < img.length; i += 4) {
          const r = img[i], g = img[i+1], b = img[i+2];
          if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) nan = true;
          const lum = 0.2126*r + 0.7152*g + 0.0722*b;
          if (lum > maxLum) maxLum = lum;
          if (img[i+3] > 0.5) lit++;
        }

        // 64x64 hit-mask agreement (both engines, same camera).
        const M = 64;
        const cpuMask = tracerMod.renderHitMask(scene, M, M);
        const gpuMask = gpu.renderHitMask(M, M);
        let agree = 0, cpuHits = 0, gpuHits = 0;
        for (let i = 0; i < M*M; i++) {
          if (cpuMask[i] === gpuMask[i]) agree++;
          if (cpuMask[i]) cpuHits++;
          if (gpuMask[i]) gpuHits++;
        }
        const agreePct = 100 * agree / (M*M);

        // --- eyes-on: draw GPU (left) next to a CPU render (right) ---
        const cpuAccum = new Float32Array(W*H*3);
        for (let s = 0; s < SPP; s++) tracerMod.renderSample(scene, cpuAccum, W, H, s, 1);
        const tone = (x) => Math.round(Math.min(1, Math.max(0, Math.pow(x, 1/2.2))) * 255);
        const cv = document.createElement('canvas');
        cv.width = W*2 + 12; cv.height = H;
        cv.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;background:#111;image-rendering:pixelated';
        const cx = cv.getContext('2d');
        cx.fillStyle = '#111'; cx.fillRect(0,0,cv.width,cv.height);
        const gImg = cx.createImageData(W, H);
        for (let i = 0; i < W*H; i++) {
          gImg.data[i*4] = tone(img[i*4]); gImg.data[i*4+1] = tone(img[i*4+1]);
          gImg.data[i*4+2] = tone(img[i*4+2]); gImg.data[i*4+3] = 255;
        }
        cx.putImageData(gImg, 0, 0);
        const cImg = cx.createImageData(W, H);
        for (let i = 0; i < W*H; i++) {
          // cpuAccum is row 0 = top (renderSample), same as GPU img — average.
          cImg.data[i*4] = tone(cpuAccum[i*3]/SPP); cImg.data[i*4+1] = tone(cpuAccum[i*3+1]/SPP);
          cImg.data[i*4+2] = tone(cpuAccum[i*3+2]/SPP); cImg.data[i*4+3] = 255;
        }
        cx.putImageData(cImg, W+12, 0);
        cx.fillStyle = '#fff'; cx.font = '12px monospace';
        cx.fillText('GPU v0', 4, 14); cx.fillText('CPU', W+16, 14);
        document.body.appendChild(cv);

        window.__gpu1 = { ok: true, gpuMs, maxLum, nan, lit, agreePct, cpuHits, gpuHits };
      } catch (e) {
        window.__gpu1 = { error: String(e && e.stack || e) };
      }
    })();
  })()`);

  const done = await t.until('window.__gpu1 !== null', 60000);
  t.check('GPU comparison completed', done);

  const res = await t.evaluate('window.__gpu1');
  if (!res || res.error) {
    t.check('GPU tracer ran without error', false, res ? res.error : 'no result');
    await t.screenshot(`/tmp/gpu-tracer-1-${BACKEND}.png`);
    return;
  }

  console.log(`\n[${BACKEND}] 16spp @256²: ${res.gpuMs.toFixed(1)} ms | ` +
    `hit-mask agreement ${res.agreePct.toFixed(1)}% ` +
    `(CPU hits ${res.cpuHits}, GPU hits ${res.gpuHits}) | maxLum ${res.maxLum.toFixed(3)}\n`);

  t.check('GPU image is NaN-free', res.nan === false);
  t.check('GPU image is non-black (maxLum > 0.02)', res.maxLum > 0.02, `maxLum=${res.maxLum.toFixed(3)}`);
  t.check('GPU actually hit the cube (lit pixels > 0)', res.lit > 0, `lit=${res.lit}`);
  t.check('CPU hit-mask has cube silhouette pixels', res.cpuHits > 0, `cpuHits=${res.cpuHits}`);
  t.check('hit-mask agreement >= 90%', res.agreePct >= 90, `${res.agreePct.toFixed(1)}%`);

  await t.screenshot(`/tmp/gpu-tracer-1-${BACKEND}.png`);

  // Clean up the light we added.
  await t.evaluate(`(() => {
    const s = window.__app.scene;
    for (const o of [...s.objects]) if (o.kind !== 'mesh') s.remove(o.id);
  })()`);
});
