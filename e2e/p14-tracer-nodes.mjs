/**
 * P14-2 e2e — node-graph shading in the path tracer AND the Rendered viewport.
 * Boots the app, UV-maps the default cube, assigns a flat material, and captures
 * both a path-traced frame and a Rendered-viewport frame. Then it turns the
 * material into a node material (Checker → Base Color, red/blue) and re-captures
 * both: each must DIFFER from its flat counterpart — proving the tracer hook
 * (this task) and the bake path both route through evaluateGraph.
 *
 * Run with the dev server up:
 *   flock /tmp/vibe-blender-e2e.lock node e2e/p14-tracer-nodes.mjs
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  await t.reload();

  // --- Setup: default Cube + one bright side light + a flat grey material. ---
  const setup = await t.evaluate(`(() => {
    const s = window.__app.scene;
    if (s.editMode) s.exitEditMode();
    for (const o of [...s.objects]) if (o.kind !== 'mesh') s.remove(o.id);
    const light = s.addLight('Light', 'point');
    light.light.power = 300000;
    const P = light.transform.position;
    light.transform = light.transform.withPosition(new P.constructor(6, 3, 6));
    const cube = s.objects.find((o) => o.kind === 'mesh');
    if (!cube) return { ok: false, why: 'no mesh' };
    let faces = 0;
    for (const f of cube.mesh.faces.values()) {
      if (f.verts.length === 4) {
        cube.mesh.setFaceUVs(f.id, [[0, 0], [1, 0], [1, 1], [0, 1]]);
        faces++;
      }
    }
    const mat = s.addMaterial('NodeMat');
    mat.baseColor = [0.75, 0.75, 0.75];
    mat.metallic = 0;
    mat.roughness = 0.6;
    cube.materialId = mat.id;
    window.__p14 = { matId: mat.id, cubeId: cube.id };
    return { ok: true, faces };
  })()`);
  t.check('setup: cube got quad UVs + flat material', setup && setup.ok && setup.faces >= 6,
    JSON.stringify(setup));

  const readTracer = () => t.evaluate(`(() => {
    const cv = window.__renderEngine.canvas();
    const ctx = cv.getContext('2d');
    const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
    const out = [];
    for (let i = 0; i < d.length; i += 16) out.push(d[i], d[i + 1], d[i + 2]);
    return out;
  })()`);

  // --- Path trace the FLAT material ---
  await t.evaluate('window.__renderEngine.start()');
  const okFlat = await t.until('window.__renderEngine.sample() >= 8', 40000);
  t.check('flat-material path trace accumulates samples', okFlat);
  const flatTrace = await readTracer();
  t.check('flat trace frame is non-empty', Array.isArray(flatTrace) && flatTrace.length > 100);
  await t.evaluate('window.__renderEngine.close()');
  await t.sleep(150);

  // --- Rendered-viewport capture of the FLAT material (bake path baseline) ---
  await t.evaluate(`window.__app.renderer.shadingMode = 'rendered'`);
  await t.sleep(120);
  const flatViewErr = await t.evaluate(`(() => {
    const app = window.__app, gl = app.renderer.ctx.gl, c = gl.canvas;
    app.renderer.render(app.scene, app.camera);
    const px = new Uint8Array(c.width * c.height * 4);
    gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
    window.__p14flatView = Array.from(px);
    return gl.getError();
  })()`);
  t.check('rendered pass reports NO GL error (flat)', flatViewErr === 0, `getError ${flatViewErr}`);

  // --- Turn the material into a Checker → Base Color node material (red/blue).
  // Built literally in the page — nodeGraph functions are not on window. ------
  await t.evaluate(`(() => {
    const mat = window.__app.scene.getMaterial(window.__p14.matId);
    mat.nodeGraph = {
      nodes: [
        { id: 0, type: 'principled', x: 380, y: 120, params: {} },
        { id: 1, type: 'checker', x: 80, y: 120,
          params: { scale: 8, colorA: [1, 0, 0], colorB: [0, 0, 1] } },
      ],
      links: [{ fromNode: 1, fromSocket: 'color', toNode: 0, toSocket: 'baseColor' }],
      nextNodeId: 2,
    };
    mat.useNodes = true;
    mat.nodeGraphVersion = (mat.nodeGraphVersion || 0) + 1;
  })()`);

  // --- Path trace the NODE material ---
  await t.evaluate(`window.__app.renderer.shadingMode = 'matcap'`);
  await t.evaluate('window.__renderEngine.start()');
  const okNode = await t.until('window.__renderEngine.sample() >= 8', 40000);
  t.check('node-material path trace accumulates samples', okNode);
  const nodeTrace = await readTracer();
  await t.evaluate('window.__renderEngine.close()');
  await t.sleep(150);

  let diff = 0, n = Math.min(flatTrace.length, nodeTrace.length);
  for (let i = 0; i < n; i++) diff += Math.abs(flatTrace[i] - nodeTrace[i]);
  const meanDiff = diff / n;
  t.check('node-material trace DIFFERS from the flat trace (tracer hook active)',
    meanDiff > 1.0, `meanAbsDiff(0-255)=${meanDiff.toFixed(3)}`);

  await t.screenshot('/tmp/p14-tracer-nodes.png');

  // --- Rendered-viewport capture of the NODE material (bake path) ---
  await t.evaluate(`window.__app.renderer.shadingMode = 'rendered'`);
  await t.sleep(150);
  const nodeViewErr = await t.evaluate(`(() => {
    const app = window.__app, gl = app.renderer.ctx.gl, c = gl.canvas;
    app.renderer.render(app.scene, app.camera);
    const px = new Uint8Array(c.width * c.height * 4);
    gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
    window.__p14nodeView = Array.from(px);
    return gl.getError();
  })()`);
  t.check('rendered pass reports NO GL error (node)', nodeViewErr === 0, `getError ${nodeViewErr}`);

  const viewDiff = await t.evaluate(`(() => {
    const a = window.__p14flatView, b = window.__p14nodeView;
    let d = 0, n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) d += Math.abs(a[i] - b[i]);
    return d / n;
  })()`);
  t.check('Rendered-viewport node bake DIFFERS from the flat viewport (bake path active)',
    viewDiff > 1.0, `meanAbsDiff(0-255)=${viewDiff.toFixed(3)}`);

  // --- Cleanup ---
  await t.evaluate(`window.__app.renderer.shadingMode = 'matcap'`);
  await t.evaluate(`(() => {
    const s = window.__app.scene;
    for (const o of [...s.objects]) if (o.kind !== 'mesh') s.remove(o.id);
    const cube = s.objects.find((o) => o.kind === 'mesh');
    if (cube) cube.materialId = null;
    delete window.__p14;
  })()`);
});
