/**
 * UR12-2 e2e — WebGL2 GPU path tracer, stage 2 (full feature parity).
 *
 * For EACH ported feature a scene + probe pair is rendered through BOTH engines
 * from the SAME Snapshot (the shared interface) at 64 spp / 128², and the
 * downsampled 32² tonemapped-luminance mean-abs-diff must be < 0.06 (loose parity
 * — SSIM comes in stage 4). Scenes: cube+point, cube+area (penumbra), emissive
 * panel (indirect), glass sphere (transmission), DoF two-depth, textured donut
 * (UV correctness). Also asserts GPU determinism (same seed → bit-identical) and
 * reports the 64-spp @512² GPU-vs-CPU timing headline.
 *
 * MUST pass on SwiftShader (default) AND the real GPU (E2E_GPU=1). Run:
 *   flock /tmp/vibe-blender-e2e.lock E2E_PORT=9655 node e2e/gpu-tracer-2.mjs
 *   E2E_GPU=1 E2E_PORT=9655 node e2e/gpu-tracer-2.mjs
 *
 * The tracers run in the PAGE (WebGL2 lives in the browser). t.evaluate does NOT
 * await promises, so the async work stashes its result on window.__gpu2 and we
 * poll for it.
 */
import { runE2e } from './harness.mjs';

const BACKEND = process.env.E2E_GPU ? 'REAL-GPU' : 'SwiftShader';
const THRESH = 0.06;

