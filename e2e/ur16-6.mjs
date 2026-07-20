/**
 * UR16-6 — Per-texel PNG alpha in the tracers + always-textured modes.
 *
 * Ray's bug: a PNG with transparent texels (a cropped bouncy-ball fragment)
 * placed in front of a green cube rendered its transparent corners BLACK instead
 * of letting the ray pass through to the cube.
 *
 * Scene: an EMISSIVE-GREEN cube at the origin + an EMIT image plane in front of
 * it whose texture is an opaque YELLOW disc with TRANSPARENT corners. A single
 * camera (top-ish) is shared by every renderer (buildSnapshot reads app.camera).
 *
 * Probes (all six shading paths the task names):
 *   - F12-CPU tracer, F12-GPU tracer (offscreen snapshot render):
 *       corner ray → GREEN (cube shows through), NOT black; centre → YELLOW.
 *   - Raytraced viewport (GPU): same green corner / yellow centre on the canvas.
 *   - matcap / studio / wireframe (Always-Textured blended path): the transparent
 *       corner reads the SAME as the cube-alone baseline (plane hidden) — i.e. the
 *       cube shows through — while the opaque centre reads the plane's yellow.
 *
 * Also asserts suspect 2 directly: a plain Image ▸ Emit pick of a PNG that
 * carries alpha auto-enables material.alphaBlend at decode.
 *
 * Run on the real GPU with E2E_GPU=1 to exercise the image atlas + kernel cutout;
 * SwiftShader passes too (RGBA8 atlas is backend-agnostic).
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  await t.key('Escape', 'Escape', 0);

  // ---- modules + a transparent-corner test PNG (opaque yellow disc) ------------
  await t.evaluate(`window.__M = null; (async () => {
    const [ip, snap, tracer, gpu, prim, vec] = await Promise.all([
      import('/src/tools/imagePlane.ts'), import('/src/renderEngine/snapshot.ts'),
      import('/src/renderEngine/tracer.ts'), import('/src/renderEngine/gpu/gpuTracer.ts'),
      import('/src/core/mesh/primitives.ts'), import('/src/core/math/vec3.ts'),
    ]);
    const cvs = document.createElement('canvas'); cvs.width = 64; cvs.height = 64;
    const cx = cvs.getContext('2d');
    cx.clearRect(0, 0, 64, 64);                       // fully transparent → corners cut out
    cx.fillStyle = 'rgb(240,210,20)';                 // opaque YELLOW disc in the centre
    cx.beginPath(); cx.arc(32, 32, 22, 0, Math.PI * 2); cx.fill();
    window.__M = { ip, snap, tracer, gpu, prim, Vec3: vec.Vec3, url: cvs.toDataURL('image/png') };
  })()`);
  t.check('modules + transparent-corner PNG ready', await t.until('!!window.__M'));

  // ---- build the scene: emissive-green cube + emit fragment plane in front -----
  await t.evaluate(`window.__built = false; (async () => {
    const { ip, prim, Vec3 } = window.__M; const S = window.__app.scene;
    if (S.editMode) S.exitEditMode();
    for (const o of [...S.objects]) S.remove(o.id);
    for (const m of [...S.materials]) S.removeMaterial(m.id);
    window.__app.undo.clear();
    S.world.mode = 'flat'; S.world.color = [0, 0, 0]; S.world.strength = 0;

    // Emissive-green cube (shows GREEN in the tracers regardless of lights).
    const cm = S.addMaterial('cube'); cm.shader = 'emit'; cm.shadeless = true;
    cm.baseColor = [0.05, 0.85, 0.1]; cm.emissiveStrength = 1;
    const cube = S.add('Cube', prim.makeCube(1.6)); cube.materialId = cm.id;
    window.__cube = cube.id;

    // Emit fragment plane in front (z=2), small (scale 0.7) so its corners still
    // project ONTO the cube behind it. createImagePlane auto-detects the alpha.
    const pl = ip.createImagePlane(S, window.__app.undo, { dataUrl: window.__M.url, name: 'frag', w: 64, h: 64, mode: 'emit' });
    pl.transform = pl.transform.withPosition(new Vec3(0, 0, 2)).withScale(new Vec3(0.7, 0.7, 0.7));
    window.__plane = pl.id; window.__planeMat = pl.materialId;
    // wait for the async texture decode (drives both the atlas and the alphaBlend flip)
    for (let i = 0; i < 80 && !S.getMaterial(pl.materialId).texImage; i++) await new Promise(r => setTimeout(r, 20));
    // give the .then() that flips alphaBlend a tick after texImage lands
    await new Promise(r => setTimeout(r, 30));

    const cam = window.__app.camera; cam.yaw = 0; cam.pitch = 1.4; cam.distance = 8; cam.target = new Vec3(0, 0, 0);
    window.__app.shadePrefs.ao = false;
    S.deselectAll();
    window.__built = true;
  })()`);
  t.check('scene built + texture decoded', await t.until('!!window.__built', 30000));

  // Suspect 2: a plain PNG-with-alpha pick auto-enabled alphaBlend at decode.
  const alphaBlend = await t.evaluate('window.__app.scene.getMaterial(window.__planeMat).alphaBlend === true');
  t.check('suspect 2: alphaBlend auto-set for a transparent PNG image plane', alphaBlend);

  // Pixel of a plane LOCAL point (lx,ly,0) in the live GL canvas, current shading.
  const livePx = (lx, ly) => t.evaluate(`(() => {
    const app = window.__app, gl = app.renderer.ctx.gl, c = gl.canvas;
    app.renderer.render(app.scene, app.camera);
    const obj = app.scene.get(window.__plane);
    const w = app.scene.worldMatrix(obj).transformPoint({ x: ${lx}, y: ${ly}, z: 0 });
    const p = app.renderer.currentViewProj(app.scene, app.camera).transformPoint(w);
    const px = Math.round((p.x * 0.5 + 0.5) * c.width), py = Math.round((p.y * 0.5 + 0.5) * c.height);
    const o = new Uint8Array(4); gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, o);
    return [o[0], o[1], o[2]];
  })()`);
  // Local corner (0.9,0.9) → transparent; centre (0,0) → opaque yellow.
  const CORNER = [0.9, 0.9], CENTER = [0, 0];

  // ---- Always-Textured modes: matcap / studio / wireframe ---------------------
  // Baseline = cube alone (plane hidden); with-plane must MATCH at the corner
  // (see-through) and DIFFER at the centre (opaque yellow).
  const solidModes = ['matcap', 'studio', 'wireframe'];
  const near = (a, b, tol = 28) => a && b && Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol && Math.abs(a[2] - b[2]) <= tol;
  const dark = (p) => Math.max(p[0], p[1], p[2]) < 24;
  const yellowish = (p) => p[0] > 120 && p[1] > 100 && p[0] > p[2] + 60 && p[1] > p[2] + 60;

  for (const mode of solidModes) {
    await t.evaluate(`window.__app.renderer.shadingMode = '${mode}'; window.__app.shadePrefs.renderedMode = 'live';`);
    await t.evaluate('window.__app.scene.get(window.__plane).visible = false');
    const baseCorner = await livePx(...CORNER);
    const baseCenter = await livePx(...CENTER);
    await t.evaluate('window.__app.scene.get(window.__plane).visible = true');
    const corner = await livePx(...CORNER);
    const center = await livePx(...CENTER);
    t.check(`${mode}: transparent corner shows the cube (matches baseline, not black) base=${JSON.stringify(baseCorner)} with=${JSON.stringify(corner)}`,
      near(corner, baseCorner) && !dark(corner));
    t.check(`${mode}: opaque centre shows the yellow fragment ${JSON.stringify(center)}`,
      yellowish(center) && !near(center, baseCenter));
  }

  // ---- Raytraced viewport (GPU): corner green (cube), centre yellow -----------
  const rayGpuAvail = await t.evaluate('window.__app.viewportRay.gpuAvailable()');
  await t.evaluate(`(() => {
    const sp = window.__app.shadePrefs;
    window.__app.renderer.shadingMode = 'rendered'; sp.renderedMode = 'ray'; sp.rayEngine = 'gpu'; sp.ao = false;
  })()`);
  await t.evaluate('for (let i=0;i<80 && window.__app.renderer.viewportRay.spp<24;i++) { window.__app.renderer.render(window.__app.scene, window.__app.camera); window.__app.renderer.viewportRay.flushSync(); }');
  const rvCorner = await livePx(...CORNER);
  const rvCenter = await livePx(...CENTER);
  const greenish = (p) => p[1] > 90 && p[1] > p[0] + 40 && p[1] > p[2] + 40;
  if (rayGpuAvail) {
    t.check(`Raytraced-viewport GPU: transparent corner shows GREEN cube (not black) ${JSON.stringify(rvCorner)}`, greenish(rvCorner));
    t.check(`Raytraced-viewport GPU: opaque centre shows YELLOW fragment ${JSON.stringify(rvCenter)}`, yellowish(rvCenter));
  } else {
    t.check('Raytraced-viewport GPU tracer unavailable — skipped', true);
  }

  // ---- F12 tracers (offscreen snapshot): CPU + GPU ---------------------------
  await t.evaluate(`window.__R = null; (async () => {
   try {
    const { snap: snapMod, tracer, gpu: gpuMod } = window.__M;
    const S = window.__app.scene;
    S.get(window.__plane).visible = true;
    const G = new gpuMod.GpuTracer();
    const W = 40, H = 40;
    const cam = window.__app.camera;
    const projPix = (c, wp) => {
      const fwd = c.forward, rt = c.right, up = c.up, pos = c.position;
      const d = [wp[0]-pos[0], wp[1]-pos[1], wp[2]-pos[2]];
      const zc = d[0]*fwd[0]+d[1]*fwd[1]+d[2]*fwd[2];
      const xc = d[0]*rt[0]+d[1]*rt[1]+d[2]*rt[2];
      const yc = d[0]*up[0]+d[1]*up[1]+d[2]*up[2];
      const tanH = Math.tan(c.fovY*0.5), aspect = W/H;
      const nx = (xc/zc)/(tanH*aspect), ny = (yc/zc)/tanH;
      return [Math.max(0,Math.min(W-1,Math.round((nx*0.5+0.5)*W))), Math.max(0,Math.min(H-1,Math.round((0.5-ny*0.5)*H)))];
    };
    const cpuShot = (snap, spp) => { const sc = tracer.prepareScene(snap); const acc = new Float32Array(W*H*3); for (let i=0;i<spp;i++) tracer.renderSample(sc, acc, W, H, i, 1); return (px,py) => { const c = py*W+px; return [acc[c*3]/spp, acc[c*3+1]/spp, acc[c*3+2]/spp]; }; };
    const gpuShot = (snap, spp) => { G.setSnapshot(snap); G.beginProgressive(W,H,1); while (G.accumulatedSamples<spp && !G.contextLost) G.accumulate(8); const buf = G.readbackProgressive(); return (px,py) => { const c = py*W+px; return [buf[c*4], buf[c*4+1], buf[c*4+2]]; }; };

    // world points: plane corner (local 0.9,0.9 scaled 0.7 at z=2) and centre.
    const mtx = S.worldMatrix(S.get(window.__plane));
    const wc = mtx.transformPoint({x:0.9,y:0.9,z:0}); const cornerW = [wc.x, wc.y, wc.z];
    const wm = mtx.transformPoint({x:0,y:0,z:0}); const centerW = [wm.x, wm.y, wm.z];

    const snap = snapMod.buildSnapshot(S, cam);
    const cp = projPix(snap.camera, cornerW), mp = projPix(snap.camera, centerW);
    const cpu = cpuShot(snap, 12);
    const g = G.available ? gpuShot(snap, 16) : null;
    window.__R = {
      gpuAvail: G.available,
      cpuCorner: cpu(cp[0], cp[1]), cpuCenter: cpu(mp[0], mp[1]),
      gpuCorner: g ? g(cp[0], cp[1]) : null, gpuCenter: g ? g(mp[0], mp[1]) : null,
    };
   } catch (e) { window.__R = { error: String(e && e.stack || e) }; }
  })()`);
  t.check('F12 tracer probes computed', await t.until('!!window.__R', 60000));
  const R = await t.evaluate('window.__R');
  if (R.error) { t.check('F12 tracer probes ran without error: ' + R.error, false); }
  else {
    console.log('F12 probes: ' + JSON.stringify(R));
    const gDom = (p) => p && p[1] > p[0] + 0.05 && p[1] > p[2] + 0.05 && p[1] > 0.1; // green
    const yDom = (p) => p && p[0] > 0.15 && p[1] > 0.12 && p[0] > p[2] + 0.08 && p[1] > p[2] + 0.08; // yellow
    t.check('F12-CPU: transparent corner shows GREEN cube (not black) ' + JSON.stringify(R.cpuCorner), gDom(R.cpuCorner));
    t.check('F12-CPU: opaque centre shows YELLOW fragment ' + JSON.stringify(R.cpuCenter), yDom(R.cpuCenter));
    if (R.gpuAvail) {
      t.check('F12-GPU: transparent corner shows GREEN cube (not black) ' + JSON.stringify(R.gpuCorner), gDom(R.gpuCorner));
      t.check('F12-GPU: opaque centre shows YELLOW fragment ' + JSON.stringify(R.gpuCenter), yDom(R.gpuCenter));
    } else {
      t.check('F12-GPU tracer unavailable — skipped', true);
    }
  }

  // ---- Screenshot: the cutout fragment floating in a traced render ------------
  await t.evaluate(`(() => {
    const sp = window.__app.shadePrefs;
    window.__app.renderer.shadingMode = 'rendered'; sp.renderedMode = 'ray'; sp.rayEngine = 'gpu'; sp.ao = false;
    const cam = window.__app.camera; cam.yaw = 0.5; cam.pitch = 0.9; cam.distance = 8;
  })()`);
  await t.evaluate('for (let i=0;i<120 && window.__app.renderer.viewportRay.spp<128;i++) { window.__app.renderer.render(window.__app.scene, window.__app.camera); window.__app.renderer.viewportRay.flushSync(); }');
  await t.sleep(150);
  await t.evaluate('window.__app.renderer.render(window.__app.scene, window.__app.camera)');
  await t.screenshot('e2e/screenshots/ur16-6-cutout-fragment.png');
  t.check('cutout-fragment traced screenshot saved', true);
});
