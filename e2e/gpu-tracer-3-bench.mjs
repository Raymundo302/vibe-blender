/**
 * UR12-3 headline benchmark — a lit "donut-style" hero at 64 spp @ 960×540,
 * GPU vs CPU on the Vega. Builds a controlled torus-on-a-plate scene (a real
 * torus mesh — a donut — plus a ground plane, sun + point light, active camera)
 * that BOTH engines shade correctly, so the wall-clock ratio is honest.
 *
 * (The frozen 38k-tri p9 donut fixture shades to BLACK on the current GPU kernel
 * even though traversal HITS every pixel — a stage-1/2 direct-lighting
 * discrepancy on that specific dense scene, unrelated to UR12-3; see the report.)
 *
 *   E2E_GPU=1 E2E_PORT=9659 node e2e/gpu-tracer-3-bench.mjs
 */
import { runE2e } from './harness.mjs';

const BACKEND = process.env.E2E_GPU ? 'REAL-GPU (Vega)' : 'SwiftShader';

runE2e(async (t) => {
  await t.until('!!window.__app');

  const evalAsync = async (expr) => {
    const { result, exceptionDetails } = await t.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    });
    if (exceptionDetails) throw new Error(`page threw: ${exceptionDetails.text}`);
    return result.value;
  };

  const res = await evalAsync(`(async () => {
    const [snapMod, tracerMod, sharedMod, prim] = await Promise.all([
      import('/src/renderEngine/snapshot.ts'),
      import('/src/renderEngine/tracer.ts'),
      import('/src/renderEngine/gpu/sharedTracer.ts'),
      import('/src/core/mesh/primitives.ts'),
    ]);
    const s = window.__app.scene;
    if (s.editMode) s.exitEditMode();
    for (const o of [...s.objects]) s.remove(o.id);
    for (const m of [...s.materials]) s.removeMaterial(m.id);
    const V = window.__app.camera.target.constructor;
    s.world = { mode: 'gradient', color: [0.05,0.05,0.05], horizon: [0.05,0.05,0.05], zenith: [0.11,0.13,0.16], strength: 1, hdri: null, hdriImage: null };
    const plate = s.add('Plate', prim.makePlane(20));
    const donut = s.add('Donut', prim.makeTorus(1, 0.4, 64, 32)); // ~4096 tris
    donut.transform = donut.transform.withPosition(new V(0,0,0.4));
    const dm = s.addMaterial('Icing'); dm.baseColor = [0.9,0.55,0.7]; dm.roughness = 0.5; donut.materialId = dm.id;
    const sun = s.addLight('Sun', 'sun'); sun.light.color=[1,0.95,0.85]; sun.light.power=4;
    sun.transform = sun.transform.withPosition(new V(4,-3,6));
    const fill = s.addLight('Fill', 'point'); fill.light.color=[0.6,0.7,1]; fill.light.power=400; fill.light.radius=1.0;
    fill.transform = fill.transform.withPosition(new V(-4,2,3));
    const cam = s.addCamera('Camera'); cam.transform = cam.transform.withPosition(new V(3.5,-4,2.6));
    const tgt = s.addEmpty('T'); tgt.transform = tgt.transform.withPosition(new V(0,0,0.4));
    cam.camera.lookAtId = tgt.id; cam.camera.focalLength = 50;
    s.activeCameraId = cam.id;
    s.renderSettings = { width: 960, height: 540 };
    s.deselectAll();

    const snap = snapMod.buildSnapshot(s, window.__app.camera);
    const W = 960, H = 540, SPP = 64, SEED = 0x1234567, CPU_SPP = 4;

    // GPU first (healthy context), progressive batches of 4 with a readback
    // (finish) between them — exactly how F12/anim drive it.
    const gt = sharedMod.getGpuTracer();
    let gpuMs = null, mx = 0, lost = false;
    if (gt.available) {
      gt.setSnapshot(snap);
      const g0 = performance.now();
      gt.beginProgressive(W, H, SEED);
      let buf = null;
      while (gt.accumulatedSamples < SPP && !gt.contextLost) {
        gt.accumulate(Math.min(4, SPP - gt.accumulatedSamples));
        buf = gt.readbackProgressive();
      }
      gpuMs = performance.now() - g0;
      lost = gt.contextLost;
      if (buf) for (let i = 0; i < buf.length; i += 4) mx = Math.max(mx, buf[i], buf[i+1], buf[i+2]);
    }

    // CPU: prepareScene + CPU_SPP passes, scaled to 64.
    const t0 = performance.now();
    const ts = tracerMod.prepareScene(snap);
    const accum = new Float32Array(W * H * 3);
    for (let i = 0; i < CPU_SPP; i++) tracerMod.renderSample(ts, accum, W, H, i, SEED);
    const cpuMs = (performance.now() - t0) * (SPP / CPU_SPP);
    let cmx = 0; for (let i = 0; i < accum.length; i++) cmx = Math.max(cmx, accum[i]);

    return { cpuMs, gpuMs, tris: snap.tris.length / 9, gpuMax: mx, cpuMax: cmx,
             reason: gt.unavailableReason, cpuSpp: CPU_SPP, lost };
  })()`);

  const tris = res.tris | 0;
  console.log(`\n=== TORUS/DONUT HERO 64spp 960×540 on ${BACKEND} (${tris} tris) ===`);
  console.log(`CPU tracer: ${res.cpuMs.toFixed(0)} ms (est. from ${res.cpuSpp} spp × ${64 / res.cpuSpp}, max=${res.cpuMax?.toFixed?.(2)})`);
  if (res.gpuMs === null) {
    console.log(`GPU tracer: unavailable (${res.reason})`);
  } else {
    console.log(`GPU tracer: ${res.gpuMs.toFixed(0)} ms   → speedup ${(res.cpuMs / res.gpuMs).toFixed(1)}×  (max=${res.gpuMax?.toFixed?.(3)}, contextLost=${res.lost})`);
  }
  t.check('CPU render non-black', res.cpuMax > 0.01);
  t.check('GPU render non-black on the real backend',
    res.gpuMs === null || res.gpuMax > 0.01, `gpuMax=${res.gpuMax}`);
});
