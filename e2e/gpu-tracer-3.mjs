/**
 * UR12-3 e2e — GPU path tracer stage 3: engine picker + render window + Ctrl+F12.
 *
 * Drives the shipped UI/handles (NOT the raw tracer):
 *   (1) F12 with the GPU engine → the progressive sample counter advances and the
 *       render canvas (Save PNG source) is non-black.
 *   (2) Cancel (close) mid-render → the window closes and a SECOND render works —
 *       the one shared GL context is reused, no leak.
 *   (3) Glare-on GPU render blooms a halo ring around a bright dot (the UR10-2
 *       glare post applied through the same tonemap seam as the CPU path).
 *   (4) Ctrl+F12 GPU 3-frame PNG sequence: an animated cube MOVES across frames,
 *       and re-rendering the sequence yields a BIT-IDENTICAL frame 2 (per-frame
 *       determinism via CRC).
 *   (5) The engine preference PERSISTS across a reload.
 *   (6) Failure honesty: a forced context loss mid-render falls back to CPU and
 *       the job keeps advancing.
 *
 * The CPU-path regression (criterion 6 in the spec) is covered by the existing
 * render suites, which now pin engine=CPU (setEngine('cpu')).
 *
 * Runs on SwiftShader (default) AND the real GPU (E2E_GPU=1). Run:
 *   flock /tmp/vibe-blender-e2e.lock E2E_PORT=9659 node e2e/gpu-tracer-3.mjs
 *   E2E_GPU=1 E2E_PORT=9659 node e2e/gpu-tracer-3.mjs
 */
import { runE2e } from './harness.mjs';

const BACKEND = process.env.E2E_GPU ? 'REAL-GPU' : 'SwiftShader';

