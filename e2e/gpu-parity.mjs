/**
 * UR12-4 e2e — GPU⇄CPU path-tracer PARITY harness + performance ledger.
 *
 * The proof stage for the WebGL2 path tracer (UR12-1..3). For a curated scene
 * list it renders BOTH engines from the SAME Snapshot at 128 spp / 256×144
 * (noise-limited scenes may override via a per-scene `spp` — see donut/emissive),
 * computes SSIM on tonemapped luminance (pure helper src/renderEngine/gpu/ssim.ts,
 * unit-tested), and gates each scene on a per-scene threshold. It also:
 *   • saves an amplified |CPU−GPU| difference image per scene to
 *     research/gpu-parity-<scene>.png (the AO-saga diagnostic habit),
 *   • appends a performance ledger (CPU ms/spp, GPU ms/spp, speedup at 512² and
 *     960×540) for the CURRENT backend to research/GPU-RENDERER.md,
 *   • runs a firefly/NaN sweep: a 1024-spp GPU glass-hero render must have ZERO
 *     non-finite pixels and < 0.01% pixels above 10× the median luminance.
 *
 * Scenes whose feature was documented-out on the GPU in UR12-2 (HDRI world →
 * the kernel falls back to the gradient) are SKIPPED with a visible log line,
 * never silently green.
 *
 * MUST work on SwiftShader (default; slow is fine, crash is not) AND pass the
 * thresholds on the real Vega (E2E_GPU=1 — the authoritative backend). Run:
 *   flock /tmp/vibe-blender-e2e.lock E2E_PORT=9663 node e2e/gpu-parity.mjs
 *   E2E_GPU=1 E2E_PORT=9663 node e2e/gpu-parity.mjs   # writes the real-Vega ledger
 *
 * The tracers run in the PAGE (WebGL2 lives in the browser). t.evaluate does NOT
 * await promises, so the async pipeline stashes results on window.__parity and we
 * poll; it also publishes .progress so a long SwiftShader run is observable.
 */
import { runE2e } from './harness.mjs';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';

const BACKEND = process.env.E2E_GPU ? 'REAL-GPU' : 'SwiftShader';
const W = 256, H = 144, SPP = 128, SEED = 7;

