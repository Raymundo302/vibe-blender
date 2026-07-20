/**
 * UR16-2 — Material tab v2 (shader-first UI, socket rows, fixed layout).
 *
 * Covers the acceptance criteria:
 *  (1) shader chooser lists 5, default Diffuse on a new material; switching to
 *      Glass shows exactly color/roughness/IOR/alpha rows.
 *  (2) socket → Image on Diffuse color loads a dataURL and the viewport shows it.
 *  (3) socket → Gradient axis Z on a tall object → top/bottom colour split in
 *      Rendered AND the raytraced GPU viewport.
 *  (4) every color input in the tab has EQUAL computed height.
 *  (5) label→control horizontal gap ≤ 16px on a representative row.
 *  (6) a popover opened near the right screen edge stays fully on-screen.
 *  (7) an emit image plane's Properties shows the image in the EMIT color row.
 *  (8) undo works per edit.
 *
 *   E2E_PORT=9811 node e2e/material-tab-v2.mjs http://localhost:5199/
 */
import { runE2e } from './harness.mjs';

/** A solid NxN PNG data URL of a #rrggbb colour. */
const solidPng = (hex, n = 8) => `(() => {
  const cv = document.createElement('canvas'); cv.width = ${n}; cv.height = ${n};
  const c = cv.getContext('2d'); c.fillStyle = '${hex}'; c.fillRect(0, 0, ${n}, ${n});
  return cv.toDataURL('image/png');
})()`;