runE2e(async (t) => {
  await t.evaluate(`(() => {
    window.__gpu2 = null;
    (async () => {
      try {
        const [snapMod, tracerMod, gpuMod, prim, vecMod] = await Promise.all([
          import('/src/renderEngine/snapshot.ts'),
          import('/src/renderEngine/tracer.ts'),
          import('/src/renderEngine/gpu/gpuTracer.ts'),
          import('/src/core/mesh/primitives.ts'),
          import('/src/core/math/vec3.ts'),
        ]);
        const Vec3 = vecMod.Vec3;
        const s = window.__app.scene;

        // --- helpers -------------------------------------------------------
        const sub = (a,b) => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
        const cross = (a,b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
        const norm = (a) => { const l = Math.hypot(a[0],a[1],a[2])||1; return [a[0]/l,a[1]/l,a[2]/l]; };
        function lookAt(eye, target, fovY, aperture, focus) {
          const f = norm(sub(target, eye));
          const up0 = Math.abs(f[2]) > 0.98 ? [0,1,0] : [0,0,1];
          const r = norm(cross(f, up0));
          const u = norm(cross(r, f));
          return {
            position: eye, forward: f, right: r, up: u, fovY,
            aperture: aperture || 0,
            focusDistance: focus || Math.hypot(...sub(target,eye)),
          };
        }
        function reset() {
          if (s.editMode) s.exitEditMode();
          for (const o of [...s.objects]) s.remove(o.id);
          for (const m of [...s.materials]) s.removeMaterial(m.id);
        }
        function place(obj, x, y, z) { obj.transform = obj.transform.withPosition(new Vec3(x,y,z)); }
        function mat(setup) { const m = s.addMaterial('m'); setup(m); return m; }

        // Downsample a per-pixel RGB getter to a 32x32 tonemapped-luminance array.
        const tone = (x) => Math.min(1, Math.max(0, Math.pow(Math.max(0,x), 1/2.2)));
        function lum32(get, W, H) {
          const B = 32, sx = W/B, sy = H/B;
          const out = new Float32Array(B*B);
          for (let by = 0; by < B; by++) for (let bx = 0; bx < B; bx++) {
            let acc = 0, n = 0;
            for (let y = 0; y < sy; y++) for (let x = 0; x < sx; x++) {
              const px = bx*sx + x, py = by*sy + y;
              const c = get(px, py);
              acc += 0.2126*tone(c[0]) + 0.7152*tone(c[1]) + 0.0722*tone(c[2]);
              n++;
            }
            out[by*B+bx] = acc/n;
          }
          return out;
        }
        function meanAbsDiff(a, b) {
          let s2 = 0; for (let i = 0; i < a.length; i++) s2 += Math.abs(a[i]-b[i]);
          return s2/a.length;
        }
        function spread(a) { // max-min, to prove the scene isn't trivially flat
          let mn = 1e9, mx = -1e9; for (const v of a) { if (v<mn) mn=v; if (v>mx) mx=v; }
          return mx-mn;
        }

        const gpu = new gpuMod.GpuTracer();
        if (!gpu.available) { window.__gpu2 = { error: 'GPU unavailable: ' + gpu.unavailableReason }; return; }

        const W = 128, H = 128, SPP = 64, SEED = 7;
        // Render a snapshot on both engines; return {gpuGet, cpuGet, gpuRaw}.
        function renderPair(snap) {
          gpu.setSnapshot(snap);
          const gimg = gpu.render(W, H, SPP, SEED, true);   // rgba, rgb averaged, row0=top
          const scene = tracerMod.prepareScene(snap);
          const acc = new Float32Array(W*H*3);
          for (let i = 0; i < SPP; i++) tracerMod.renderSample(scene, acc, W, H, i, SEED);
          const inv = 1/SPP;
          const gpuGet = (x,y) => { const o = (y*W+x)*4; return [gimg[o], gimg[o+1], gimg[o+2]]; };
          const cpuGet = (x,y) => { const o = (y*W+x)*3; return [acc[o]*inv, acc[o+1]*inv, acc[o+2]*inv]; };
          return { gpuGet, cpuGet, gimg };
        }
        function diffOf(snap) {
          const { gpuGet, cpuGet } = renderPair(snap);
          const g = lum32(gpuGet, W, H), c = lum32(cpuGet, W, H);
          return { diff: meanAbsDiff(g, c), spread: spread(c), gpuGet, cpuGet };
        }

        const results = {};
        let compareArea = null, compareGlass = null;

        // === 1. cube + point ==============================================
        // scene1() is reused by the determinism + timing sections below.
        function scene1() {
          reset();
          s.add('Plane', prim.makePlane(12));
          const cube = s.add('Cube', prim.makeCube(1)); place(cube, 0, 0, 1);
          const L = s.addLight('P', 'point'); L.light.power = 1500; place(L, 4, -4, 6);
          const snap = snapMod.buildSnapshot(s, window.__app.camera);
          snap.camera = lookAt([6,-7,5], [0,0,1], 0.6);
          return snap;
        }
        results.cubePoint = (() => { const r = diffOf(scene1()); return { diff: r.diff, spread: r.spread }; })();

        // === 2. cube + area (penumbra) ====================================
        {
          reset();
          s.add('Plane', prim.makePlane(12));
          const cube = s.add('Cube', prim.makeCube(0.8)); place(cube, 0, 0, 0.8);
          const A = s.addLight('A', 'area');
          A.light.power = 2500; A.light.width = 3; A.light.height = 3;
          place(A, 0.6, 0.6, 6); // offset so the cube throws a penumbra onto the plane
          const snap = snapMod.buildSnapshot(s, window.__app.camera);
          snap.camera = lookAt([5,-6,4.5], [0,0,0.4], 0.6);
          const r = diffOf(snap);
          results.cubeArea = { diff: r.diff, spread: r.spread };
          compareArea = { gpuGet: r.gpuGet, cpuGet: r.cpuGet };
        }

        // === 3. emissive panel (indirect) =================================
        {
          reset();
          const gm = mat((m) => { m.baseColor = [0.75,0.75,0.75]; });
          const pl = s.add('Plane', prim.makePlane(12)); pl.materialId = gm.id;
          const cube = s.add('Cube', prim.makeCube(1)); place(cube, 0, 0, 1); cube.materialId = gm.id;
          const em = mat((m) => { m.emissive = [1,0.9,0.7]; m.emissiveStrength = 6; });
          const panel = s.add('Panel', prim.makePlane(4)); place(panel, 0, 0, 6); panel.materialId = em.id;
          const snap = snapMod.buildSnapshot(s, window.__app.camera);
          // Flat black world so the ONLY illumination is the emissive panel (NEE).
          snap.world = { mode: 0, color: [0,0,0], horizon: [0,0,0], zenith: [0,0,0], strength: 1, hdri: null };
          snap.camera = lookAt([6,-7,5], [0,0,1], 0.6);
          const r = diffOf(snap);
          results.emissive = { diff: r.diff, spread: r.spread };
        }

        // === 4. glass sphere (transmission) ===============================
        {
          reset();
          const red = mat((m) => { m.baseColor = [0.8,0.12,0.12]; });
          const pl = s.add('Plane', prim.makePlane(12)); pl.materialId = red.id;
          const glass = mat((m) => { m.transmission = 1; m.ior = 1.45; m.roughness = 0; m.baseColor = [0.85,0.95,0.88]; });
          const sph = s.add('Sphere', prim.makeUvSphere(1.2, 28, 14)); place(sph, 0, 0, 1.4); sph.materialId = glass.id;
          const L = s.addLight('P', 'point'); L.light.power = 2200; place(L, 3, -4, 6);
          const snap = snapMod.buildSnapshot(s, window.__app.camera);
          snap.camera = lookAt([5,-6,3.2], [0,0,1.2], 0.55);
          const r = diffOf(snap);
          results.glass = { diff: r.diff, spread: r.spread };
          compareGlass = { gpuGet: r.gpuGet, cpuGet: r.cpuGet };
        }

        // === 5. DoF two-depth blur ordering ===============================
        {
          reset();
          s.add('Plane', prim.makePlane(20));
          const near = s.add('Near', prim.makeCube(0.7)); place(near, -0.6, 0, 0.7);
          const far  = s.add('Far',  prim.makeCube(0.7)); place(far,   0.6, 7, 0.7);
          const L = s.addLight('P', 'point'); L.light.power = 2500; place(L, 4, -3, 7);
          const snap = snapMod.buildSnapshot(s, window.__app.camera);
          const eye = [-0.6, -8, 1.6], target = [-0.6, 0, 0.7];
          const focus = Math.hypot(...sub(target, eye));   // focus on the NEAR cube
          snap.camera = lookAt(eye, target, 0.6, 0.28, focus); // open aperture → far cube blurs
          const r = diffOf(snap);
          results.dof = { diff: r.diff, spread: r.spread };
        }

        // === 6. textured donut (UV correctness) ===========================
        {
          reset();
          s.add('Plane', prim.makePlane(12));
          const chk = mat((m) => { m.texKind = 'checker'; m.baseColor = [1,1,1]; });
          const donut = s.add('Donut', prim.makeTorus(1.1, 0.42, 48, 16));
          place(donut, 0, 0, 1.2); donut.materialId = chk.id;
          const L = s.addLight('P', 'point'); L.light.power = 1800; place(L, 3, -4, 6);
          const snap = snapMod.buildSnapshot(s, window.__app.camera);
          snap.camera = lookAt([4.5,-5.5,4], [0,0,1.1], 0.6);
          const r = diffOf(snap);
          results.textured = { diff: r.diff, spread: r.spread };
        }

        // === determinism: same seed → bit-identical GPU render ============
        let deterministic = true;
        {
          const snap = scene1();
          gpu.setSnapshot(snap);
          const a = gpu.render(64, 64, 16, 123, true);
          const b = gpu.render(64, 64, 16, 123, true);
          for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { deterministic = false; break; }
        }

        // === headline timing: 64 spp @ 512² GPU vs CPU ====================
        let timing = null;
        {
          const snap = scene1();
          gpu.setSnapshot(snap);
          const TW = 512, TH = 512;
          const g0 = performance.now();
          gpu.render(TW, TH, 64, 1, true);
          const gpuMs = performance.now() - g0;
          // CPU at reduced spp (heavy in JS) then scale to 64 for the estimate.
          const scene = tracerMod.prepareScene(snap);
          const acc = new Float32Array(TW*TH*3);
          const CPU_SPP = 4;
          const c0 = performance.now();
          for (let i = 0; i < CPU_SPP; i++) tracerMod.renderSample(scene, acc, TW, TH, i, 1);
          const cpuMs = (performance.now() - c0) * (64/CPU_SPP);
          timing = { gpuMs, cpuMs, speedup: cpuMs/gpuMs };
        }

        // === eyes-on: GPU|CPU side-by-side for area + glass ===============
        function drawCompare(pairA, labelA, pairB, labelB) {
          const cv = document.createElement('canvas');
          cv.width = W*2 + 12; cv.height = H*2 + 28;
          cv.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;background:#111;image-rendering:pixelated';
          const cx = cv.getContext('2d');
          cx.fillStyle = '#111'; cx.fillRect(0,0,cv.width,cv.height);
          function blit(get, ox, oy) {
            const im = cx.createImageData(W, H);
            for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
              const c = get(x,y); const o = (y*W+x)*4;
              im.data[o]   = Math.round(tone(c[0])*255);
              im.data[o+1] = Math.round(tone(c[1])*255);
              im.data[o+2] = Math.round(tone(c[2])*255);
              im.data[o+3] = 255;
            }
            cx.putImageData(im, ox, oy);
          }
          blit(pairA.gpuGet, 0, 14);  blit(pairA.cpuGet, W+12, 14);
          blit(pairB.gpuGet, 0, H+28); blit(pairB.cpuGet, W+12, H+28);
          cx.fillStyle = '#fff'; cx.font = '11px monospace';
          cx.fillText(labelA+' GPU', 2, 11); cx.fillText(labelA+' CPU', W+14, 11);
          cx.fillText(labelB+' GPU', 2, H+25); cx.fillText(labelB+' CPU', W+14, H+25);
          document.body.appendChild(cv);
        }
        drawCompare(compareArea, 'AREA', compareGlass, 'GLASS');

        window.__gpu2 = { ok: true, results, deterministic, timing };
      } catch (e) {
        window.__gpu2 = { error: String(e && e.stack || e) };
      }
    })();
  })()`);

  const done = await t.until('window.__gpu2 !== null', 180000);
  t.check('stage-2 comparison completed', done);

  const res = await t.evaluate('window.__gpu2');
  if (!res || res.error) {
    t.check('GPU tracer ran without error', false, res ? res.error : 'no result');
    await t.screenshot(`/tmp/gpu-tracer-2-${BACKEND}.png`);
    return;
  }

  const R = res.results;
  const order = [
    ['cube + point',       'cubePoint'],
    ['cube + area',        'cubeArea'],
    ['emissive panel',     'emissive'],
    ['glass sphere',       'glass'],
    ['DoF two-depth',      'dof'],
    ['textured donut',     'textured'],
  ];
  console.log(`\n[${BACKEND}] per-feature 32² luminance mean-abs-diff (64 spp / 128², threshold ${THRESH}):`);
  for (const [label, key] of order) {
    const r = R[key];
    console.log(`  ${label.padEnd(18)} diff ${r.diff.toFixed(4)}   (scene spread ${r.spread.toFixed(3)})`);
  }
  if (res.timing) {
    console.log(`\n[${BACKEND}] 64 spp @512²: GPU ${res.timing.gpuMs.toFixed(0)} ms | ` +
      `CPU ~${res.timing.cpuMs.toFixed(0)} ms (est) | speedup ~${res.timing.speedup.toFixed(1)}×\n`);
  }

  for (const [label, key] of order) {
    const r = R[key];
    t.check(`${label}: diff < ${THRESH}`, r.diff < THRESH, `diff=${r.diff.toFixed(4)}`);
    t.check(`${label}: scene is non-trivial (spread > 0.05)`, r.spread > 0.05, `spread=${r.spread.toFixed(3)}`);
  }
  t.check('GPU render is deterministic (same seed → bit-identical)', res.deterministic === true);

  await t.screenshot(`/tmp/gpu-tracer-2-compare-${BACKEND}.png`);

  // Clean up scene extras.
  await t.evaluate(`(() => {
    const s = window.__app.scene;
    if (s.editMode) s.exitEditMode();
    for (const o of [...s.objects]) if (o.kind !== 'mesh') s.remove(o.id);
  })()`);
});