runE2e(async (t) => {
  await t.evaluate(`(() => {
    window.__parity = { done: false, error: null, backend: ${JSON.stringify(BACKEND)},
                        progress: 'starting', scenes: [], ledger: [], firefly: null };
    (async () => {
      const W = ${W}, H = ${H}, SPP = ${SPP}, SEED = ${SEED};
      const P = window.__parity;
      const step = (m) => { P.progress = m; };
      try {
        const [snapMod, tracerMod, gpuMod, prim, vecMod, ssimMod] = await Promise.all([
          import('/src/renderEngine/snapshot.ts'),
          import('/src/renderEngine/tracer.ts'),
          import('/src/renderEngine/gpu/gpuTracer.ts'),
          import('/src/core/mesh/primitives.ts'),
          import('/src/core/math/vec3.ts'),
          import('/src/renderEngine/gpu/ssim.ts'),
        ]);
        const Vec3 = vecMod.Vec3;
        const { ssimLuma, luminanceOf } = ssimMod;
        const s = window.__app.scene;

        // --- camera + scene helpers (mirrors gpu-tracer-2) -----------------
        const sub = (a,b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
        const cross = (a,b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
        const norm = (a) => { const l = Math.hypot(a[0],a[1],a[2])||1; return [a[0]/l,a[1]/l,a[2]/l]; };
        function lookAt(eye, target, fovY, aperture, focus) {
          const f = norm(sub(target, eye));
          const up0 = Math.abs(f[2]) > 0.98 ? [0,1,0] : [0,0,1];
          const r = norm(cross(f, up0));
          const u = norm(cross(r, f));
          return { position: eye, forward: f, right: r, up: u, fovY,
                   aperture: aperture || 0,
                   focusDistance: focus || Math.hypot(...sub(target,eye)) };
        }
        function reset() {
          if (s.editMode) s.exitEditMode();
          for (const o of [...s.objects]) s.remove(o.id);
          for (const m of [...s.materials]) s.removeMaterial(m.id);
        }
        function place(obj, x, y, z) { obj.transform = obj.transform.withPosition(new Vec3(x,y,z)); }
        function mat(setup) { const m = s.addMaterial('m'); setup(m); return m; }

        // --- render one snapshot on both engines → tonemapped luma pair ----
        const gpu = new gpuMod.GpuTracer();
        if (!gpu.available) { P.error = 'GPU unavailable: ' + gpu.unavailableReason; P.done = true; return; }

        // TDR-SAFE GPU render. gpu.render() submits ALL spp passes in ONE unsynced
        // GL batch; on a real GPU a heavy scene×spp (e.g. the 38k-tri donut at 128
        // spp ≈ 27 s of work) blows the amdgpu GFX watchdog (~2 s TDR) → the driver
        // resets mid-render → the accumulation buffer comes back partial or ZEROED
        // (contextLost stays FALSE — ANGLE recovers silently), i.e. the render goes
        // BLACK and later timings read the near-instant crashed call. The app's own
        // F12/anim paths never hit this because they read back (which forces a GL
        // sync/finish) after each small batch, bounding every submission well under
        // the watchdog. We mirror that here: beginProgressive + accumulate(batch) +
        // readbackProgressive() per batch. batch=4 keeps each submission < ~1 s even
        // on the dense donut (≈0.2 s/sample) — comfortably under the TDR window.
        function gpuRenderBatched(w, h, spp, seed, batch = 4) {
          gpu.beginProgressive(w, h, seed);
          let buf = null;
          while (gpu.accumulatedSamples < spp && !gpu.contextLost) {
            gpu.accumulate(Math.min(batch, spp - gpu.accumulatedSamples));
            buf = gpu.readbackProgressive();   // forces a GL sync each batch
          }
          return buf;
        }

        function renderPair(snap, w, h, spp) {
          gpu.setSnapshot(snap);
          const gimg = gpuRenderBatched(w, h, spp, SEED);          // rgba, averaged, row0=top; TDR-safe
          const scene = tracerMod.prepareScene(snap);
          const acc = new Float32Array(w*h*3);
          for (let i = 0; i < spp; i++) tracerMod.renderSample(scene, acc, w, h, i, SEED);
          const inv = 1/spp;
          const gLum = luminanceOf(gimg, w, h, 4);
          // Scale CPU accum to averaged RGB, stride 3.
          const cAvg = new Float32Array(w*h*3);
          for (let i = 0; i < cAvg.length; i++) cAvg[i] = acc[i]*inv;
          const cLum = luminanceOf(cAvg, w, h, 3);
          return { gimg, cAvg, gLum, cLum };
        }
        function spread(a) { let mn=1e9,mx=-1e9; for (const v of a){ if(v<mn)mn=v; if(v>mx)mx=v; } return mx-mn; }

        // Amplified |CPU−GPU| tonemapped diff → PNG data URL (row0=top).
        const tone = (x) => Math.min(1, Math.max(0, Math.pow(Math.max(0,x), 1/2.2)));
        function diffPng(gimg, cAvg, w, h, amp) {
          const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
          const cx = cv.getContext('2d'); const im = cx.createImageData(w, h);
          for (let i = 0; i < w*h; i++) {
            const go = i*4, co = i*3;
            const dr = Math.abs(tone(gimg[go])   - tone(cAvg[co]));
            const dg = Math.abs(tone(gimg[go+1]) - tone(cAvg[co+1]));
            const db = Math.abs(tone(gimg[go+2]) - tone(cAvg[co+2]));
            im.data[go]   = Math.min(255, dr*amp*255);
            im.data[go+1] = Math.min(255, dg*amp*255);
            im.data[go+2] = Math.min(255, db*amp*255);
            im.data[go+3] = 255;
          }
          cx.putImageData(im, 0, 0);
          return cv.toDataURL('image/png');
        }

        // ================= curated parity scenes =========================
        // Each builder returns a Snapshot. thr = SSIM gate; justify documents any
        // loosening. cube/donut are noise-cheap (0.95); firefly-prone scenes 0.90.
        const scenes = [
          { name: 'cube', thr: 0.95, justify: 'clean diffuse geometry, low variance → tight gate',
            build: () => {
              reset();
              s.add('Plane', prim.makePlane(12));
              const cube = s.add('Cube', prim.makeCube(1)); place(cube, 0, 0, 1);
              const L = s.addLight('P', 'point'); L.light.power = 1500; place(L, 4, -4, 6);
              const snap = snapMod.buildSnapshot(s, window.__app.camera);
              snap.camera = lookAt([6,-7,5], [0,0,1], 0.6);
              return snap;
            } },
          { name: 'donut', thr: 0.95, spp: 256, justify: 'frozen P9 fixture, flat materials, own camera. 256 spp because at 128 spp the two engines DECORRELATED noise (mulberry32 vs PCG) alone caps SSIM at ~0.938 — proven NOISE not bias: SSIM rises to ~0.967 at 256 spp (scratch-donut-spp probe)',
            build: async () => {
              reset();
              const txt = await fetch('/e2e/fixtures/donut-p9-frozen.vibe.json').then((r) => r.text());
              window.__app.io.apply(txt);
              // The fixture ships an active Camera framing the donut — use it.
              return snapMod.buildSnapshot(window.__app.scene, window.__app.camera);
            } },
          { name: 'area-penumbra', thr: 0.90, justify: 'soft-shadow MC variance in the penumbra',
            build: () => {
              reset();
              s.add('Plane', prim.makePlane(12));
              const cube = s.add('Cube', prim.makeCube(0.8)); place(cube, 0, 0, 0.8);
              const A = s.addLight('A', 'area');
              A.light.power = 2500; A.light.width = 3; A.light.height = 3;
              place(A, 0.6, 0.6, 6);
              const snap = snapMod.buildSnapshot(s, window.__app.camera);
              snap.camera = lookAt([5,-6,4.5], [0,0,0.4], 0.6);
              return snap;
            } },
          { name: 'emissive-room', thr: 0.90, spp: 256, justify: 'indirect-only emitter NEE = highest variance in the suite. 256 spp: at 128 spp decorrelated noise caps SSIM ~0.894; proven noise (rises 0.894→0.937→0.972 at 128/256/512 spp, scratch-emissive-probe). NOT bias — the emitter-NEE self-occlusion bias was fixed in tracer.ts + kernel.ts sampleEmitters (occlusion maxDist now measured from the offset origin)',
            build: () => {
              reset();
              const gm = mat((m) => { m.baseColor = [0.75,0.75,0.75]; });
              const pl = s.add('Plane', prim.makePlane(12)); pl.materialId = gm.id;
              const cube = s.add('Cube', prim.makeCube(1)); place(cube, 0, 0, 1); cube.materialId = gm.id;
              const em = mat((m) => { m.emissive = [1,0.9,0.7]; m.emissiveStrength = 6; });
              const panel = s.add('Panel', prim.makePlane(4)); place(panel, 0, 0, 6); panel.materialId = em.id;
              const snap = snapMod.buildSnapshot(s, window.__app.camera);
              snap.world = { mode: 0, color: [0,0,0], horizon: [0,0,0], zenith: [0,0,0], strength: 1, hdri: null };
              snap.camera = lookAt([6,-7,5], [0,0,1], 0.6);
              return snap;
            } },
          { name: 'glass-gold-hero', thr: 0.90, justify: 'glass refraction + metal specular → fireflies dominate; SSIM structure term tolerates them, mean-abs would not',
            build: () => {
              reset();
              const grey = mat((m) => { m.baseColor = [0.6,0.6,0.62]; });
              s.add('Plane', prim.makePlane(16)).materialId = grey.id;
              const red = mat((m) => { m.baseColor = [0.8,0.12,0.12]; });
              // A red block behind the spheres for the glass to refract/pick up.
              const wall = s.add('Wall', prim.makeCube(1.4)); wall.materialId = red.id;
              place(wall, 0, 3.2, 1.4);
              const glass = mat((m) => { m.transmission = 1; m.ior = 1.45; m.roughness = 0; m.baseColor = [0.9,0.97,0.92]; });
              const gsph = s.add('Glass', prim.makeUvSphere(1.1, 32, 16)); place(gsph, -1.2, 0, 1.2); gsph.materialId = glass.id;
              const gold = mat((m) => { m.metallic = 1; m.roughness = 0.16; m.baseColor = [1.0,0.76,0.34]; });
              const msph = s.add('Gold', prim.makeUvSphere(1.1, 32, 16)); place(msph, 1.2, 0.4, 1.2); msph.materialId = gold.id;
              const A = s.addLight('Key', 'area'); A.light.power = 4000; A.light.width = 4; A.light.height = 4; place(A, 1.5, -3, 7);
              const snap = snapMod.buildSnapshot(s, window.__app.camera);
              snap.camera = lookAt([4.5,-6,3.4], [0,0,1.1], 0.6);
              return snap;
            } },
          { name: 'dof-two-depth', thr: 0.90, justify: 'lens-blur MC variance on the defocused cube',
            build: () => {
              reset();
              s.add('Plane', prim.makePlane(20));
              const near = s.add('Near', prim.makeCube(0.7)); place(near, -0.6, 0, 0.7);
              const far  = s.add('Far',  prim.makeCube(0.7)); place(far,   0.6, 7, 0.7);
              const L = s.addLight('P', 'point'); L.light.power = 2500; place(L, 4, -3, 7);
              const snap = snapMod.buildSnapshot(s, window.__app.camera);
              const eye = [-0.6, -8, 1.6], target = [-0.6, 0, 0.7];
              const focus = Math.hypot(...sub(target, eye));
              snap.camera = lookAt(eye, target, 0.6, 0.28, focus);
              return snap;
            } },
          // DOCUMENTED-OUT ON THE GPU (UR12-2 kernel header: HDRI world mode 2
          // falls back to the gradient — no env-texture upload). SKIPPED, not
          // green: rendering it would compare the gradient fallback to the CPU's
          // gradient fallback and pass trivially, hiding the missing feature.
          { name: 'hdri-world', skip: true,
            reason: 'GPU HDRI env is documented-out in UR12-2 (kernel falls back to the gradient)' },
        ];

        // Keep a couple of built snapshots for the firefly + ledger sections.
        const built = {};

        for (const sc of scenes) {
          if (sc.skip) { P.scenes.push({ name: sc.name, skipped: true, reason: sc.reason }); continue; }
          step('parity: ' + sc.name);
          const snap = await sc.build();
          built[sc.name] = snap;
          const sceneSpp = sc.spp || SPP;
          const { gimg, cAvg, gLum, cLum } = renderPair(snap, W, H, sceneSpp);
          let nan = false;
          for (let i = 0; i < gimg.length; i++) if (!Number.isFinite(gimg[i])) { nan = true; break; }
          const ssim = ssimLuma(gLum, cLum, W, H);
          const png = diffPng(gimg, cAvg, W, H, 5);
          P.scenes.push({ name: sc.name, skipped: false, thr: sc.thr, spp: sceneSpp, justify: sc.justify,
                          ssim, nan, spread: spread(cLum), diffPng: png });
        }

        // ================= firefly / NaN sweep (glass hero) ===============
        step('firefly sweep (1024 spp)');
        {
          const snap = built['glass-gold-hero'];
          gpu.setSnapshot(snap);
          const fw = 160, fh = 90, fspp = 1024;
          const img = gpuRenderBatched(fw, fh, fspp, 5);  // 1024 spp — MUST batch or the TDR zeroes it
          let nonFinite = 0;
          const lum = new Float32Array(fw*fh);
          for (let i = 0; i < fw*fh; i++) {
            const o = i*4, r = img[o], g = img[o+1], b = img[o+2];
            if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) nonFinite++;
            lum[i] = 0.2126*r + 0.7152*g + 0.0722*b;
          }
          const sorted = Array.from(lum).filter(Number.isFinite).sort((a,b)=>a-b);
          const median = sorted.length ? sorted[Math.floor(sorted.length/2)] : 0;
          const thresh = Math.max(1e-4, median) * 10;
          let above = 0;
          for (let i = 0; i < lum.length; i++) if (Number.isFinite(lum[i]) && lum[i] > thresh) above++;
          P.firefly = { spp: fspp, w: fw, h: fh, nonFinite, median, thresh,
                        above, total: fw*fh, pct: 100*above/(fw*fh) };
        }

        // ================= performance ledger =============================
        // Honest MARGINAL ms/spp for both engines at 512² and 960×540 on the SAME
        // scene+snapshot. Setup is EXCLUDED from every timer: the GPU scene upload
        // (setSnapshot: BVH build + data-texture upload) and the CPU prepareScene
        // (BVH build) both run before the clocks start.
        //
        // GPU per-spp is measured by a TWO-POINT difference — time N2 sample passes
        // and N1 sample passes, then (t(N2)−t(N1))/(N2−N1). Subtraction cancels the
        // per-render() fixed overhead (one readPixels sync + accum-texture alloc +
        // uniform/texture binds) that a single small-spp render divides over its
        // samples — that amortized overhead, not real work, is what made the old
        // GSPP=16 numbers noise (cube timed FASTER at 960×540 than at 512², and the
        // dense donut FASTER than the cube — physically impossible). A warmup render
        // first pays the lazy shader-validate + accum allocation off the clock.
        // CPU per-spp = wall time of a few full renderSample() passes ÷ passes (JS
        // is already JIT-warm from the 128-spp parity section above); path-tracer
        // sample cost is near-constant across samples, so a small count is honest.
        function timeOne(snap, w, h) {
          gpu.setSnapshot(snap);
          const N1 = 16, N2 = 64;
          // TDR-safe batched renders (render() would be watchdog-reset on the dense
          // donut at 960×540 and return a near-instant CRASHED time — the source of
          // the old bogus 0.4 ms/spp / 38770× headline). Each render syncs per batch.
          gpuRenderBatched(w, h, 4, 1);                       // warmup: alloc+validate off-clock
          const a0 = performance.now(); gpuRenderBatched(w, h, N1, 1); const tN1 = performance.now() - a0;
          const b0 = performance.now(); gpuRenderBatched(w, h, N2, 1); const tN2 = performance.now() - b0;
          const gpuMsPerSpp = Math.max(1e-6, (tN2 - tN1) / (N2 - N1));
          const scene = tracerMod.prepareScene(snap);        // CPU setup — NOT timed
          const acc = new Float32Array(w*h*3);
          const CSPP = 2;
          const c0 = performance.now();
          for (let i = 0; i < CSPP; i++) tracerMod.renderSample(scene, acc, w, h, i, 1);
          const cpuMsPerSpp = (performance.now() - c0) / CSPP;
          return { gpuMsPerSpp, cpuMsPerSpp, speedup: cpuMsPerSpp/gpuMsPerSpp };
        }
        const RESES = [[512,512,'512²'], [960,540,'960×540']];
        for (const sc of scenes) {
          if (sc.skip) continue;
          const snap = built[sc.name];
          for (const [rw, rh, label] of RESES) {
            step('ledger: ' + sc.name + ' @ ' + label);
            const r = timeOne(snap, rw, rh);
            P.ledger.push({ name: sc.name, res: label, ...r });
          }
        }

        // Clean up scene extras so we leave the app in a sane state.
        reset();
        s.add('Cube', prim.makeCube(1));
        step('done'); P.done = true;
      } catch (e) {
        P.error = String(e && e.stack || e); P.done = true;
      }
    })();
  })()`);

  // Poll (SwiftShader 128-spp GPU PT over 6 scenes + a 1024-spp sweep is SLOW —
  // "slow is fine, crash is not"). On the real Vega the GPU now does its FULL work
  // batched (TDR-safe) — the dense donut alone is ~27 s at 128 spp and the firefly
  // sweep ~40 s — plus the 128-spp CPU parity renders, so budget generously.
  const POLL_MS = BACKEND === 'REAL-GPU' ? 1200000 : 1800000;
  let last = '';
  const deadline = Date.now() + POLL_MS;
  let done = false;
  while (Date.now() < deadline) {
    const st = await t.evaluate('window.__parity && { done: window.__parity.done, progress: window.__parity.progress }');
    if (st && st.progress !== last) { last = st.progress; console.log(`  … ${last}`); }
    if (st && st.done) { done = true; break; }
    await t.sleep(2000);
  }
  t.check('parity pipeline completed', done, `last progress: ${last}`);

  const res = await t.evaluate('window.__parity');
  if (!res || res.error) {
    t.check('parity ran without error', false, res ? res.error : 'no result');
    await t.screenshot(`/tmp/gpu-parity-${BACKEND}.png`);
    return;
  }

  mkdirSync('research', { recursive: true });

  // --- parity table + per-scene gates + diff PNGs -------------------------
  console.log(`\n[${BACKEND}] GPU⇄CPU parity — SSIM on luminance, ${SPP} spp @ ${W}×${H}:`);
  let worst = null;
  for (const sc of res.scenes) {
    if (sc.skipped) {
      console.log(`  ${sc.name.padEnd(18)} SKIPPED — ${sc.reason}`);
      t.check(`${sc.name}: skipped (documented-out on GPU), not silently green`, true, sc.reason);
      continue;
    }
    console.log(`  ${sc.name.padEnd(18)} SSIM ${sc.ssim.toFixed(4)}  (gate ≥ ${sc.thr}, ${sc.spp ?? SPP} spp, spread ${sc.spread.toFixed(3)}, NaN ${sc.nan})`);
    if (sc.diffPng) {
      const b64 = sc.diffPng.replace(/^data:image\/png;base64,/, '');
      writeFileSync(`research/gpu-parity-${sc.name}.png`, Buffer.from(b64, 'base64'));
    }
    if (!worst || sc.ssim < worst.ssim) worst = sc;
  }
  for (const sc of res.scenes) {
    if (sc.skipped) continue;
    t.check(`${sc.name}: SSIM ≥ ${sc.thr}`, sc.ssim >= sc.thr, `ssim=${sc.ssim.toFixed(4)}`);
    t.check(`${sc.name}: NaN-free`, sc.nan === false);
    t.check(`${sc.name}: scene non-trivial (spread > 0.05)`, sc.spread > 0.05, `spread=${sc.spread.toFixed(3)}`);
  }
  if (worst) console.log(`\n  WORST scene: ${worst.name} (SSIM ${worst.ssim.toFixed(4)}) — see research/gpu-parity-${worst.name}.png`);

  // --- firefly / NaN sweep ------------------------------------------------
  const ff = res.firefly;
  if (ff) {
    console.log(`\n[${BACKEND}] firefly sweep (glass hero, ${ff.spp} spp @ ${ff.w}×${ff.h}): ` +
      `non-finite ${ff.nonFinite}, median-lum ${ff.median.toFixed(4)}, ` +
      `>${(10).toFixed(0)}×median ${ff.above}/${ff.total} (${ff.pct.toFixed(4)}%)`);
    t.check('firefly: zero non-finite pixels', ff.nonFinite === 0, `count=${ff.nonFinite}`);
    t.check('firefly: < 0.01% pixels above 10× median luminance', ff.pct < 0.01, `${ff.pct.toFixed(4)}%`);
  } else {
    t.check('firefly sweep produced a result', false);
  }

  // --- performance ledger → research/GPU-RENDERER.md ----------------------
  writeLedger(BACKEND, res.ledger);
  let headline = null;
  for (const row of res.ledger) if (row.res === '960×540' && row.name === 'donut') headline = row;
  if (!headline) headline = res.ledger.find((r) => r.res === '960×540') || res.ledger[0];
  if (headline) {
    console.log(`\n[${BACKEND}] LEDGER headline (${headline.name} @ ${headline.res}): ` +
      `GPU ${headline.gpuMsPerSpp.toFixed(3)} ms/spp | CPU ${headline.cpuMsPerSpp.toFixed(1)} ms/spp | ` +
      `speedup ~${headline.speedup.toFixed(1)}×`);
    t.check('ledger has real numbers (speedup > 1 on the real GPU)',
      BACKEND !== 'REAL-GPU' || headline.speedup > 1, `speedup=${headline.speedup.toFixed(1)}×`);
  }

  await t.screenshot(`research/gpu-parity-${BACKEND}.png`);
});

