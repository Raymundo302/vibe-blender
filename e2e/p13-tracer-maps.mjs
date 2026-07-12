/**
 * P13-1 e2e — path tracer normal/bump + roughness/metallic map shading.
 * Boots the app, puts a UV'd cube under a strong side light, assigns a material
 * with an asymmetric normal map, and proves the path-traced render DIFFERS from
 * the same scene with the map cleared (pixel compare of two accumulated frames).
 *
 * Run with the dev server up:
 *   flock /tmp/vibe-blender-e2e.lock node e2e/p13-tracer-maps.mjs
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  // UR12-3: default render engine is GPU; these are CPU-path regression suites — pin CPU.
  await t.until('!!window.__renderEngine');
  await t.evaluate("window.__renderEngine.setEngine('cpu')");
  await t.reload();

  // --- Setup: default Cube + one bright side light. Give the cube UVs and a
  // material so a normal map has something to perturb. ------------------------
  const setup = await t.evaluate(`(() => {
    const s = window.__app.scene;
    if (s.editMode) s.exitEditMode();
    for (const o of [...s.objects]) if (o.kind !== 'mesh') s.remove(o.id);
    const light = s.addLight('Light', 'point');
    light.light.power = 300000;
    const P = light.transform.position;
    light.transform = light.transform.withPosition(new P.constructor(6, 3, 6));
    // First mesh object = the default cube.
    const cube = s.objects.find((o) => o.kind === 'mesh');
    if (!cube) return { ok: false, why: 'no mesh' };
    // Full 0..1 UV square on every (quad) face so the map covers each face.
    let faces = 0;
    for (const f of cube.mesh.faces.values()) {
      if (f.verts.length === 4) {
        cube.mesh.setFaceUVs(f.id, [[0, 0], [1, 0], [1, 1], [0, 1]]);
        faces++;
      }
    }
    const mat = s.addMaterial('MapMat');
    mat.baseColor = [0.85, 0.85, 0.85];
    mat.metallic = 0;
    mat.roughness = 0.6;
    cube.materialId = mat.id;
    window.__p13 = { matId: mat.id, cubeId: cube.id };
    return { ok: true, faces };
  })()`);
  t.check('setup: cube got quad UVs', setup && setup.ok && setup.faces >= 6,
    JSON.stringify(setup));

  // Build an asymmetric normal map (left half leans -T, right half leans +T) and
  // attach it to the material's runtime cache (the tracer reads normalImage).
  await t.evaluate(`(() => {
    const s = window.__app.scene;
    const mat = s.getMaterial(window.__p13.matId);
    const W = 16, H = 16;
    const px = new Float32Array(W * H * 3);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      px[i] = x < W / 2 ? 0.05 : 0.95; // decodes to ~-0.9 / +0.9 along T
      px[i + 1] = 0.5;
      px[i + 2] = 1.0;
    }
    mat.normalImage = { width: W, height: H, pixels: px };
    mat.normalDataUrl = 'data:e2e-normal';   // non-null so the pipeline treats it as set
    mat.normalIsBump = false;
    mat.normalStrength = 2.0;
  })()`);

  // --- Render WITH the normal map ---
  await t.evaluate('window.__renderEngine.start()');
  const okA = await t.until('window.__renderEngine.sample() >= 8', 40000);
  t.check('render with normal map accumulates samples', okA);

  const readImg = () => t.evaluate(`(() => {
    const cv = window.__renderEngine.canvas();
    const ctx = cv.getContext('2d');
    const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
    // Return a compact array (subsample every 4th pixel to keep it small).
    const out = [];
    for (let i = 0; i < d.length; i += 16) out.push(d[i], d[i + 1], d[i + 2]);
    return out;
  })()`);
  const withMap = await readImg();
  t.check('with-map frame is non-empty', Array.isArray(withMap) && withMap.length > 100);

  await t.evaluate('window.__renderEngine.close()');
  await t.sleep(150);

  // --- Clear the map, render the SAME scene again ---
  await t.evaluate(`(() => {
    const mat = window.__app.scene.getMaterial(window.__p13.matId);
    mat.normalImage = undefined;
    mat.normalDataUrl = null;
  })()`);
  await t.evaluate('window.__renderEngine.start()');
  const okB = await t.until('window.__renderEngine.sample() >= 8', 40000);
  t.check('render without normal map accumulates samples', okB);
  const noMap = await readImg();

  // --- Compare: the two renders must differ (map perturbed the shading). ---
  let diff = 0, n = Math.min(withMap.length, noMap.length);
  for (let i = 0; i < n; i++) diff += Math.abs(withMap[i] - noMap[i]);
  const meanDiff = diff / n;
  t.check('normal-mapped render DIFFERS from the no-map render',
    meanDiff > 0.5, `meanAbsDiff(0-255)=${meanDiff.toFixed(3)}`);

  await t.screenshot('/tmp/p13-tracer-maps.png');

  // --- Bump (height) map path: a height ramp perturbs the shading normal via
  // the central-difference gradient → the render must differ from no-map.
  // (Rough/metal maps only alter the INDIRECT glossy bounce in this tracer, so
  // their effect is below a few-spp cube render's noise — they're covered end-
  // to-end in maps.test.ts with an observable floor+highlight setup instead.)
  await t.evaluate('window.__renderEngine.close()');
  await t.sleep(120);
  // noMap frame already captured above (map cleared). Now attach a bump map.
  await t.evaluate(`(() => {
    const mat = window.__app.scene.getMaterial(window.__p13.matId);
    const W = 16, H = 16;
    const px = new Float32Array(W * H * 3);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      const v = x / (W - 1); // height ramp along U → strong gradient
      px[i] = v; px[i + 1] = v; px[i + 2] = v;
    }
    mat.normalImage = { width: W, height: H, pixels: px };
    mat.normalDataUrl = 'data:e2e-bump';
    mat.normalIsBump = true;
    mat.normalStrength = 3.0;
  })()`);
  await t.evaluate('window.__renderEngine.start()');
  const okC = await t.until('window.__renderEngine.sample() >= 8', 40000);
  t.check('render with bump map accumulates samples', okC);
  const withBump = await readImg();
  let bdiff = 0, bn = Math.min(withBump.length, noMap.length);
  for (let i = 0; i < bn; i++) bdiff += Math.abs(withBump[i] - noMap[i]);
  t.check('bump-mapped render DIFFERS from the no-map render',
    bdiff / bn > 0.5, `meanAbsDiff(0-255)=${(bdiff / bn).toFixed(3)}`);

  // --- Cleanup ---
  await t.evaluate('window.__renderEngine.close()');
  await t.evaluate(`(() => {
    const s = window.__app.scene;
    for (const o of [...s.objects]) if (o.kind !== 'mesh') s.remove(o.id);
    const cube = s.objects.find((o) => o.kind === 'mesh');
    if (cube) cube.materialId = null;
    delete window.__p13;
  })()`);
});
