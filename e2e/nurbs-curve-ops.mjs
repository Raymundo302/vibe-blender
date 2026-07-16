/**
 * NURBS curve degree / spans / knot-insert operations e2e (NB-A4). Adds a NURBS
 * curve via the Shift+A menu, opens the N-panel, and drives the new Curve-section
 * operations through the REAL DOM controls:
 *   - Degree 3 → 4 (exact elevation): payload order becomes 5, the evaluated
 *     polyline is unchanged within tolerance.
 *   - Insert Knot (open-NURBS only): +1 control point, explicit `knots` present.
 *   - Rebuild to 12 points: control-point count is exactly 12.
 * Then Ctrl+Z steps back through each operation (one undo entry apiece).
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  await t.until('!!window.__app');

  // Load the pure evaluator once so we can read the evaluated polyline
  // synchronously (async import as a side effect, then poll for the global).
  await t.evaluate(`(async () => { window.__ev = await import('/src/core/curve/eval.ts'); })()`);
  await t.until('!!window.__ev');

  const cv = (fx, fy) => t.evaluate(`(() => {
    const r = document.querySelector('canvas').getBoundingClientRect();
    return [Math.round(r.left + r.width*${fx}), Math.round(r.top + r.height*${fy})];
  })()`);

  const curve = () => t.evaluate('window.__app.scene.activeObject && window.__app.scene.activeObject.curve');
  const pointCount = () => t.evaluate('window.__app.scene.activeObject.curve.points.length');
  const order = () => t.evaluate('window.__app.scene.activeObject.curve.order');
  const hasKnots = () => t.evaluate('(() => { const k = window.__app.scene.activeObject.curve.knots; return Array.isArray(k) && k.length > 0; })()');
  const polyline = () => t.evaluate('window.__ev.evaluateCurve(window.__app.scene.activeObject.curve).map(p => [p.x, p.y, p.z])');

  // Add a Shift+A ▸ Curve ▸ NURBS via the real menu path.
  const addNurbs = async () => {
    const [mx, my] = await cv(0.5, 0.5);
    await t.mouse('mouseMoved', mx, my);
    await t.key('A', 'KeyA', 8); // shift
    await t.sleep(60);
    await t.evaluate(`(() => {
      const cat = document.querySelector('.add-menu-category[data-category="Curve"]');
      cat.click();
      const item = [...document.querySelectorAll('.add-menu-flyout .add-menu-item')].find(b => b.textContent === 'NURBS');
      item.click();
    })()`);
    await t.sleep(80);
  };

  // Worst nearest-point distance from polyline A to the segments of polyline B.
  const maxDist = (a, b) => {
    let worst = 0;
    for (const p of a) {
      let best = Infinity;
      for (let i = 1; i < b.length; i++) {
        const s0 = b[i - 1], s1 = b[i];
        const dx = s1[0] - s0[0], dy = s1[1] - s0[1], dz = s1[2] - s0[2];
        const l2 = dx*dx + dy*dy + dz*dz;
        let tt = l2 < 1e-30 ? 0 : ((p[0]-s0[0])*dx + (p[1]-s0[1])*dy + (p[2]-s0[2])*dz) / l2;
        tt = Math.max(0, Math.min(1, tt));
        const qx = s0[0]+dx*tt, qy = s0[1]+dy*tt, qz = s0[2]+dz*tt;
        const d = Math.hypot(p[0]-qx, p[1]-qy, p[2]-qz);
        if (d < best) best = d;
      }
      if (best > worst) worst = best;
    }
    return worst;
  };

  // Clean slate: drop the default cube, dismiss the splash.
  await t.evaluate(`(() => { const S = window.__app.scene; for (const o of [...S.objects]) S.remove(o.id); })()`);
  await t.key('Escape', 'Escape');

  // --- Add a NURBS curve -----------------------------------------------------
  await addNurbs();
  t.check('NURBS curve added and active', (await t.evaluate('window.__app.scene.activeObject.kind')) === 'curve');
  t.check('added curve is NURBS', (await curve()).kind === 'nurbs');
  const p0 = await pointCount();
  t.check('NURBS preset has 5 control points', p0 === 5);
  t.check('preset order is 4 (degree 3)', (await order()) === 4);

  // --- Open the N-panel so the Curve-section controls are in the DOM ---------
  await t.key('n', 'KeyN');
  await t.sleep(80);
  t.check('Degree field shows 3', (await t.evaluate(`document.querySelector('input[data-field="curve-degree"]').value`)) === '3');
  t.check('Knots read-out is present',
    /knots:\s*\d+\s*\(spans:\s*\d+\)/.test(await t.evaluate(`document.querySelector('span[data-field="curve-knots"]').textContent`)));

  // --- Degree 3 → 4 (exact elevation) ----------------------------------------
  const before = await polyline();
  await t.evaluate(`(() => {
    const el = document.querySelector('input[data-field="curve-degree"]');
    el.value = '4';
    el.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(40);
  t.check('degree change bumps payload order to 5', (await order()) === 5);
  const pAfterDeg = await pointCount();
  t.check('elevation adds control points', pAfterDeg > p0);
  const after = await polyline();
  const d1 = maxDist(after, before);
  const d2 = maxDist(before, after);
  t.check('polyline unchanged by degree elevation (within tolerance)',
    d1 < 1e-4 && d2 < 1e-4, `d=${Math.max(d1, d2).toExponential(2)}`);

  // --- Insert Knot (open NURBS only) -----------------------------------------
  t.check('Insert Knot button is enabled for open NURBS',
    (await t.evaluate(`!document.querySelector('button[data-action="curve-insert-knot"]').disabled`)));
  await t.evaluate(`document.querySelector('button[data-action="curve-insert-knot"]').click()`);
  await t.sleep(40);
  t.check('Insert Knot adds one control point', (await pointCount()) === pAfterDeg + 1);
  t.check('inserted curve carries explicit knots', (await hasKnots()) === true);
  const pAfterInsert = await pointCount();

  // --- Rebuild to 12 points --------------------------------------------------
  await t.evaluate(`(() => {
    const cnt = document.querySelector('input[data-field="curve-rebuild-count"]');
    cnt.value = '12';
    cnt.dispatchEvent(new Event('change'));
    document.querySelector('button[data-action="curve-rebuild"]').click();
  })()`);
  await t.sleep(40);
  t.check('Rebuild produces exactly 12 control points', (await pointCount()) === 12);

  // --- Undo steps back through each operation --------------------------------
  await t.key('z', 'KeyZ', 2); // ctrl+z — undo Rebuild
  await t.sleep(80);
  t.check('undo #1 restores the post-insert count', (await pointCount()) === pAfterInsert);
  await t.key('z', 'KeyZ', 2); // undo Insert Knot
  await t.sleep(80);
  t.check('undo #2 restores the post-degree count', (await pointCount()) === pAfterDeg);
  await t.key('z', 'KeyZ', 2); // undo Degree
  await t.sleep(80);
  t.check('undo #3 restores the original 5-point order-4 preset',
    (await pointCount()) === p0 && (await order()) === 4);
});
