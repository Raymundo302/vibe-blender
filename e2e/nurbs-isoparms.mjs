/**
 * NURBS isoparm display + adaptive-tess e2e (NB-B3).
 *   (1) Add a rational sphere surface, open the Surface tab, turn on Show Net,
 *       then toggle the new "Isoparms" checkbox → a whole-canvas pixel diff
 *       between the isoparms-off and isoparms-on captures shows the grey-cyan
 *       isoparametric curves appearing (saved to research/nurbs-isoparms-*.png).
 *   (2) Switch Tessellation from spans-at-the-floor to adaptive → __app face
 *       count grows (adaptive refines the sphere's curvature).
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  const id = () => 'window.__app.scene.get(window.__nsurf)';
  const faceCount = () => t.evaluate(`${id()}.mesh.faces.size`);

  const setField = (field, value) => t.evaluate(`(() => {
    const el = document.querySelector('.surface-tab-input[data-field="${field}"]');
    el.value = '${value}';
    el.dispatchEvent(new Event('change'));
  })()`);

  const setSelect = (field, value) => t.evaluate(`(() => {
    const el = document.querySelector('.surface-tab-select[data-field="${field}"]');
    el.value = '${value}';
    el.dispatchEvent(new Event('change'));
  })()`);

  const setCheck = (field, on) => t.evaluate(`(() => {
    const el = document.querySelector('input[data-field="${field}"]');
    el.checked = ${on};
    el.dispatchEvent(new Event('change'));
    return !!el;
  })()`);

  // Render one frame and return a cyan-ish (isoparm-colored) pixel count over the
  // whole canvas; also stash the raw buffer on window for a later pixel diff.
  // Isoparm color is grey-cyan (B>R, G>R); the neutral grey control net (R≈G≈B)
  // and the matcap sphere are excluded by the channel-margin test.
  const captureCyan = (stashKey) => t.evaluate(`(() => {
    const app = window.__app, gl = app.renderer.ctx.gl, c = gl.canvas;
    app.renderer.render(app.scene, app.camera);
    const buf = new Uint8Array(c.width * c.height * 4);
    gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    window['${stashKey}'] = buf;
    let n = 0;
    for (let i = 0; i < buf.length; i += 4) {
      if (buf[i + 2] - buf[i] > 25 && buf[i + 1] - buf[i] > 12) n++;
    }
    return n;
  })()`);

  // Diff the two stashed buffers: total pixels changed, and how many of those
  // changed pixels are cyan-ish in the "on" buffer (⇒ isoparm lines, not noise).
  const diffBuffers = (offKey, onKey) => t.evaluate(`(() => {
    const a = window['${offKey}'], b = window['${onKey}'];
    let changed = 0, cyanChanged = 0;
    for (let i = 0; i < a.length; i += 4) {
      const d = Math.abs(a[i]-b[i]) + Math.abs(a[i+1]-b[i+1]) + Math.abs(a[i+2]-b[i+2]);
      if (d > 30) {
        changed++;
        if (b[i+2] - b[i] > 25 && b[i+1] - b[i] > 12) cyanChanged++;
      }
    }
    return { changed, cyanChanged };
  })()`);

  // ===== Clean slate + add a rational sphere surface =========================
  await t.evaluate(`(() => { const S = window.__app.scene; for (const o of [...S.objects]) S.remove(o.id); })()`);
  await t.key('Escape', 'Escape'); // dismiss splash

  await t.evaluate(`(async () => {
    const S = window.__app.scene;
    const prim = await import('/src/core/nurbs/primitives.ts');
    const o = S.addSurface('NSphere', prim.surfSphere(1));
    S.selectOnly(o.id);
    window.__nsurf = o.id;
    window.__app.surface.sync();
  })()`);
  await t.until(`window.__app.scene.objects.some(o=>o.kind==='surface')`);
  await t.evaluate('window.__app.surface.sync()');
  t.check('sphere surface added + tessellated',
    (await t.evaluate(`${id()}.mesh.verts.size`)) > 0);

  // ===== Open the Surface tab, turn on Show Net ==============================
  await t.evaluate(`document.querySelector('.properties-tab-btn[data-tab="surface"]').click()`);
  await t.sleep(150);
  t.check('Isoparms checkbox exists in the Display section',
    await t.evaluate(`!!document.querySelector('input[data-field="show-isoparms"]')`));

  await setCheck('show-net', true); // net pass runs in object mode for this object
  await t.sleep(60);

  // ===== (1) Isoparms OFF → ON pixel diff ====================================
  const cyanOff = await captureCyan('__isoOff');
  await t.screenshot('research/nurbs-isoparms-off.png');

  await setCheck('show-isoparms', true);
  await t.sleep(60);
  const cyanOn = await captureCyan('__isoOn');
  await t.screenshot('research/nurbs-isoparms-on.png');

  const diff = await diffBuffers('__isoOff', '__isoOn');
  t.check('toggling Isoparms adds grey-cyan iso pixels', cyanOn > cyanOff + 200,
    `cyan off=${cyanOff} on=${cyanOn}`);
  t.check('pixel diff shows the iso lines (many changed pixels)', diff.changed > 200,
    `changed=${diff.changed}`);
  t.check('the changed pixels are the cyan isoparm lines', diff.cyanChanged > diff.changed * 0.4,
    `cyanChanged=${diff.cyanChanged} / changed=${diff.changed}`);

  // Toggle back off → cyan count returns near the off baseline (pref really drives it).
  await setCheck('show-isoparms', false);
  await t.sleep(60);
  const cyanBack = await captureCyan('__isoBack');
  t.check('turning Isoparms back off removes the iso pixels', cyanBack < cyanOff + 200,
    `back=${cyanBack} vs off=${cyanOff}`);

  // ===== (2) Adaptive yields more faces than spans-floor =====================
  await setSelect('tess-mode', 'spans');
  await setField('segs-u', 1);
  await setField('segs-v', 1);
  await t.evaluate('window.__app.surface.sync()');
  const spansFloorFaces = await faceCount();

  await setSelect('tess-mode', 'adaptive');
  await setField('segs-u', 1);
  await setField('segs-v', 1);
  await setField('tol', 0.01);
  await t.evaluate('window.__app.surface.sync()');
  const adaptiveFaces = await faceCount();

  t.check('adaptive tessellation yields more faces than the spans floor',
    adaptiveFaces > spansFloorFaces, `spansFloor=${spansFloorFaces} adaptive=${adaptiveFaces}`);
});