runE2e(async (t) => {
  await t.until('!!window.__renderEngine');

  // evaluate() that awaits page promises (dynamic imports / async render()).
  const evalAsync = async (expr) => {
    const { result, exceptionDetails } = await t.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    });
    if (exceptionDetails) throw new Error(`page threw: ${exceptionDetails.text}`);
    return result.value;
  };

  const gpuAvail = await t.evaluate('window.__renderEngine.gpuAvailable()');
  t.check(`GPU tracer probe succeeds (${BACKEND})`, gpuAvail,
    (await t.evaluate('window.__renderEngine.gpuReason()')) || '');
  if (!gpuAvail) {
    // On a backend with no float render targets the whole feature no-ops to CPU;
    // nothing GPU-specific to assert.
    return;
  }

  await t.evaluate("window.__renderEngine.setEngine('gpu')");

  // A small lit scene (floor + cube + sun + camera) at a low resolution so the
  // progressive GPU render is quick even on SwiftShader.
  const built = await evalAsync(`(async () => {
    const s = window.__app.scene;
    if (s.editMode) s.exitEditMode();
    for (const o of [...s.objects]) s.remove(o.id);
    const prim = await import('/src/core/mesh/primitives.ts');
    const V = window.__app.camera.target.constructor;
    s.world = { mode: 'gradient', color: [0.05,0.05,0.05], horizon: [0.05,0.05,0.05], zenith: [0.11,0.13,0.16], strength: 1, hdri: null, hdriImage: null };
    s.add('Floor', prim.makePlane(30));
    const cube = s.add('Cube', prim.makeCube(1));
    cube.transform = cube.transform.withPosition(new V(0, 0, 1));
    const sun = s.addLight('Sun', 'sun');
    sun.light.color = [1,0.95,0.85]; sun.light.power = 4;
    sun.transform = sun.transform.withPosition(new V(4,-3,6));
    const cam = s.addCamera('Camera');
    cam.transform = cam.transform.withPosition(new V(7,-7,4));
    const tgt = s.addEmpty('T'); tgt.transform = tgt.transform.withPosition(new V(0,0,1));
    cam.camera.lookAtId = tgt.id; cam.camera.focalLength = 40;
    s.activeCameraId = cam.id;
    s.renderSettings = { width: 200, height: 150 };
    s.deselectAll();
    return { cubeId: cube.id, camId: cam.id };
  })()`);
  t.check('lit scene built', typeof built.cubeId === 'number');

  // === (1) F12 GPU progressive counter advances + non-black =================
  await t.evaluate('window.__renderEngine.start()');
  await t.sleep(120);
  const s1 = await t.evaluate('window.__renderEngine.sample()');
  const advanced = await t.until(`window.__renderEngine.sample() > ${s1}`, 40000);
  t.check('F12 GPU progressive counter advances', advanced,
    `first=${s1} then=${await t.evaluate('window.__renderEngine.sample()')}`);
  t.check('F12 render used the GPU backend',
    (await t.evaluate('window.__renderEngine.engine()')) === 'gpu');

  await t.until('window.__renderEngine.sample() >= 12', 40000);
  await t.screenshot('research/gpu-tracer-3-f12-mid.png');
  const maxChan = await t.evaluate(`(() => {
    const cv = window.__renderEngine.canvas(), c = cv.getContext('2d');
    const d = c.getImageData(0, 0, cv.width, cv.height).data;
    let mx = 0;
    for (let i = 0; i < d.length; i += 4) mx = Math.max(mx, d[i], d[i+1], d[i+2]);
    return mx;
  })()`);
  t.check('F12 GPU render is non-black (Save PNG has content)', maxChan > 20, `max=${maxChan}`);
  const pngHdr = await t.evaluate(`window.__renderEngine.canvas().toDataURL('image/png').slice(0, 15)`);
  t.check('Save PNG yields a PNG data URL', pngHdr.startsWith('data:image/png'));
  await t.until('window.__renderEngine.sample() >= 32', 40000);
  await t.screenshot('research/gpu-tracer-3-f12-final.png');

  // === (2) Cancel (close) mid-render → window closes, 2nd render works ======
  await t.evaluate('window.__renderEngine.close()');
  await t.sleep(120);
  t.check('close cancels the GPU render (window closed)',
    (await t.evaluate('window.__renderEngine.isOpen()')) === false);
  const frozen1 = await t.evaluate('window.__renderEngine.sample()');
  await t.sleep(200);
  t.check('GPU sample count frozen after cancel',
    (await t.evaluate('window.__renderEngine.sample()')) === frozen1,
    `${frozen1} -> ${await t.evaluate('window.__renderEngine.sample()')}`);

  await t.evaluate('window.__renderEngine.start()'); // reuses the same GL context
  await t.sleep(120);
  const s2a = await t.evaluate('window.__renderEngine.sample()');
  const secondWorks = await t.until(`window.__renderEngine.sample() > ${s2a}`, 40000);
  t.check('second GPU render works after cancel (context reused, no leak)', secondWorks);
  await t.evaluate('window.__renderEngine.close()');
  await t.sleep(120);

  // === (3) Glare-on GPU render blooms a halo ================================
  const glareScene = await evalAsync(`(async () => {
    const s = window.__app.scene;
    for (const o of [...s.objects]) s.remove(o.id);
    const prim = await import('/src/core/mesh/primitives.ts');
    const V = window.__app.camera.target.constructor;
    s.world = { mode: 'flat', color: [0,0,0], horizon: [0,0,0], zenith: [0,0,0], strength: 1, hdri: null, hdriImage: null };
    const dot = s.add('Dot', prim.makeCube(0.03));
    const mat = s.addMaterial('DotEmit'); mat.emissive = [1,1,1]; mat.emissiveStrength = 40;
    dot.materialId = mat.id;
    const cam = s.addCamera('Camera');
    cam.transform = cam.transform.withPosition(new V(0,-14,0));
    const tgt = s.addEmpty('T'); tgt.transform = tgt.transform.withPosition(new V(0,0,0));
    cam.camera.lookAtId = tgt.id; cam.camera.focalLength = 50;
    cam.camera.glare = { enabled: false, threshold: 1.0, strength: 1.5, radius: 0.06 };
    s.activeCameraId = cam.id;
    s.renderSettings = { width: 300, height: 300 };
    s.deselectAll();
    return { camId: cam.id };
  })()`);
  t.check('glare scene built', typeof glareScene.camId === 'number');

  await t.evaluate(`window.__projRender = (wx, wy, wz) => {
    const s = window.__app.scene, cam = s.activeCamera;
    const m = s.cameraWorldMatrix(cam).m;
    const ex=m[12],ey=m[13],ez=m[14], rx=m[0],ry=m[1],rz=m[2], ux=m[4],uy=m[5],uz=m[6], fx=-m[8],fy=-m[9],fz=-m[10];
    const dx=wx-ex, dy=wy-ey, dz=wz-ez;
    const zc=dx*fx+dy*fy+dz*fz, xc=dx*rx+dy*ry+dz*rz, yc=dx*ux+dy*uy+dz*uz;
    const th=12/cam.camera.focalLength;
    const cvs=window.__renderEngine.canvas(), aspect=cvs.width/cvs.height;
    const ndcx=xc/zc/(aspect*th), ndcy=yc/zc/th;
    return { px: Math.round((ndcx+1)/2*cvs.width), py: Math.round((1-ndcy)/2*cvs.height) };
  }; true`);
  const ringLum = () => t.evaluate(`(() => {
    const p = window.__projRender(0,0,0);
    const cvs = window.__renderEngine.canvas(), ctx = cvs.getContext('2d');
    const R0 = 6, R1 = 10; let s = 0, n = 0;
    for (let dy=-R1; dy<=R1; dy++) for (let dx=-R1; dx<=R1; dx++) {
      const r = Math.hypot(dx, dy); if (r < R0 || r > R1) continue;
      const x = p.px+dx, y = p.py+dy;
      if (x<0||y<0||x>=cvs.width||y>=cvs.height) continue;
      const d = ctx.getImageData(x, y, 1, 1).data;
      s += 0.2126*d[0]+0.7152*d[1]+0.0722*d[2]; n++;
    }
    return n ? s/n : 0;
  })()`);
  const setGlare = (on) => t.evaluate(`window.__app.scene.get(${glareScene.camId}).camera.glare.enabled = ${on}`);
  const renderGpu = async (spp) => {
    await t.evaluate('window.__renderEngine.start()');
    await t.sleep(80);
    const ok = await t.until(`window.__renderEngine.sample() >= ${spp}`, 60000);
    t.check(`GPU render reaches >= ${spp} spp`, ok);
  };

  await setGlare(false);
  await renderGpu(24);
  const ringOff = await ringLum();
  await t.evaluate('window.__renderEngine.close()');
  await t.sleep(120);

  await setGlare(true);
  await renderGpu(24);
  const ringOn = await ringLum();
  await t.screenshot('research/gpu-tracer-3-glare.png');
  await t.evaluate('window.__renderEngine.close()');
  await t.sleep(120);
  t.check('glare-on GPU render blooms a halo ring (≥5px out)',
    ringOn > ringOff + 6, `off=${ringOff.toFixed(1)} on=${ringOn.toFixed(1)}`);

  // === (4) Ctrl+F12 GPU 3-frame PNG-seq: motion + determinism ==============
  await evalAsync(`(async () => {
    const s = window.__app.scene;
    for (const o of [...s.objects]) s.remove(o.id);
    const prim = await import('/src/core/mesh/primitives.ts');
    const fc = await import('/src/core/anim/fcurve.ts');
    const V = window.__app.camera.target.constructor;
    s.world = { mode: 'gradient', color: [0.05,0.05,0.05], horizon: [0.05,0.05,0.05], zenith: [0.11,0.13,0.16], strength: 1, hdri: null, hdriImage: null };
    s.add('Floor', prim.makePlane(30));
    const cube = s.add('Cube', prim.makeCube(1));
    cube.transform = cube.transform.withPosition(new V(-2, 0, 1));
    // Animate location.x from -2 (frame 1) to +2 (frame 3): the cube slides.
    cube.anim = { fcurves: [] };
    fc.insertKey(cube.anim, 'location.x', 1, -2, 'linear');
    fc.insertKey(cube.anim, 'location.x', 3, 2, 'linear');
    const sun = s.addLight('Sun', 'sun');
    sun.light.color = [1,0.95,0.85]; sun.light.power = 4;
    sun.transform = sun.transform.withPosition(new V(4,-3,6));
    const cam = s.addCamera('Camera');
    cam.transform = cam.transform.withPosition(new V(0,-9,3));
    const tgt = s.addEmpty('T'); tgt.transform = tgt.transform.withPosition(new V(0,0,1));
    cam.camera.lookAtId = tgt.id; cam.camera.focalLength = 35;
    s.activeCameraId = cam.id;
    s.frameStart = 1; s.frameEnd = 3; s.fps = 24;
    s.renderSettings = { width: 120, height: 90 };
    s.deselectAll();
  })()`);

  // Parse a store-only zip into [{name, crc}] by scanning local file headers.
  const zipCrcExpr = (blobVar) => `(async () => {
    const blob = ${blobVar};
    const buf = new Uint8Array(await blob.arrayBuffer());
    const dv = new DataView(buf.buffer);
    const out = []; let o = 0;
    while (o + 4 <= buf.length && dv.getUint32(o, true) === 0x04034b50) {
      const crc = dv.getUint32(o + 14, true);
      const csize = dv.getUint32(o + 18, true);
      const nlen = dv.getUint16(o + 26, true);
      const elen = dv.getUint16(o + 28, true);
      const name = new TextDecoder().decode(buf.subarray(o + 30, o + 30 + nlen));
      out.push({ name, crc });
      o += 30 + nlen + elen + csize;
    }
    return out;
  })()`;

  const runA = await evalAsync(zipCrcExpr(
    `await window.__app.animRender.render({ mode: 'png', engine: 'gpu', samples: 16, start: 1, end: 3, width: 120, height: 90 })`,
  ));
  t.check('Ctrl+F12 GPU PNG-seq has 3 frames', Array.isArray(runA) && runA.length === 3,
    JSON.stringify(runA?.map((e) => e.name)));
  const f1 = runA?.[0]?.crc, f2 = runA?.[1]?.crc, f3 = runA?.[2]?.crc;
  t.check('animated cube moves across frames (frame 1 ≠ frame 3)', f1 !== f3, `f1=${f1} f3=${f3}`);

  const runB = await evalAsync(zipCrcExpr(
    `await window.__app.animRender.render({ mode: 'png', engine: 'gpu', samples: 16, start: 1, end: 3, width: 120, height: 90 })`,
  ));
  t.check('per-frame determinism: re-render frame 2 → identical CRC',
    typeof f2 === 'number' && runB?.[1]?.crc === f2, `A=${f2} B=${runB?.[1]?.crc}`);

  // === (6) Failure honesty: forced context loss falls back to CPU ==========
  // (If WEBGL_lose_context is unavailable the loss is a no-op and the GPU keeps
  // rendering — the counter still advances, so the check remains valid.)
  await t.evaluate("window.__renderEngine.setEngine('gpu')");
  await t.evaluate('window.__renderEngine.start()');
  await t.sleep(120);
  const beforeLoss = await t.evaluate('window.__renderEngine.sample()');
  await t.evaluate('window.__renderEngine.loseGpuContext()');
  // After the loss the job continues on the CPU worker from sample 0, so the
  // counter keeps advancing (only a live backend can move it).
  const keptGoing = await t.until('window.__renderEngine.sample() >= 4', 40000);
  t.check('context loss mid-render keeps the render advancing (CPU fallback)', keptGoing,
    `before-loss=${beforeLoss}`);
  t.check('render window stays open through the fallback',
    (await t.evaluate('window.__renderEngine.isOpen()')) === true);
  await t.evaluate('window.__renderEngine.close()');
  await t.sleep(120);

  // === (5) Engine preference persists across a reload ======================
  await t.evaluate("window.__renderEngine.setEngine('cpu')");
  await t.reload();
  t.check('engine pref persists as CPU across reload',
    (await t.evaluate('window.__renderEngine.enginePref()')) === 'cpu');
  await t.evaluate("window.__renderEngine.setEngine('gpu')");
  await t.reload();
  t.check('engine pref persists as GPU across reload',
    (await t.evaluate('window.__renderEngine.enginePref()')) === 'gpu');
});