/**
 * Append (idempotently, per backend) a ledger table to research/GPU-RENDERER.md.
 * Each backend's block is delimited by HTML-comment markers so a re-run REPLACES
 * its own block rather than piling up duplicates; the other backend's block is
 * left intact, so one file ends up carrying both the real-Vega and SwiftShader
 * timings.
 */
function writeLedger(backend, ledger) {
  const path = 'research/GPU-RENDERER.md';
  const START = `<!-- LEDGER:${backend} START -->`;
  const END = `<!-- LEDGER:${backend} END -->`;
  const now = new Date().toISOString().slice(0, 10);

  const lines = [];
  lines.push(START);
  lines.push(`### Performance ledger — ${backend} (${now})`);
  lines.push('');
  lines.push('ms/spp (lower is better) = honest MARGINAL cost of one path-tracer sample at that resolution/scene, EXCLUDING setup (GPU scene upload / CPU prepareScene). GPU = two-point (t(64)−t(16))/48 to cancel the per-render readback+bind overhead; CPU = wall time of 2 full renderSample passes ÷ 2. speedup = CPU ÷ GPU.');
  lines.push('');
  lines.push('| Scene | Resolution | CPU ms/spp | GPU ms/spp | Speedup |');
  lines.push('|---|---|---:|---:|---:|');
  for (const r of ledger) {
    lines.push(`| ${r.name} | ${r.res} | ${r.cpuMsPerSpp.toFixed(2)} | ${r.gpuMsPerSpp.toFixed(3)} | ${r.speedup.toFixed(1)}× |`);
  }
  lines.push('');
  lines.push(END);
  const block = lines.join('\n');

  let doc;
  if (existsSync(path)) {
    doc = readFileSync(path, 'utf8');
  } else {
    doc = [
      '# GPU path tracer — renderer notes & performance ledger',
      '',
      'WebGL2 fragment-shader path tracer (src/renderEngine/gpu/). The CPU tracer',
      '(src/renderEngine/tracer.ts) is the parity spec. Ledgers below are written by',
      'e2e/gpu-parity.mjs — run it with E2E_GPU=1 for the authoritative real-Vega',
      'numbers, and on SwiftShader for the sanity/portability timings.',
      '',
    ].join('\n');
  }

  const re = new RegExp(`${escapeRe(START)}[\\s\\S]*?${escapeRe(END)}\\n?`);
  if (re.test(doc)) {
    doc = doc.replace(re, block + '\n');
  } else {
    doc = doc.replace(/\s*$/, '\n\n') + block + '\n';
  }
  writeFileSync(path, doc);
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
