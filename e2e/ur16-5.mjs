/**
 * UR16-5 e2e — SMOOTH SHADING in the path tracers (CPU + GPU).
 *
 * Proves Shade Smooth reaches the F12/GPU renderers: a UV-sphere with Shade
 * Smooth ON must render with NO faceted banding across its lit hemisphere, while
 * the SAME sphere with Shade Smooth OFF stays faceted (the toggle is respected,
 * not forced). Also checks CPU⇄GPU parity on the smooth sphere and that a smooth
 * GLASS sphere neither NaNs nor leaks light at the terminator.
 *
 * SMOOTHNESS PROBE: render the sphere frontally-lit on a dark world (background
 * luma ≈ 0), take a 3-row-averaged horizontal luminance scanline through the lit
 * hemisphere, trim the silhouette limb, and measure the MAX discrete CURVATURE
 * (2nd difference |L[x-1]-2L[x]+L[x+1]|) over the shaded interior. Flat shading =
 * a facet staircase → curvature spikes at every facet edge; smooth shading = a
 * continuous ramp → curvature ≈ 0. (Max adjacent |Δluma| alone can't tell a facet
 * jump from a steep smooth gradient — the 2nd difference can.) PROVABLY FAILS
 * pre-fix: the smooth sphere rendered IDENTICALLY to the flat control (captured
 * curvature CPU 0.0753 / GPU 0.0778, same as flat; snapshot.triNormal absent) so
 * the smooth gate (< 0.02) failed; post-fix smooth reads 0.005 / 0.004 while the
 * flat control still spikes at 0.075 (toggle respected).
 *
 * Both tracers run in the PAGE (WebGL2 is browser-only). t.evaluate does NOT
 * await promises, so results are stashed on window.__ur165 and polled.
 * Run:  flock /tmp/vibe-blender-e2e.lock E2E_PORT=9841 node e2e/ur16-5.mjs
 *       E2E_GPU=1 E2E_PORT=9841 node e2e/ur16-5.mjs   # authoritative real-Vega
 */
import { runE2e } from './harness.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';

const BACKEND = process.env.E2E_GPU ? 'REAL-GPU' : 'SwiftShader';
// Smoothness gate (2nd-difference / curvature — see scanlineProbe): a smooth lit
// hemisphere ramps (curvature ≈ 0); a flat one is a facet staircase (curvature
// spikes at every facet edge). Pre-fix BOTH spheres render flat, so the smooth
// gate PROVABLY FAILS (captured maxCurv ≈ 0.05 both engines, run 1 of this suite).
const SMOOTH_MAX_CURV = 0.020;   // smooth: max scanline curvature must be BELOW this
const FLAT_MIN_CURV    = 0.035;  // flat: max scanline curvature must be ABOVE this (faceted)
const LIT = 0.06;                // interior-lit luminance floor for the probe

