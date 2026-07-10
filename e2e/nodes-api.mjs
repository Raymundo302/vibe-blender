/**
 * Scriptable node-graph API e2e (Use & Refine: "scriptable node-graph API").
 *
 * Drives window.__app.nodes end-to-end: give the default cube's material a
 * checker → ColorRamp → Principled chain PROGRAMMATICALLY (no Shader Editor
 * UI), force a bake, switch to Rendered mode, and pixel-assert the cube face
 * now shows variance (checker cells) where the flat material was near-uniform.
 * Then prove undo integration: two Ctrl+Z (Build Chain, then Enable Nodes)
 * remove the scripted nodes and the face returns near the flat baseline.
 *
 * Run with the dev server up:
 *   E2E_PORT=9414 node e2e/nodes-api.mjs
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  const report = {};

  // Layout workspace + dismiss splash.
  await t.evaluate(`document.querySelector('.wsp-tab[data-workspace="Layout"]')?.click()`);
  await t.sleep(150);
  await t.key('Escape', 'Escape', 0);
  await t.sleep(80);

  const rect = await t.evaluate(`(() => {
    const c = document.querySelector('#viewport-wrap canvas') || document.querySelector('canvas');
    const r = c.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  })()`);
  const cx = Math.round(rect.x + rect.w / 2);
  const cy = Math.round(rect.y + rect.h / 2);

  // --- Setup: default cube gets full-square per-face UVs + a fresh material,
  //     a bright flat world (uniform backdrop so face variance is all texture),
  //     Rendered mode. Focus the viewport so global Ctrl+Z lands later. ---
  const setup = await t.evaluate(`(() => {
    const s = window.__app.scene;
    const obj = s.objects.find((o) => o.kind === 'mesh');
    if (!obj) return { err: 'no mesh' };
    for (const f of obj.mesh.faces.values()) {
      if (f.verts.length === 4) obj.mesh.setFaceUVs(f.id, [[0, 0], [1, 0], [1, 1], [0, 1]]);
    }
    const mat = s.addMaterial('CubeNodes');
    obj.materialId = mat.id;
    s.selectOnly(obj.id);
    const w = s.world; w.mode = 'flat'; w.color = [1, 1, 1]; w.strength = 3;
    window.__app.renderer.shadingMode = 'rendered';
    return { objId: obj.id, matId: mat.id, uvs: obj.mesh.uvs.size };
  })()`);
  t.check('cube seeded with per-face UVs + fresh material', setup.uvs > 0, JSON.stringify(setup));
  const matId = setup.matId;

  // Frame the cube.
  await t.mouse('mouseMoved', cx, cy);
  await t.mouse('mousePressed', cx, cy, 'left');
  await t.mouse('mouseReleased', cx, cy, 'left');
  await t.evaluate(`window.__app.scene.selectOnly(${setup.objId})`);
  await t.mouse('mouseMoved', cx, cy);
  await t.key('.', 'NumpadDecimal', 0);
  await t.sleep(200);

  // Luminance spread across a cube-anchored horizontal strip. Checker face
  // straddles cells → large spread; flat face → small. (p11-textures pattern.)
  const stripSpread = () => t.evaluate(`(() => {
    const app = window.__app, gl = app.renderer.ctx.gl, c = gl.canvas;
    app.renderer.render(app.scene, app.camera);
    const vp = app.renderer.currentViewProj(app.scene, app.camera);
    const m = vp.m;
    const cw = m[15];
    const px_ = (m[12] / cw * 0.5 + 0.5) * c.width;
    const py_ = (m[13] / cw * 0.5 + 0.5) * c.height;
    const n = 120, x0 = Math.max(0, Math.round(px_ - n / 2));
    const px = new Uint8Array(n * 4);
    gl.readPixels(x0, Math.round(py_), n, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let min = 999, max = -999;
    for (let i = 0; i < n; i++) {
      const l = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
      if (l < min) min = l; if (l > max) max = l;
    }
    return max - min;
  })()`);

  // --- Baseline: flat material → near-uniform face ---
  const flatSpread = await stripSpread();
  t.check('flat material face is near-uniform (baseline)', flatSpread < 30, `spread ${flatSpread.toFixed(1)}`);
  report.flatSpread = +flatSpread.toFixed(1);

  // --- Build the chain PROGRAMMATICALLY via window.__app.nodes ---
  //     forMaterial → Enable Nodes (undo cmd 1). batch → Build Chain (cmd 2).
  const built = await t.evaluate(`(() => {
    const api = window.__app.nodes;
    const h = api.forMaterial(${matId});
    const out = h.output();
    let checker, ramp;
    h.batch('Build Chain', () => {
      checker = h.add('checker', { scale: 6 }, [40, 40]);
      ramp = h.add('colorRamp', undefined, [260, 40]);
      h.connect(checker, 'color', ramp, 'fac');
      h.connect(ramp, 'color', out, 'baseColor');
    });
    const dims = h.bake();
    return {
      list: h.list().map((n) => n.type).sort(),
      links: h.links().length,
      dims,
      useNodes: window.__app.scene.getMaterial(${matId}).useNodes,
    };
  })()`);
  t.check('graph built: checker + colorRamp + principled',
    JSON.stringify(built.list) === JSON.stringify(['checker', 'colorRamp', 'principled']),
    JSON.stringify(built.list));
  t.check('two links (checker→ramp, ramp→baseColor)', built.links === 2, `links ${built.links}`);
  t.check('useNodes enabled by forMaterial', built.useNodes === true);
  t.check('bake() returns the baked map size', built.dims.width === 128 && built.dims.height === 128,
    JSON.stringify(built.dims));
  report.bakeDims = built.dims;

  // --- Rendered face now shows variance (checker cells) ---
  await t.sleep(120);
  const nodeSpread = await stripSpread();
  t.check('scripted checker chain makes the cube face show variance',
    nodeSpread > 30 && nodeSpread > flatSpread + 20, `nodeSpread ${nodeSpread.toFixed(1)} vs flat ${flatSpread.toFixed(1)}`);
  report.nodeSpread = +nodeSpread.toFixed(1);

  // --- Undo integration: two Ctrl+Z remove the scripted nodes ---
  await t.mouse('mouseMoved', cx, cy);
  await t.key('z', 'KeyZ', 2); // ctrl → undo Build Chain
  await t.sleep(80);
  await t.key('z', 'KeyZ', 2); // ctrl → undo Enable Nodes
  await t.sleep(80);
  const afterUndo = await t.evaluate(`(() => {
    const mat = window.__app.scene.getMaterial(${matId});
    const g = mat.nodeGraph;
    return {
      useNodes: mat.useNodes,
      hasChecker: !!(g && g.nodes.some((n) => n.type === 'checker')),
      hasRamp: !!(g && g.nodes.some((n) => n.type === 'colorRamp')),
    };
  })()`);
  t.check('Ctrl+Z twice removed the scripted checker + ramp nodes',
    !afterUndo.hasChecker && !afterUndo.hasRamp, JSON.stringify(afterUndo));
  t.check('Ctrl+Z twice turned useNodes back off', afterUndo.useNodes === false);

  await t.sleep(80);
  const undoSpread = await stripSpread();
  t.check('face returns near the flat baseline after undo', undoSpread < 30, `spread ${undoSpread.toFixed(1)}`);
  report.undoSpread = +undoSpread.toFixed(1);

  // Cleanup: reset shading so the run leaves a clean state.
  await t.evaluate(`window.__app.renderer.shadingMode = 'matcap'`);

  console.log('\n===NODES-API-REPORT===');
  console.log(JSON.stringify(report, null, 2));
  console.log('===END-REPORT===');
});
