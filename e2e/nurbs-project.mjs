/**
 * Curve→surface projection UI e2e (NB-C2 glue). Drives the Surface tab's
 * Project row: a bumpy patch + a straight NURBS curve hovering above it,
 * Project Curve (Closest) → a new "Proj.NNN" surface curve lands on the
 * payload, its UV points map through the surface to within a tolerance of
 * the curve's vertical projection, and one undo removes it.
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  const id = () => 'window.__app.scene.get(window.__nsurf)';

  const clickSel = (sel) => t.evaluate(`(() => {
    const el = document.querySelector('${sel}');
    if (!el || el.disabled) return false;
    el.click();
    return true;
  })()`);

  // ===== Scene: default bumpy patch + a straight curve above it =============
  await t.evaluate(`(() => { const S = window.__app.scene; for (const o of [...S.objects]) S.remove(o.id); })()`);
  await t.key('Escape', 'Escape');

  await t.evaluate(`(async () => {
    const S = window.__app.scene;
    const od = await import('/src/core/scene/objectData.ts');
    const surf = S.addSurface('Patch', od.defaultSurfaceData());
    const curve = S.addCurve('Line', {
      kind: 'nurbs', cyclic: false, resolution: 12, order: 2,
      points: [{ co: [-0.8, -0.5, 2] }, { co: [0.8, 0.5, 2] }],
    });
    // Surface ACTIVE + curve selected alongside (the Project precondition).
    S.selection.clear();
    S.selection.add(curve.id);
    S.selection.add(surf.id);
    S.activeId = surf.id;
    window.__nsurf = surf.id;
    window.__ncurve = curve.id;
    window.__app.surface.sync();
  })()`);
  await t.until(`window.__app.scene.objects.some(o=>o.kind==='surface')`);
  t.check('patch + hovering line curve ready',
    (await t.evaluate(`${id()}.mesh.verts.size`)) > 0);

  // ===== Project (Closest) through the tab ==================================
  await t.evaluate(`document.querySelector('.properties-tab-btn[data-tab="surface"]').click()`);
  await t.sleep(150);
  t.check('Project row exists',
    await t.evaluate(`!!document.querySelector('.surface-tab-btn[data-action="project-curve"]')`));

  const before = await t.evaluate(`(${id()}.surface.surfaceCurves ?? []).length`);
  t.check('no surface curves before projecting', before === 0);
  t.check('Project Curve clicked', await clickSel('.surface-tab-btn[data-action="project-curve"]'));
  await t.sleep(100);

  const after = await t.evaluate(`(${id()}.surface.surfaceCurves ?? []).length`);
  t.check('projection appended one surface curve', after === 1);
  const name = await t.evaluate(`${id()}.surface.surfaceCurves[0].name`);
  t.check(`projected curve named Proj.NNN (${name})`, /^Proj\.\d+$/.test(name));

  // Geometric truth: every UV control point mapped through the surface lies
  // near the source line's vertical projection (closest-point of a line 2
  // units above a ±0.5-tall patch ≈ straight down; generous tolerance).
  // t.evaluate does NOT await promises — run the async check into a window
  // stash, then poll for it (the harness gotcha).
  await t.evaluate(`(async () => {
    const S = window.__app.scene;
    const nsurf = await import('/src/core/nurbs/surface.ts');
    const obj = S.get(window.__nsurf);
    const s = nsurf.fromSurfaceData(obj.surface);
    const sc = obj.surface.surfaceCurves[0];
    // Source line in the XY plane: y = 0.625x (from (-0.8,-0.5) to (0.8,0.5)).
    let max = 0;
    for (const p of sc.curve.points) {
      const world = nsurf.surfacePoint(s, p.co[0], p.co[1]);
      const dist = Math.abs(world.y - 0.625 * world.x);
      max = Math.max(max, dist);
    }
    window.__projMaxErr = max;
  })()`);
  await t.until(`typeof window.__projMaxErr === 'number'`);
  const maxErr = await t.evaluate(`window.__projMaxErr`);
  t.check(`projected UV points sit under the source line (maxErr=${maxErr.toFixed(4)})`, maxErr < 0.15);

  // ===== One undo removes it ================================================
  await t.evaluate(`window.__app.undo.undo()`);
  const undone = await t.evaluate(`(${id()}.surface.surfaceCurves ?? []).length`);
  t.check('undo removes the projected curve', undone === 0);
});