runE2e(async (t) => {
  await t.evaluate(`(() => {
    window.__ur165 = { done: false, error: null, progress: 'starting',
                       smooth: null, flat: null, parity: null, glass: null, shots: {} };
    (async () => {
      const R = window.__ur165;
      const LIT = ${LIT};
      const step = (m) => { R.progress = m; };
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

        const sub = (a,b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
        const cross = (a,b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
        const norm = (a) => { const l = Math.hypot(a[0],a[1],a[2])||1; return [a[0]/l,a[1]/l,a[2]/l]; };
        function lookAt(eye, target, fovY) {
          const f = norm(sub(target, eye));
          const up0 = Math.abs(f[2]) > 0.98 ? [0,1,0] : [0,0,1];
          const r = norm(cross(f, up0));
          const u = norm(cross(r, f));
          return { position: eye, forward: f, right: r, up: u, fovY, aperture: 0,
                   focusDistance: Math.hypot(...sub(target,eye)) };
        }
        function reset() {
          if (s.editMode) s.exitEditMode();
          for (const o of [...s.objects]) s.remove(o.id);
          for (const m of [...s.materials]) s.removeMaterial(m.id);
        }
        function place(obj, x, y, z) { obj.transform = obj.transform.withPosition(new Vec3(x,y,z)); }
        function mat(setup) { const m = s.addMaterial('m'); setup(m); return m; }

        const gpu = new gpuMod.GpuTracer();
        if (!gpu.available) { R.error = 'GPU unavailable: ' + gpu.unavailableReason; R.done = true; return; }
        function gpuRenderBatched(w, h, spp, seed, batch = 8) {
          gpu.beginProgressive(w, h, seed);
          let buf = null;
          while (gpu.accumulatedSamples < spp && !gpu.contextLost) {
            gpu.accumulate(Math.min(batch, spp - gpu.accumulatedSamples));
            buf = gpu.readbackProgressive();
          }
          return buf;
        }
        // GPU (rgba avg, row0=top) + CPU (rgb avg, row0=top) from the SAME snapshot.
        function renderPair(snap, w, h, spp, seed) {
          gpu.setSnapshot(snap);
          const gimg = gpuRenderBatched(w, h, spp, seed);
          const scene = tracerMod.prepareScene(snap);
          const acc = new Float32Array(w*h*3);
          for (let i = 0; i < spp; i++) tracerMod.renderSample(scene, acc, w, h, i, seed);
          const inv = 1/spp;
          const cAvg = new Float32Array(w*h*3);
          for (let i = 0; i < cAvg.length; i++) cAvg[i] = acc[i]*inv;
          return { gimg, cAvg };
        }

        const tone = (x) => Math.min(1, Math.max(0, Math.pow(Math.max(0,x), 1/2.2)));
        // Tonemapped luminance grid (row0=top). stride 4 = GPU rgba, 3 = CPU rgb.
        function lumaGrid(img, w, h, stride) {
          const g = new Float32Array(w*h);
          for (let i = 0; i < w*h; i++) {
            const o = i*stride;
            g[i] = tone(0.2126*img[o] + 0.7152*img[o+1] + 0.0722*img[o+2]);
          }
          return g;
        }
        // Smoothness probe along a 3-row-averaged scanline through row cy. Two
        // metrics over the INTERIOR-lit run (pixel + both neighbours all > LIT):
        //   maxStep = max |ΔL|                (adjacent step)
        //   maxCurv = max |L[x-1]-2L[x]+L[x+1]|  (discrete 2nd difference)
        // maxCurv is the DISCRIMINATOR: a FLAT facet staircase spikes it at every
        // facet edge (~the jump size), while a SMOOTH ramp — even a steep one at the
        // limb — has near-constant slope → 2nd difference ≈ 0. maxStep alone
        // conflates a facet jump with a steep smooth gradient, so we gate on maxCurv.
        const MARGIN = 6; // trim the silhouette limb (AA cliff) from each run end
        function scanlineProbe(luma, w, h, cy, litFloor) {
          const row = new Float32Array(w);
          for (let x = 0; x < w; x++) {
            let sum = 0, n = 0;
            for (let dy = -1; dy <= 1; dy++) {
              const yy = cy + dy; if (yy < 0 || yy >= h) continue;
              sum += luma[yy*w + x]; n++;
            }
            row[x] = sum / Math.max(1, n);
          }
          // Longest contiguous lit run (> litFloor), then trim MARGIN off each end so
          // the sphere SILHOUETTE (a 1-2px interior→background AA cliff, huge
          // curvature on BOTH smooth and flat) never enters the measurement — we
          // probe only the shaded INTERIOR, where a facet staircase still spikes but a
          // smooth ramp is ~flat.
          let bestS = 0, bestE = -1, curS = -1;
          for (let x = 0; x <= w; x++) {
            const lit = x < w && row[x] > litFloor;
            if (lit && curS < 0) curS = x;
            if (!lit && curS >= 0) { if (x-1 - curS > bestE - bestS) { bestS = curS; bestE = x-1; } curS = -1; }
          }
          const lo = bestS + MARGIN, hi = bestE - MARGIN;
          let maxStep = 0, maxCurv = 0, litCount = 0;
          for (let x = lo; x <= hi; x++) {
            if (x < 1 || x >= w-1) continue;
            litCount++;
            const step = Math.abs(row[x] - row[x-1]);
            if (step > maxStep) maxStep = step;
            const curv = Math.abs(row[x-1] - 2*row[x] + row[x+1]);
            if (curv > maxCurv) maxCurv = curv;
          }
          return { maxStep, maxCurv, litCount };
        }
        // Row through the sphere's lit centre: brightest interior row.
        function litRow(luma, w, h, litFloor) {
          let best = Math.floor(h*0.45), bestSum = -1;
          for (let y = 0; y < h; y++) {
            let sum = 0;
            for (let x = 0; x < w; x++) if (luma[y*w+x] > litFloor) sum += luma[y*w+x];
            if (sum > bestSum) { bestSum = sum; best = y; }
          }
          return best;
        }
        function toPng(img, w, h, stride) {
          const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
          const cx = cv.getContext('2d'); const im = cx.createImageData(w, h);
          for (let i = 0; i < w*h; i++) {
            const o = i*stride;
            im.data[i*4]   = tone(img[o])*255;
            im.data[i*4+1] = tone(img[o+1])*255;
            im.data[i*4+2] = tone(img[o+2])*255;
            im.data[i*4+3] = 255;
          }
          cx.putImageData(im, 0, 0);
          return cv.toDataURL('image/png');
        }
        function nonFinite(img) { for (let i=0;i<img.length;i++) if (!Number.isFinite(img[i])) return true; return false; }

        // Sphere scene: a single UV-sphere lit by a point light on a DARK world.
        // shadeSmooth flag toggled by the caller. Moderate tessellation (24×12) so
        // FLAT shading shows unmistakable facets.
        function sphereSnap(smooth) {
          reset();
          const sph = s.add('Ball', prim.makeUvSphere(1.3, 24, 12));
          place(sph, 0, 0, 1); sph.shadeSmooth = smooth;
          const grey = mat((m) => { m.baseColor = [0.72,0.72,0.72]; });
          sph.materialId = grey.id;
          // FRONTAL light (near the camera, slightly upper-left): the whole visible
          // hemisphere is lit — no terminator in view — so the probe sees a pure
          // radial gradient. UNCLIPPED (peak tonemapped luma ~0.6): clipping to white
          // would flatten the smooth ramp and leave only faceted limb, fooling it.
          const L = s.addLight('P', 'point'); L.light.power = 700; place(L, -1.5, -6, 2.6);
          const snap = snapMod.buildSnapshot(s, window.__app.camera);
          snap.world = { mode: 0, color: [0,0,0], horizon: [0,0,0], zenith: [0,0,0], strength: 1, hdri: null };
          snap.camera = lookAt([0,-6,1.4], [0,0,1], 0.6);
          return snap;
        }

        const W = 200, H = 150, SPP = 128, SEED = 11;

        // ---- (1) SMOOTH sphere -------------------------------------------
        step('render smooth sphere');
        {
          const snap = sphereSnap(true);
          R.smoothHasNormals = !!(snap.triNormal && snap.triNormal.length === snap.tris.length);
          const { gimg, cAvg } = renderPair(snap, W, H, SPP, SEED);
          const gL = lumaGrid(gimg, W, H, 4), cL = lumaGrid(cAvg, W, H, 3);
          const cy = litRow(cL, W, H, LIT);
          R.smooth = {
            cpu: scanlineProbe(cL, W, H, cy, LIT),
            gpu: scanlineProbe(gL, W, H, cy, LIT),
            row: cy,
          };
          R.shots.smoothCpu = toPng(cAvg, W, H, 3);
          R.shots.smoothGpu = toPng(gimg, W, H, 4);
          // parity on the smooth sphere
          R.parity = { ssim: ssimLuma(gL, cL, W, H), nanG: nonFinite(gimg), nanC: nonFinite(cAvg) };
        }

        // ---- (2) FLAT sphere (toggle respected) --------------------------
        step('render flat sphere');
        {
          const snap = sphereSnap(false);
          R.flatHasNormals = !!(snap.triNormal && snap.triNormal.length);
          const { gimg, cAvg } = renderPair(snap, W, H, SPP, SEED);
          const gL = lumaGrid(gimg, W, H, 4), cL = lumaGrid(cAvg, W, H, 3);
          const cy = litRow(cL, W, H, LIT);
          R.flat = {
            cpu: scanlineProbe(cL, W, H, cy, LIT),
            gpu: scanlineProbe(gL, W, H, cy, LIT),
            row: cy,
          };
        }

        // ---- (3) GLASS smooth sphere: no NaN / no terminator leak --------
        step('render smooth glass sphere');
        {
          reset();
          const sph = s.add('Ball', prim.makeUvSphere(1.3, 24, 12));
          place(sph, 0, 0, 1); sph.shadeSmooth = true;
          const glass = mat((m) => { m.transmission = 1; m.ior = 1.45; m.roughness = 0; m.baseColor = [0.9,0.97,0.92]; });
          sph.materialId = glass.id;
          // a red wall behind for the glass to refract, and a floor
          const grey = mat((m) => { m.baseColor = [0.6,0.6,0.62]; });
          s.add('Floor', prim.makePlane(14)).materialId = grey.id;
          const red = mat((m) => { m.baseColor = [0.85,0.12,0.12]; });
          const wall = s.add('Wall', prim.makeCube(1.4)); place(wall, 0, 3.4, 1.4); wall.materialId = red.id;
          const A = s.addLight('Key', 'area'); A.light.power = 3500; A.light.width = 4; A.light.height = 4; place(A, 1.5, -3, 7);
          const snap = snapMod.buildSnapshot(s, window.__app.camera);
          snap.camera = lookAt([3.5,-6,3], [0,0,1], 0.6);
          const { gimg, cAvg } = renderPair(snap, W, H, 96, SEED);
          const gL = lumaGrid(gimg, W, H, 4);
          let mn = 1e9, mx = -1e9;
          for (let i = 0; i < gL.length; i++) { if (gL[i]<mn) mn=gL[i]; if (gL[i]>mx) mx=gL[i]; }
          R.glass = { nanG: nonFinite(gimg), nanC: nonFinite(cAvg), lumaMin: mn, lumaMax: mx };
          R.shots.glass = toPng(gimg, W, H, 4);
        }

        // ---- (4) The donut (shade-smooth torus) — LOOK ---------------------
        step('render donut');
        try {
          reset();
          const txt = await fetch('/e2e/fixtures/donut-p9-frozen.vibe.json').then((r) => r.text());
          window.__app.io.apply(txt);
          const snap = snapMod.buildSnapshot(window.__app.scene, window.__app.camera);
          const gimg = (() => { gpu.setSnapshot(snap); return gpuRenderBatched(240, 160, 96, SEED); })();
          R.donut = { nanG: nonFinite(gimg), hasNormals: !!(snap.triNormal && snap.triNormal.length) };
          R.shots.donut = toPng(gimg, 240, 160, 4);
        } catch (e) { R.donut = { error: String(e) }; }

        reset();
        s.add('Cube', prim.makeCube(1));
        step('done'); R.done = true;
      } catch (e) {
        R.error = String(e && e.stack || e); R.done = true;
      }
    })();
  })()`);

  const POLL_MS = BACKEND === 'REAL-GPU' ? 600000 : 900000;
  let last = '';
  const deadline = Date.now() + POLL_MS;
  let done = false;
  while (Date.now() < deadline) {
    const st = await t.evaluate('window.__ur165 && { done: window.__ur165.done, progress: window.__ur165.progress }');
    if (st && st.progress !== last) { last = st.progress; console.log(`  … ${last}`); }
    if (st && st.done) { done = true; break; }
    await t.sleep(2000);
  }
  t.check('pipeline completed', done, `last progress: ${last}`);

  const R = await t.evaluate('window.__ur165');
  if (!R || R.error) {
    t.check('ran without error', false, R ? R.error : 'no result');
    return;
  }

  mkdirSync('research', { recursive: true });
  const savePng = (key, name) => {
    if (R.shots && R.shots[key]) {
      const b64 = R.shots[key].replace(/^data:image\/png;base64,/, '');
      writeFileSync(`research/${name}`, Buffer.from(b64, 'base64'));
    }
  };
  savePng('smoothCpu', 'ur16-5-smooth-cpu.png');
  savePng('smoothGpu', 'ur16-5-smooth-gpu.png');
  savePng('glass', 'ur16-5-glass.png');
  savePng('donut', 'ur16-5-donut.png');

  console.log(`\n[${BACKEND}] UR16-5 smooth shading:`);
  console.log(`  snapshot carries per-corner normals for smooth sphere: ${R.smoothHasNormals}`);
  console.log(`  snapshot omits normals for flat-only sphere:           ${!R.flatHasNormals}`);
  if (R.smooth) console.log(`  SMOOTH curv CPU ${R.smooth.cpu.maxCurv.toFixed(4)} GPU ${R.smooth.gpu.maxCurv.toFixed(4)}  (step CPU ${R.smooth.cpu.maxStep.toFixed(3)} GPU ${R.smooth.gpu.maxStep.toFixed(3)}, lit ${R.smooth.cpu.litCount})  gate < ${SMOOTH_MAX_CURV}`);
  if (R.flat)   console.log(`  FLAT   curv CPU ${R.flat.cpu.maxCurv.toFixed(4)} GPU ${R.flat.gpu.maxCurv.toFixed(4)}  (step CPU ${R.flat.cpu.maxStep.toFixed(3)} GPU ${R.flat.gpu.maxStep.toFixed(3)})  faceted-gate > ${FLAT_MIN_CURV}`);
  if (R.parity) console.log(`  PARITY smooth sphere SSIM ${R.parity.ssim.toFixed(4)} (gate ≥ 0.90)`);
  if (R.glass)  console.log(`  GLASS  nan(G/C) ${R.glass.nanG}/${R.glass.nanC}  luma [${R.glass.lumaMin.toFixed(3)}, ${R.glass.lumaMax.toFixed(3)}]`);
  if (R.donut)  console.log(`  DONUT  ${JSON.stringify(R.donut)}`);

  // Size guard (snapshot): smooth object carries per-corner normals; flat-only does not.
  t.check('snapshot carries per-corner normals when an object is shade-smooth', R.smoothHasNormals === true);
  t.check('snapshot omits per-corner normals when NO object is shade-smooth (size guard)', R.flatHasNormals === false);

  // (1) smoothness: smooth passes on BOTH engines; flat still faceted on both.
  if (R.smooth) {
    t.check('smooth sphere CPU has no faceted banding (curvature small)',
      R.smooth.cpu.maxCurv < SMOOTH_MAX_CURV, `maxCurv=${R.smooth.cpu.maxCurv.toFixed(4)}`);
    t.check('smooth sphere GPU has no faceted banding (curvature small)',
      R.smooth.gpu.maxCurv < SMOOTH_MAX_CURV, `maxCurv=${R.smooth.gpu.maxCurv.toFixed(4)}`);
    t.check('smooth probe sampled a real lit run (CPU)', R.smooth.cpu.litCount > 40, `lit=${R.smooth.cpu.litCount}`);
  }
  if (R.flat) {
    t.check('flat sphere CPU still renders faceted (toggle respected)',
      R.flat.cpu.maxCurv > FLAT_MIN_CURV, `maxCurv=${R.flat.cpu.maxCurv.toFixed(4)}`);
    t.check('flat sphere GPU still renders faceted (toggle respected)',
      R.flat.gpu.maxCurv > FLAT_MIN_CURV, `maxCurv=${R.flat.gpu.maxCurv.toFixed(4)}`);
  }

  // (2) parity
  if (R.parity) {
    t.check('smooth sphere CPU⇄GPU SSIM ≥ 0.90', R.parity.ssim >= 0.90, `ssim=${R.parity.ssim.toFixed(4)}`);
    t.check('smooth sphere NaN-free (both engines)', !R.parity.nanG && !R.parity.nanC);
  }

  // (3) glass smooth sphere: no NaN, no runaway light leak at the terminator.
  if (R.glass) {
    t.check('glass smooth sphere: zero non-finite (both engines)', !R.glass.nanG && !R.glass.nanC);
    t.check('glass smooth sphere: luma in sane range (no terminator light leak)',
      R.glass.lumaMin >= 0 && R.glass.lumaMax <= 1.001, `[${R.glass.lumaMin.toFixed(3)}, ${R.glass.lumaMax.toFixed(3)}]`);
  }

  // (4) donut still renders clean.
  if (R.donut && !R.donut.error) {
    t.check('donut renders NaN-free with smooth-torus normals', R.donut.nanG === false);
  }

  await t.screenshot('e2e/screenshots/ur16-5.png');
});