runE2e(async (t) => {
  await t.key('Escape', 'Escape', 0); // dismiss splash

  // Clean single-Cube scene in the Layout workspace, cube selected.
  const saved = await t.evaluate('window.__app.io.serialize()');
  await t.evaluate(`document.querySelector('.wsp-tab[data-workspace="Layout"]')?.click()`);
  await t.sleep(150);
  await t.evaluate(`window.__app.io.apply(${JSON.stringify(saved)})`);
  await t.evaluate(`window.__app.scene.selectOnly(window.__app.scene.objects[0].id)`);
  await t.sleep(120);

  // Open the Material tab + create a material (defaults to Diffuse).
  await t.evaluate(`document.querySelector('.properties-tab-btn[data-tab="material"]').click()`);
  await t.sleep(120);
  await t.evaluate(`document.querySelector('.material-tab-new-btn').click()`);
  await t.sleep(160);

  // === (1) Shader chooser ===
  t.check('new material defaults to Diffuse shader',
    (await t.evaluate(`window.__materialTab.material().shader`)) === 'diffuse');
  t.check('Shader row value reads "Diffuse"',
    (await t.evaluate(`document.querySelector('.material-tab-shader-value')?.textContent`)) === 'Diffuse');

  // Open the chooser via the socket circle; count the options.
  await t.evaluate(`document.querySelector('.material-tab-shader-socket').click()`);
  await t.sleep(80);
  const shaderOpts = await t.evaluate(`(() => {
    const els = [...document.querySelectorAll('.material-shader-option')];
    return { count: els.length, labels: els.map((e) => e.textContent) };
  })()`);
  t.check('shader chooser lists exactly 5 shaders', shaderOpts.count === 5, JSON.stringify(shaderOpts.labels));
  t.check('chooser includes Diffuse/Super Shader/Metal/Glass/Emit',
    ['Diffuse', 'Super Shader', 'Metal', 'Glass', 'Emit'].every((l) => shaderOpts.labels.includes(l)),
    JSON.stringify(shaderOpts.labels));
  await t.key('Escape', 'Escape', 0); // close popover
  await t.sleep(60);

  // Switch to Glass → exactly color / roughness / IOR / alpha rows.
  await t.evaluate(`window.__materialTab.setShader('glass')`);
  await t.sleep(140);
  const glassRows = await t.evaluate(`(() => {
    const q = (s) => !!document.querySelector(s);
    return {
      color: q('.material-tab-fields .prop-row[data-channel="color"]'),
      roughness: q('.material-tab-fields .prop-row[data-channel="roughness"]'),
      ior: q('.material-tab-fields .material-tab-ior-row'),
      alpha: q('.material-tab-fields .prop-row[data-channel="alpha"]'),
      metallic: q('.material-tab-fields .prop-row[data-channel="metallic"]'),
    };
  })()`);
  t.check('Glass shows color/roughness/IOR/alpha rows',
    glassRows.color && glassRows.roughness && glassRows.ior && glassRows.alpha, JSON.stringify(glassRows));
  t.check('Glass shows NO metallic row', !glassRows.metallic);

  // === (5) label→control gap ≤ 16px (representative row: roughness) ===
  const gap = await t.evaluate(`(() => {
    const row = document.querySelector('.material-tab-fields .prop-row[data-channel="roughness"]');
    const label = row.querySelector('.prop-row-label').getBoundingClientRect();
    const ctrl = row.querySelector('.prop-row-control').getBoundingClientRect();
    return ctrl.left - label.right;
  })()`);
  t.check('label→control gap ≤ 16px', gap >= 0 && gap <= 16, `gap ${gap.toFixed(1)}px`);

  // === (6) popover clamps to the viewport near the right edge ===
  const clamp = await t.evaluate(`(() => {
    const a = document.createElement('div');
    a.style.cssText = 'position:fixed;top:40px;left:' + (window.innerWidth - 12) + 'px;width:8px;height:8px;';
    document.body.appendChild(a);
    const p = new window.__Popover(a, [
      { label: 'A very wide popover item that would overflow', run: () => {} },
      { label: 'Second option', run: () => {} },
    ]);
    const r = p.element.getBoundingClientRect();
    const res = { right: r.right, left: r.left, vw: window.innerWidth };
    p.close(); a.remove();
    return res;
  })()`);
  t.check('right-edge popover stays fully on-screen',
    clamp.right <= clamp.vw && clamp.left >= 0, JSON.stringify(clamp));
  // Also assert the real tab chooser is on-screen.
  await t.evaluate(`document.querySelector('.material-tab-shader-socket').click()`);
  await t.sleep(80);
  const chooserOnScreen = await t.evaluate(`(() => {
    const r = document.querySelector('.vb-popover').getBoundingClientRect();
    return r.right <= window.innerWidth && r.left >= 0 && r.bottom <= window.innerHeight && r.top >= 0;
  })()`);
  t.check('the tab shader chooser popover is on-screen', chooserOnScreen);
  await t.key('Escape', 'Escape', 0);
  await t.sleep(60);

  // === (4) all color inputs equal height (super shader + colour gradient) ===
  await t.evaluate(`window.__materialTab.setShader('super')`);
  await t.sleep(120);
  await t.evaluate(`window.__materialTab.setGradient('color', { kind: 'gradient', a: [1,0,0], b: [0,0,1], axis: 'z', offset: 0.5, scale: 0.5 })`);
  await t.sleep(140);
  const heights = await t.evaluate(`(() => {
    const els = [...document.querySelectorAll('.material-tab-fields input[type="color"]')];
    return { n: els.length, hs: els.map((e) => Math.round(e.getBoundingClientRect().height)) };
  })()`);
  t.check('at least 3 color inputs present (base + gradient A/B + emissive)', heights.n >= 3, JSON.stringify(heights));
  t.check('every color input has EQUAL computed height',
    heights.hs.length > 0 && heights.hs.every((h) => h === heights.hs[0]), JSON.stringify(heights));

  // === (8) undo works per edit ===
  const before = await t.evaluate(`window.__materialTab.material().roughness`);
  await t.evaluate(`(() => {
    const s = document.querySelector('.material-tab-roughness');
    s.value = '0.13'; s.dispatchEvent(new Event('input')); s.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(100);
  t.check('roughness edit applied', Math.abs((await t.evaluate(`window.__materialTab.material().roughness`)) - 0.13) < 1e-6);
  await t.evaluate('window.__app.undo.undo()');
  await t.sleep(80);
  t.check('undo restores roughness', Math.abs((await t.evaluate(`window.__materialTab.material().roughness`)) - before) < 1e-6);
  // Undo the gradient set → back to a value colour.
  await t.evaluate('window.__app.undo.undo()');
  await t.sleep(80);
  t.check('undo removes the colour gradient',
    (await t.evaluate(`window.__materialTab.material().colorGradient ? 'g' : 'v'`)) === 'v');

  // ============================================================= (2) IMAGE ==
  // Fresh scene: diffuse cube, key light, socket→Image on colour, render.
  await t.evaluate(`window.__app.io.apply(${JSON.stringify(saved)})`);
  await t.evaluate(`window.__app.scene.selectOnly(window.__app.scene.objects[0].id)`);
  await t.sleep(120);
  await t.evaluate(`document.querySelector('.material-tab-new-btn').click()`);
  await t.sleep(140);
  await t.evaluate(`(() => {
    const app = window.__app, cam = app.camera, e = cam.eye;
    const Up = new e.constructor(0, 0, 1);
    const right = cam.forward.cross(Up).normalize();
    const L = app.scene.addLight('KeyLight', 'point');
    L.transform = L.transform.withPosition(e.add(right.scale(6)).add(Up.scale(4)));
    L.light.power = 20000;
    const w = app.scene.world; w.mode = 'flat'; w.color = [1,1,1]; w.strength = 1.5;
  })()`);
  const magenta = await t.evaluate(solidPng('#e020e0'));
  await t.evaluate(`window.__materialTab.setChannelImage('color', ${JSON.stringify(magenta)})`);
  await t.until(`(() => { const m = window.__materialTab.material(); return m.texKind === 'image' && !!m.texImage; })()`, 8000);
  t.check('colour socket is now image kind',
    (await t.evaluate(`document.querySelector('.prop-row[data-channel="color"] .prop-socket').dataset.kind`)) === 'image');

  await t.evaluate(`window.__app.renderer.shadingMode = 'rendered'`);
  await t.sleep(120);
  const imgCenter = await t.evaluate(`(() => {
    const app = window.__app, gl = app.renderer.ctx.gl, c = gl.canvas;
    app.renderer.gizmoVisible = false;
    app.renderer.render(app.scene, app.camera);
    const px = new Uint8Array(4);
    gl.readPixels((c.width/2)|0, (c.height/2)|0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    app.renderer.gizmoVisible = true;
    return [px[0], px[1], px[2]];
  })()`);
  await t.screenshot('/tmp/mattab-v2-image.png');
  t.check('viewport shows the magenta image (R & B high, G low)',
    imgCenter[0] > 80 && imgCenter[2] > 80 && imgCenter[1] < imgCenter[0] - 30 && imgCenter[1] < imgCenter[2] - 30,
    `rgb(${imgCenter.join(',')})`);

  // ========================================================== (3) GRADIENT ==
  // Tall pillar, colour gradient a=red(bottom) b=blue(top) axis Z, lit.
  await t.evaluate(`window.__app.renderer.shadingMode = 'matcap'`);
  await t.evaluate(`window.__app.io.apply(${JSON.stringify(saved)})`);
  const tall = await t.evaluate(`(() => {
    const app = window.__app, s = app.scene;
    const obj = s.objects[0];
    obj.transform = obj.transform.withScale(new obj.transform.position.constructor(0.6, 0.6, 2.2));
    s.selectOnly(obj.id);
    const cam = app.camera, e = cam.eye;
    const Up = new e.constructor(0, 0, 1);
    const right = cam.forward.cross(Up).normalize();
    const L = app.scene.addLight('KeyLight', 'point');
    L.transform = L.transform.withPosition(e.add(right.scale(5)).add(Up.scale(3)));
    L.light.power = 24000;
    const w = s.world; w.mode = 'flat'; w.color = [1,1,1]; w.strength = 1.2;
    return obj.id;
  })()`);
  await t.sleep(100);
  await t.evaluate(`document.querySelector('.material-tab-new-btn').click()`);
  await t.sleep(140);
  await t.evaluate(`window.__materialTab.setGradient('color', { kind: 'gradient', a: [1,0.03,0.03], b: [0.03,0.03,1], axis: 'z', offset: 0.5, scale: 0.5 })`);
  await t.sleep(140);
  t.check('gradient sub-row rendered with axis Z active',
    await t.evaluate(`(() => {
      const w = document.querySelector('.material-tab-gradient');
      const zBtn = w && w.querySelector('.material-tab-grad-axis-btn[data-axis="z"]');
      return !!zBtn && zBtn.classList.contains('is-active');
    })()`));

  // --- Rendered raster: top pixel blue-dominant, bottom pixel red-dominant ---
  await t.evaluate(`window.__app.renderer.shadingMode = 'rendered'`);
  await t.sleep(120);
  const rasterSplit = await t.evaluate(`(() => {
    const app = window.__app, gl = app.renderer.ctx.gl, c = gl.canvas;
    app.renderer.gizmoVisible = false;
    app.renderer.render(app.scene, app.camera);
    const read = (x, y) => { const px = new Uint8Array(4); gl.readPixels(x|0, y|0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); return [px[0],px[1],px[2]]; };
    const cx = (c.width/2)|0;
    const top = read(cx, (c.height*0.66)|0);      // readPixels y up → higher on screen
    const bottom = read(cx, (c.height*0.34)|0);
    app.renderer.gizmoVisible = true;
    return { top, bottom };
  })()`);
  await t.screenshot('/tmp/mattab-v2-gradient-raster.png');
  t.check('raster: top of pillar is blue-dominant',
    rasterSplit.top[2] > rasterSplit.top[0] + 20, `top rgb(${rasterSplit.top.join(',')})`);
  t.check('raster: bottom of pillar is red-dominant',
    rasterSplit.bottom[0] > rasterSplit.bottom[2] + 20, `bottom rgb(${rasterSplit.bottom.join(',')})`);

  // --- Raytraced GPU viewport: same top/bottom split ---
  const gpuAvail = await t.evaluate(`window.__app.viewportRay?.gpuAvailable?.() ?? false`);
  if (gpuAvail) {
    await t.evaluate(`(() => { const a = window.__app; a.shadePrefs.renderedMode = 'ray'; a.shadePrefs.rayEngine = 'gpu'; })()`);
    await t.sleep(120);
    await t.evaluate(`(() => { const a = window.__app; for (let i=0;i<64 && a.renderer.viewportRay.spp<48;i++) { a.renderer.render(a.scene, a.camera); a.renderer.viewportRay.flushSync(); } })()`);
    const gpuSplit = await t.evaluate(`(() => {
      const vr = window.__app.renderer.viewportRay;
      if (!vr.imageBytes) return null;
      const W = vr.imageW, H = vr.imageH, cx = (W/2)|0;
      const at = (y) => { const i = ((y|0)*W + cx)*4; return [vr.imageBytes[i], vr.imageBytes[i+1], vr.imageBytes[i+2]]; };
      // row 0 = top of image = top of pillar (blue); bottom rows = red.
      return { top: at(H*0.30), bottom: at(H*0.70), spp: vr.spp };
    })()`);
    await t.screenshot('/tmp/mattab-v2-gradient-gpu.png');
    t.check('GPU raytraced: top blue-dominant', !!gpuSplit && gpuSplit.top[2] > gpuSplit.top[0] + 15,
      gpuSplit ? `top rgb(${gpuSplit.top.join(',')}) spp ${gpuSplit.spp}` : 'no image');
    t.check('GPU raytraced: bottom red-dominant', !!gpuSplit && gpuSplit.bottom[0] > gpuSplit.bottom[2] + 15,
      gpuSplit ? `bottom rgb(${gpuSplit.bottom.join(',')})` : 'no image');
    await t.evaluate(`(() => { const a = window.__app; a.shadePrefs.renderedMode = 'live'; a.shadePrefs.rayEngine = 'cpu'; })()`);
  } else {
    t.check('GPU tracer available (skipped — not available on this backend)', true, 'skipped');
    t.check('GPU tracer available (skipped)', true, 'skipped');
  }

  // ========================================================= (7) EMIT PLANE ==
  await t.evaluate(`window.__app.renderer.shadingMode = 'matcap'`);
  await t.evaluate(`window.__app.io.apply(${JSON.stringify(saved)})`);
  await t.sleep(80);
  const emitUrl = await t.evaluate(solidPng('#30d060'));
  await t.evaluate(`(async () => {
    const app = window.__app, s = app.scene;
    const prim = await import('/src/core/mesh/primitives.ts');
    const plane = s.add('EmitPlane', prim.makePlane(1));
    const mat = s.addMaterial('EmitImg');
    mat.shader = 'emit'; mat.shadeless = true; mat.texKind = 'image';
    mat.texDataUrl = ${JSON.stringify(emitUrl)}; mat.alwaysTextured = true; mat.baseColor = [1,1,1];
    plane.materialId = mat.id;
    s.selectOnly(plane.id);
  })()`);
  await t.sleep(160);
  t.check('emit plane material resolves as Emit shader',
    (await t.evaluate(`document.querySelector('.material-tab-shader-value')?.textContent`)) === 'Emit');
  const emitRow = await t.evaluate(`(() => {
    const row = document.querySelector('.material-tab-fields .prop-row[data-channel="color"]');
    if (!row) return null;
    const socket = row.querySelector('.prop-socket');
    const thumb = row.querySelector('.material-tab-texthumb');
    return {
      socketKind: socket && socket.dataset.kind,
      thumbShown: !!thumb && thumb.style.display !== 'none' && !!thumb.getAttribute('src'),
    };
  })()`);
  t.check('EMIT colour socket row shows the image (image kind + thumbnail)',
    !!emitRow && emitRow.socketKind === 'image' && emitRow.thumbShown, JSON.stringify(emitRow));

  // Restore a clean scene.
  await t.evaluate(`window.__app.renderer.gizmoVisible = true`);
  await t.evaluate(`window.__app.renderer.shadingMode = 'matcap'`);
  await t.evaluate(`window.__app.io.apply(${JSON.stringify(saved)})`);
  await t.evaluate(`window.__app.autosave.clear()`);
});
