/**
 * P14-3 e2e — Node set B in the Rendered bake path.
 *
 * The unit tests (src/core/nodes/nodesB.test.ts) carry the math burden. This
 * suite proves the ColorRamp node lands on the real screen: it builds a
 * value → ColorRamp → Base Color graph on the active object's material, flips
 * the material to useNodes, bumps nodeGraphVersion, and renders. The baked
 * base texture must exist and the Rendered frame must differ from the same
 * object with a plain flat material — i.e. the graph (with our node) actually
 * drove the shading.
 *
 *   flock /tmp/vibe-blender-e2e.lock node e2e/p14-nodes-b.mjs
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  // Clean single-Cube scene, cube selected, per-face UVs seeded, key light +
  // bright flat world so Rendered mode is lit (mirrors p13-mattab-maps).
  const saved = await t.evaluate('window.__app.io.serialize()');
  await t.evaluate(`document.querySelector('.wsp-tab[data-workspace="Layout"]')?.click()`);
  await t.sleep(150);
  await t.evaluate(`window.__app.io.apply(${JSON.stringify(saved)})`);

  const setup = await t.evaluate(`(() => {
    const app = window.__app, scene = app.scene, obj = scene.objects[0];
    scene.selectOnly(obj.id);
    for (const f of obj.mesh.faces.values()) {
      if (f.verts.length === 4) obj.mesh.setFaceUVs(f.id, [[0, 0], [1, 0], [1, 1], [0, 1]]);
    }
    const w = scene.world; w.mode = 'flat'; w.color = [1, 1, 1]; w.strength = 2;
    const cam = app.camera, e = cam.eye;
    const Y = e.constructor.Y ?? new e.constructor(0, 1, 0);
    const right = cam.forward.cross(Y).normalize();
    const L = scene.addLight('KeyLight', 'point');
    L.transform = L.transform.withPosition(e.add(right.scale(6)).add(Y.scale(4)));
    L.light.power = 20000;
    // A material on the cube, flat grey to start.
    const mat = scene.addMaterial('NodeB');
    mat.baseColor = [0.5, 0.5, 0.5];
    scene.activeObject.materialId = mat.id;
    return mat.id;
  })()`);
  t.check('scene set up, material assigned', typeof setup === 'number');
  const matId = setup;

  // --- Flat-material Rendered frame (before) ---
  await t.evaluate(`window.__app.renderer.shadingMode = 'rendered'`);
  await t.sleep(120);
  const preErr = await t.evaluate(`(() => {
    const app = window.__app, gl = app.renderer.ctx.gl, c = gl.canvas;
    app.renderer.render(app.scene, app.camera);
    const px = new Uint8Array(c.width * c.height * 4);
    gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
    window.__p14pre = px;
    return gl.getError();
  })()`);
  t.check('rendered pass reports NO GL error (flat material)', preErr === 0, `getError ${preErr}`);
  await t.screenshot('/tmp/p14-nodes-b-flat.png');

  // --- Build value(0.8) → ColorRamp(black→red) → baseColor, enable nodes ---
  const built = await t.evaluate(`(() => {
    const mat = window.__app.scene.getMaterial(${matId});
    mat.nodeGraph = {
      nodes: [
        { id: 0, type: 'principled', x: 380, y: 120, params: {} },
        { id: 1, type: 'value', x: 0, y: 0, params: { value: 0.8 } },
        { id: 2, type: 'colorRamp', x: 180, y: 0, params: {
            ramp: { stops: [ { pos: 0, color: [0, 0, 0] }, { pos: 1, color: [1, 0, 0] } ] } } },
      ],
      links: [
        { fromNode: 1, fromSocket: 'value', toNode: 2, toSocket: 'fac' },
        { fromNode: 2, fromSocket: 'color', toNode: 0, toSocket: 'baseColor' },
      ],
      nextNodeId: 3,
    };
    mat.useNodes = true;
    mat.nodeGraphVersion = (mat.nodeGraphVersion ?? 0) + 1;
    return mat.useNodes && !!mat.nodeGraph;
  })()`);
  t.check('node graph built (value → colorRamp → baseColor) + useNodes on', built === true);

  // --- Rendered frame (after) + baked texture check ---
  await t.sleep(80);
  const after = await t.evaluate(`(() => {
    const app = window.__app, gl = app.renderer.ctx.gl, c = gl.canvas;
    app.renderer.render(app.scene, app.camera);
    const px = new Uint8Array(c.width * c.height * 4);
    gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const pre = window.__p14pre;
    let diff = 0, redder = 0;
    for (let i = 0; i < px.length; i += 4) {
      const dr = px[i] - pre[i], dg = px[i + 1] - pre[i + 1], db = px[i + 2] - pre[i + 2];
      if (Math.abs(dr) + Math.abs(dg) + Math.abs(db) > 24) diff++;
      // On the lit cube face, the ramp (fac 0.8 → red 0.8) makes the surface
      // red-dominant: the red-minus-green separation grows vs the flat grey it
      // replaced (grey R≈G → red R≫G), independent of overall brightness.
      if ((px[i] - px[i + 1]) > (pre[i] - pre[i + 1]) + 15) redder++;
    }
    const mat = app.scene.getMaterial(${matId});
    return {
      err: gl.getError(),
      diff, redder,
      baked: !!(mat.baked && mat.baked.baseUrl && mat.baked.baseUrl.startsWith('data:image/png')),
      bakedVersion: mat.baked ? mat.baked.version : -1,
      graphVersion: mat.nodeGraphVersion,
    };
  })()`);
  t.check('rendered pass reports NO GL error (node graph)', after.err === 0, `getError ${after.err}`);
  t.check('material baked base texture from the graph', after.baked === true);
  t.check('baked version tracks nodeGraphVersion', after.bakedVersion === after.graphVersion,
    `baked ${after.bakedVersion} vs graph ${after.graphVersion}`);
  t.check('rendered frame visibly differs from the flat material', after.diff > 200, `${after.diff} px`);
  t.check('the ColorRamp output shifts the surface toward red', after.redder > 50, `${after.redder} px`);
  await t.screenshot('/tmp/p14-nodes-b-nodes.png');

  // --- Idempotent bake: re-render at the same version reuses the bake ---
  const stable = await t.evaluate(`(() => {
    const mat = window.__app.scene.getMaterial(${matId});
    const before = mat.baked.baseUrl;
    window.__app.renderer.render(window.__app.scene, window.__app.camera);
    return mat.baked.baseUrl === before;
  })()`);
  t.check('bake is idempotent at an unchanged version', stable === true);

  // Restore original scene + shading so we leave nothing behind.
  await t.evaluate(`window.__app.renderer.shadingMode = 'matcap'`);
  await t.evaluate(`window.__app.io.apply(${JSON.stringify(saved)})`);
  await t.evaluate(`window.__app.autosave && window.__app.autosave.clear && window.__app.autosave.clear()`);
});
