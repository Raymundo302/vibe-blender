/**
 * Curve objects e2e (UR11-1). Covers: adding each Shift+A ▸ Curve preset, the
 * evaluated polyline drawing pixels, click-the-line object select, Tab → curve
 * edit with control points, G moving a point (polyline follows) + one-undo
 * revert, Ctrl+click append, X delete, cyclic-toggle closing the loop, a
 * save→load round trip, and that Tab on a cube is still MESH edit (regression).
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  const rect = await t.evaluate('(() => { const r = document.querySelector("canvas").getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()');
  const cv = (fx, fy) => [Math.round(rect.x + rect.w * fx), Math.round(rect.y + rect.h * fy)];

  const curveCount = () => t.evaluate(`window.__app.scene.objects.filter(o => o.kind === 'curve').length`);
  const activeKind = () => t.evaluate(`window.__app.scene.activeObject ? window.__app.scene.activeObject.kind : null`);
  const editing = () => t.evaluate('window.__app.curve.editing()');
  const pointCount = () => t.evaluate('window.__app.curve.pointCount()');

  // Force a render and count "curve-ish" pixels in an S×S region around a world
  // point: pixels that differ strongly from a corner background sample. Curves
  // draw as bright ribbons (orange when selected, grey otherwise) over the dark
  // viewport, so a non-empty count = the polyline crosses that region.
  const regionAt = (wx, wy, wz, s = 17) => t.evaluate(`(() => {
    const app = window.__app, gl = app.renderer.ctx.gl, c = gl.canvas;
    app.renderer.render(app.scene, app.camera);
    const vp = app.renderer.currentViewProj(app.scene, app.camera).m;
    const cx = vp[0]*${wx} + vp[4]*${wy} + vp[8]*${wz} + vp[12];
    const cy = vp[1]*${wx} + vp[5]*${wy} + vp[9]*${wz} + vp[13];
    const cw = vp[3]*${wx} + vp[7]*${wy} + vp[11]*${wz} + vp[15];
    const px = Math.round((cx/cw*0.5+0.5) * c.width);
    const py = Math.round((cy/cw*0.5+0.5) * c.height);
    const bg = new Uint8Array(4);
    gl.readPixels(2, 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, bg);
    const half = (${s}-1)/2;
    const x0 = Math.max(0, Math.min(px-half, c.width-${s}));
    const y0 = Math.max(0, Math.min(py-half, c.height-${s}));
    const buf = new Uint8Array(${s}*${s}*4);
    gl.readPixels(x0, y0, ${s}, ${s}, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    // The selected curve draws ORANGE (high R, R>G>B) — distinct from the faint
    // neutral-grey grid lines (R≈G≈B) and the dark background, so the probe
    // measures the curve, not the grid.
    let n = 0;
    for (let i = 0; i < buf.length; i += 4) {
      if (buf[i] > 100 && (buf[i] - buf[i+2]) > 45 && (buf[i] - buf[i+1]) > 8) n++;
    }
    return n;
  })()`);

  // Like regionAt but counts ANY strongly-non-background pixel (matcap tube is
  // bright neutral grey, not orange) in an S×S region around a world point —
  // used to measure the Pipe tube's silhouette vs the thin bare polyline.
  const solidRegionAt = (wx, wy, wz, s = 25) => t.evaluate(`(() => {
    const app = window.__app, gl = app.renderer.ctx.gl, c = gl.canvas;
    app.renderer.render(app.scene, app.camera);
    const vp = app.renderer.currentViewProj(app.scene, app.camera).m;
    const cx = vp[0]*${wx} + vp[4]*${wy} + vp[8]*${wz} + vp[12];
    const cy = vp[1]*${wx} + vp[5]*${wy} + vp[9]*${wz} + vp[13];
    const cw = vp[3]*${wx} + vp[7]*${wy} + vp[11]*${wz} + vp[15];
    const px = Math.round((cx/cw*0.5+0.5) * c.width);
    const py = Math.round((cy/cw*0.5+0.5) * c.height);
    const bg = new Uint8Array(4);
    gl.readPixels(2, 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, bg);
    const bgL = bg[0]+bg[1]+bg[2];
    const half = (${s}-1)/2;
    const x0 = Math.max(0, Math.min(px-half, c.width-${s}));
    const y0 = Math.max(0, Math.min(py-half, c.height-${s}));
    const buf = new Uint8Array(${s}*${s}*4);
    gl.readPixels(x0, y0, ${s}, ${s}, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    // The matcap tube is bright (~150+ per channel) — well above the dark
    // background and the faint grid; threshold on total-luminance difference.
    let n = 0;
    for (let i = 0; i < buf.length; i += 4) {
      if ((buf[i]+buf[i+1]+buf[i+2]) - bgL > 150) n++;
    }
    return n;
  })()`);

  const evalFaceCount = (name) => t.evaluate(`(() => {
    const S = window.__app.scene, o = S.objects.find(x => x.name === '${name}');
    if (!o) return -1;
    return o.evaluatedMesh(S.modifierContext(o)).faces.size;
  })()`);

  // Count open-boundary edges of a curve's evaluated tube (0 = watertight: caps
  // closed, or cyclic seam welded).
  const evalBoundaryEdges = (name) => t.evaluate(`(() => {
    const S = window.__app.scene, o = S.objects.find(x => x.name === '${name}');
    if (!o) return -1;
    const m = o.evaluatedMesh(S.modifierContext(o));
    let n = 0;
    for (const e of m.edges().values()) if (e.faces.length === 1) n++;
    return n;
  })()`);

  // Add a modifier to the active object through the real Modifiers-tab UI.
  const addModifierUI = async (type) => {
    await t.evaluate(`document.querySelector('.properties-tab-btn[data-tab="modifier"]').click()`);
    await t.sleep(120);
    await t.evaluate(`(() => {
      const sel = document.querySelector('.modifier-add-select');
      sel.value = '${type}';
      sel.dispatchEvent(new Event('change'));
    })()`);
    await t.sleep(140);
  };

  const setModParam = (key, val) => t.evaluate(`(() => {
    const el = document.querySelector('.modifier-param[data-key="${key}"]');
    el.value = String(${JSON.stringify(val)}); el.dispatchEvent(new Event('change'));
  })()`);

  // Project a curve-local point to page (CSS) coords for clicking (curves spawn
  // at the cursor with identity transform, so local == world).
  const projectPage = (wx, wy, wz) => t.evaluate(`(() => {
    const app = window.__app, c = app.renderer.ctx.gl.canvas;
    const r = document.querySelector('canvas').getBoundingClientRect();
    const vp = app.renderer.currentViewProj(app.scene, app.camera).m;
    const cx = vp[0]*${wx} + vp[4]*${wy} + vp[8]*${wz} + vp[12];
    const cy = vp[1]*${wx} + vp[5]*${wy} + vp[9]*${wz} + vp[13];
    const cw = vp[3]*${wx} + vp[7]*${wy} + vp[11]*${wz} + vp[15];
    return { x: r.left + (cx/cw*0.5+0.5) * r.width, y: r.top + (1-(cy/cw*0.5+0.5)) * r.height };
  })()`);

  // Add a Shift+A ▸ Curve preset via the real menu path.
  const addPreset = async (label) => {
    const [mx, my] = cv(0.5, 0.5);
    await t.mouse('mouseMoved', mx, my);
    await t.key('A', 'KeyA', 8); // shift
    await t.sleep(60);
    await t.evaluate(`(() => {
      const cat = document.querySelector('.add-menu-category[data-category="Curve"]');
      cat.click();
      const item = [...document.querySelectorAll('.add-menu-flyout .add-menu-item')].find(b => b.textContent === '${label}');
      item.click();
    })()`);
    await t.sleep(80);
  };

  // Clean slate: drop the default cube so curves stand alone for the pixel/pick
  // checks (kept independent of the boot scene).
  await t.evaluate(`(() => { const S = window.__app.scene; for (const o of [...S.objects]) S.remove(o.id); })()`);
  await t.key('Escape', 'Escape'); // dismiss splash

  // --- Add each preset; polyline pixels present ------------------------------
  await addPreset('Bezier');
  t.check('Bezier preset added a curve object', (await curveCount()) === 1);
  t.check('added curve is active', (await activeKind()) === 'curve');
  t.check('Bezier polyline draws pixels', (await regionAt(0, 0, 0)) > 0);

  await addPreset('Circle');
  t.check('Circle preset added a second curve', (await curveCount()) === 2);
  // Circle passes through (0,1,0) but not (0,0,0) — probe a rim point.
  t.check('Circle polyline draws pixels at its rim', (await regionAt(0, 1, 0)) > 0);

  await addPreset('NURBS');
  t.check('NURBS preset added a third curve', (await curveCount()) === 3);
  t.check('NURBS polyline draws pixels', (await regionAt(0, 0, 0)) > 0);

  // Keep only the Bezier for the interaction checks (remove circle + nurbs).
  await t.evaluate(`(() => {
    const S = window.__app.scene;
    const keep = S.objects.find(o => o.name === 'BezierCurve');
    for (const o of [...S.objects]) if (o !== keep) S.remove(o.id);
    S.selectOnly(keep.id);
  })()`);
  t.check('one bezier curve remains', (await curveCount()) === 1);

  // --- Click the line selects the object -------------------------------------
  await t.evaluate('window.__app.scene.deselectAll()');
  // A point on the bezier's left anchor (-1,0,0) is on the line.
  const onLine = await projectPage(-1, 0, 0);
  await t.click(onLine.x, onLine.y);
  t.check('clicking the curve line selects the object', (await activeKind()) === 'curve');

  // --- Tab → curve edit, control points visible ------------------------------
  await t.key('Tab', 'Tab');
  t.check('Tab enters curve edit (not mesh edit)', (await editing()) === true
    && (await t.evaluate('window.__app.scene.editMode === null')));
  t.check('curve has control points', (await pointCount()) === 2);
  // The control-point overlay draws an orange dot at the anchor.
  t.check('control point draws overlay pixels', (await regionAt(-1, 0, 0)) > 0);

  // --- G moves a point; polyline follows; one undo reverts -------------------
  const co0Before = await t.evaluate('window.__app.curve.pointCo(0)');
  await t.evaluate('window.__app.curve.selectPoint(0)');
  const anchorPage = await projectPage(-1, 0, 0);
  await t.mouse('mouseMoved', anchorPage.x, anchorPage.y); // seat the cursor
  await t.sleep(30);
  await t.key('g', 'KeyG');
  await t.sleep(40);
  t.check('G starts a curve Move', (await t.evaluate('window.__app.input.activeOperatorName')) === 'Move');
  await t.mouse('mouseMoved', anchorPage.x, anchorPage.y - 90); // drag up
  await t.sleep(40);
  await t.mouse('mouseMoved', anchorPage.x, anchorPage.y - 90);
  await t.sleep(40);
  await t.mouse('mousePressed', anchorPage.x, anchorPage.y - 90, 'left');
  await t.mouse('mouseReleased', anchorPage.x, anchorPage.y - 90, 'left');
  await t.sleep(100);
  const co0After = await t.evaluate('window.__app.curve.pointCo(0)');
  t.check('G moved control point 0', JSON.stringify(co0After) !== JSON.stringify(co0Before));
  t.check('polyline follows the moved anchor',
    (await regionAt(co0After[0], co0After[1], co0After[2])) > 0);
  await t.key('z', 'KeyZ', 2); // ctrl+z
  await t.sleep(80);
  const co0Undo = await t.evaluate('window.__app.curve.pointCo(0)');
  t.check('one undo reverts the move', JSON.stringify(co0Undo) === JSON.stringify(co0Before));

  // --- Ctrl+click appends a point --------------------------------------------
  const [ax, ay] = cv(0.62, 0.62);
  await t.mouse('mouseMoved', ax, ay);
  await t.click(ax, ay, 'left', 2); // ctrl
  t.check('Ctrl+click appended a control point', (await pointCount()) === 3);

  // Eyes-on: an edited bezier in curve edit with handles visible. Select all
  // points so the anchors + handles show their orange selection tint.
  await t.key('a', 'KeyA');
  await t.sleep(60);
  await t.evaluate('window.__app.renderer.render(window.__app.scene, window.__app.camera)');
  await t.screenshot('research/ur11-curve-edit.png');

  // --- X deletes selected points ---------------------------------------------
  await t.evaluate('window.__app.curve.selectPoint(2)');
  await t.key('x', 'KeyX');
  t.check('X deleted the selected control point', (await pointCount()) === 2);

  // --- Cyclic toggle closes the loop (probe pixels near the gap) -------------
  await t.key('Tab', 'Tab'); // exit curve edit
  await t.sleep(60);
  // Build a controlled open half-circle whose closing (bottom) segment passes
  // near (0,-1,0): three of the circle's four points, open.
  await t.evaluate(`(() => {
    const S = window.__app.scene;
    for (const o of [...S.objects]) S.remove(o.id);
    const k = 0.5522847498;
    const c = S.addCurve('Arc', { kind: 'bezier', cyclic: false, resolution: 16, points: [
      { co: [1,0,0], hl: [1,-k,0], hr: [1,k,0] },
      { co: [0,1,0], hl: [k,1,0], hr: [-k,1,0] },
      { co: [-1,0,0], hl: [-1,k,0], hr: [-1,-k,0] },
    ]});
    S.selectOnly(c.id);
  })()`);
  const gapBefore = await regionAt(0, -0.4, 0);
  t.check('open arc has NO pixels at the gap (0,-0.4,0)', gapBefore === 0);
  // Toggle cyclic through the real N-panel checkbox.
  await t.key('n', 'KeyN'); // open the N-panel so its checkbox is in the DOM
  await t.sleep(80);
  await t.evaluate(`(() => {
    const cb = document.querySelector('input[data-action="curve-cyclic"]');
    cb.checked = true;
    cb.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(80);
  t.check('cyclic is now on', (await t.evaluate('window.__app.curve.cyclic()')) === true);
  const gapAfter = await regionAt(0, -0.4, 0);
  t.check('cyclic toggle closes the loop (pixels at the gap now)', gapAfter > 0);
  await t.key('n', 'KeyN'); // close N-panel

  // --- Save → load round trip ------------------------------------------------
  const s1 = await t.evaluate('window.__app.io.serialize()');
  await t.evaluate(`window.__app.io.apply(${JSON.stringify(s1)})`);
  const s2 = await t.evaluate('window.__app.io.serialize()');
  t.check('save→load round-trips byte-identically', s1 === s2);
  t.check('curve survives the round trip', (await curveCount()) === 1);

  // --- Regression: Tab on a cube is still MESH edit --------------------------
  await t.evaluate(`(async () => {
    const S = window.__app.scene;
    for (const o of [...S.objects]) S.remove(o.id);
    const prim = await import('/src/core/mesh/primitives.ts');
    const cube = S.add('Cube', prim.makeCube());
    S.selectOnly(cube.id);
  })()`);
  t.check('cube ready', await t.until(`window.__app.scene.objects.some(o => o.name === 'Cube')`));
  await t.key('Tab', 'Tab');
  t.check('Tab on a cube enters MESH edit (not curve edit)',
    (await t.evaluate('window.__app.scene.mode')) === 'edit'
    && (await editing()) === false);
  await t.key('Tab', 'Tab');

  await t.screenshot('research/ur11-curves.png');

  // ======================= UR11-2 — PIPE MODIFIER ==========================
  // Fresh scene: a gentle S-curve bezier in the XY plane, matcap shading.
  await t.evaluate(`(() => {
    const S = window.__app.scene;
    for (const o of [...S.objects]) S.remove(o.id);
    const c = S.addCurve('SPipe', { kind: 'bezier', cyclic: false, resolution: 20, points: [
      { co: [-1.6, -0.6, 0], hr: [-0.6, 0.8, 0] },
      { co: [0, 0, 0], hl: [-0.9, 0.2, 0], hr: [0.9, -0.2, 0] },
      { co: [1.6, 0.6, 0], hl: [0.6, -0.8, 0] },
    ]});
    S.selectOnly(c.id);
    window.__app.scene.deselectAll(); S.selectOnly(c.id);
  })()`);
  await t.sleep(60);

  // (1) Bezier + Pipe → tube visible where the bare polyline was thin.
  const bareCore = await solidRegionAt(0, 0, 0, 31);
  await addModifierUI('pipe');
  await setModParam('radius', 0.22);
  await setModParam('sides', 20);
  await t.sleep(120);
  t.check('Pipe modifier added to the curve',
    (await t.evaluate(`window.__app.scene.activeObject.modifiers[0]?.type`)) === 'pipe');
  t.check('curve now materializes a tube mesh', (await evalFaceCount('SPipe')) > 0);
  const tubeCore = await solidRegionAt(0, 0, 0, 31);
  t.check('Pipe tube is visible in matcap where the polyline was thin',
    tubeCore > bareCore + 20, `bare=${bareCore} tube=${tubeCore}`);

  // (3) Radius field change → silhouette widens (probe grows).
  const narrow = await solidRegionAt(0, 0, 0, 51);
  await setModParam('radius', 0.5);
  await t.sleep(120);
  const wide = await solidRegionAt(0, 0, 0, 51);
  t.check('increasing radius widens the tube silhouette',
    wide > narrow + 30, `narrow=${narrow} wide=${wide}`);
  await setModParam('radius', 0.22);
  await t.sleep(80);

  // (2) Move a control point in curve edit → the tube follows live.
  await t.evaluate('window.__app.scene.deselectAll(); window.__app.scene.selectOnly(window.__app.scene.objects.find(o=>o.name==="SPipe").id)');
  await t.key('Tab', 'Tab'); // enter curve edit
  await t.sleep(60);
  t.check('Tab enters curve edit on the piped curve', (await editing()) === true);
  const farBefore = await solidRegionAt(0, 2.2, 0, 25); // empty above the curve
  // Move the middle anchor far up — depVersion keys on the curve payload, so the
  // tube re-evaluates live with no modifier-version bump.
  await t.evaluate(`(() => {
    const o = window.__app.scene.objects.find(x => x.name === 'SPipe');
    o.curve.points[1].co = [0, 2.2, 0];
  })()`);
  await t.sleep(80);
  const farAfter = await solidRegionAt(0, 2.2, 0, 25);
  t.check('moving a control point makes the tube follow live',
    farAfter > farBefore + 20, `before=${farBefore} after=${farAfter}`);
  // Revert the move back to the S-curve.
  await t.evaluate(`(() => {
    const o = window.__app.scene.objects.find(x => x.name === 'SPipe');
    o.curve.points[1].co = [0, 0, 0];
  })()`);
  await t.key('Tab', 'Tab'); // exit curve edit
  await t.sleep(60);

  // Eyes-on: a tapered pipe along the S-curve, matcap.
  await setModParam('radiusEnd', 0.03);
  await t.sleep(120);
  await t.evaluate('window.__app.renderer.render(window.__app.scene, window.__app.camera)');
  await t.screenshot('research/ur11-pipe-taper.png');
  await setModParam('radiusEnd', 0.22);
  await t.sleep(60);

  // (4) Cyclic circle + Pipe = donut-like ring, welded seam, no cap artifacts.
  await t.evaluate(`(() => {
    const S = window.__app.scene;
    for (const o of [...S.objects]) S.remove(o.id);
    const k = 0.5522847498;
    const c = S.addCurve('Ring', { kind: 'bezier', cyclic: true, resolution: 16, points: [
      { co: [1,0,0], hl: [1,-k,0], hr: [1,k,0] },
      { co: [0,1,0], hl: [k,1,0], hr: [-k,1,0] },
      { co: [-1,0,0], hl: [-1,k,0], hr: [-1,-k,0] },
      { co: [0,-1,0], hl: [-k,-1,0], hr: [k,-1,0] },
    ]});
    S.selectOnly(c.id);
  })()`);
  await addModifierUI('pipe');
  await setModParam('radius', 0.18);
  await setModParam('sides', 16);
  await t.sleep(120);
  t.check('cyclic curve + Pipe makes a tube mesh', (await evalFaceCount('Ring')) > 0);
  t.check('cyclic tube is watertight (welded seam, no caps)',
    (await evalBoundaryEdges('Ring')) === 0);
  t.check('donut ring draws matcap pixels at its rim', (await solidRegionAt(1, 0, 0, 25)) > 0);
  await t.screenshot('research/ur11-pipe-ring.png');

  // (5) Apply → mesh object editable in mesh edit mode; one undo restores it.
  await t.evaluate('window.__app.scene.deselectAll(); window.__app.scene.selectOnly(window.__app.scene.objects.find(o=>o.name==="Ring").id)');
  await t.evaluate(`document.querySelector('.properties-tab-btn[data-tab="modifier"]').click()`);
  await t.sleep(120);
  t.check('Apply button is enabled for the curve Pipe',
    (await t.evaluate(`(() => { const b = document.querySelector('.modifier-apply'); return !!b && !b.disabled; })()`)));
  await t.evaluate(`document.querySelector('.modifier-apply').click()`);
  await t.sleep(140);
  t.check('Apply converts the curve to a MESH object',
    (await t.evaluate(`window.__app.scene.objects.find(o=>o.name==="Ring")?.kind`)) === 'mesh');
  t.check('baked mesh carries the tube geometry',
    (await t.evaluate(`window.__app.scene.objects.find(o=>o.name==="Ring").mesh.faces.size`)) > 0);
  t.check('baked object dropped its curve payload + Pipe',
    (await t.evaluate(`(() => { const o = window.__app.scene.objects.find(x=>x.name==="Ring"); return !o.curve && o.modifiers.length === 0; })()`)));
  await t.key('Tab', 'Tab');
  t.check('baked mesh opens in MESH edit mode',
    (await t.evaluate('window.__app.scene.mode')) === 'edit' && (await editing()) === false);
  await t.key('Tab', 'Tab');
  await t.sleep(40);
  await t.key('z', 'KeyZ', 2); // ctrl+z
  await t.sleep(120);
  t.check('one undo restores the curve + Pipe modifier',
    (await t.evaluate(`(() => { const o = window.__app.scene.objects.find(x=>x.name==="Ring"); return o && o.kind==='curve' && !!o.curve && o.modifiers[0]?.type==='pipe'; })()`)));

  // (6) Tracer (F12 path) renders the tube: pipe-on frame differs from pipe-off.
  await t.evaluate('window.__app.scene.deselectAll(); window.__app.scene.selectOnly(window.__app.scene.objects.find(o=>o.name==="Ring").id)');
  const readTrace = () => t.evaluate(`(() => {
    const cv = window.__renderEngine.canvas();
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    const out = []; for (let i = 0; i < d.length; i += 16) out.push(d[i], d[i+1], d[i+2]);
    return out;
  })()`);
  await t.evaluate('window.__renderEngine.start()');
  const okOn = await t.until('window.__renderEngine.sample() >= 6', 40000);
  t.check('tracer accumulates samples with the tube', okOn);
  const traceOn = await readTrace();
  await t.evaluate('window.__renderEngine.close()');
  await t.sleep(150);
  // Disable the Pipe → empty scene (just the world) and render again.
  await t.evaluate(`(() => { const o = window.__app.scene.objects.find(x=>x.name==="Ring"); o.modifiers[0].enabled = false; o.modifiersVersion++; })()`);
  await t.evaluate('window.__renderEngine.start()');
  const okOff = await t.until('window.__renderEngine.sample() >= 6', 40000);
  t.check('tracer accumulates samples without the tube', okOff);
  const traceOff = await readTrace();
  await t.evaluate('window.__renderEngine.close()');
  // The tracer RNG is frame-seeded, so regions with identical geometry render
  // bit-identically between the two passes — every pixel that differs is the
  // tube's silhouette. (The unlit test scene keeps the tube's contrast vs the
  // sky modest, so threshold on the summed channel diff, not a single channel.)
  let tubePx = 0, nn = Math.min(traceOn.length, traceOff.length);
  for (let i = 0; i + 2 < nn; i += 3) {
    const dd = Math.abs(traceOn[i] - traceOff[i]) + Math.abs(traceOn[i + 1] - traceOff[i + 1])
      + Math.abs(traceOn[i + 2] - traceOff[i + 2]);
    if (dd > 12) tubePx++;
  }
  t.check('tracer renders the tube (pipe-on silhouette differs from pipe-off)',
    tubePx > 300, `tubeSilhouetteSamples=${tubePx}`);
  await t.evaluate(`(() => { const o = window.__app.scene.objects.find(x=>x.name==="Ring"); o.modifiers[0].enabled = true; o.modifiersVersion++; })()`);
});
