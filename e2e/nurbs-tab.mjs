/**
 * Surface properties tab e2e (NB-A3). Adds a NURBS surface, opens the Surface
 * tab, and drives the real UI:
 *   - Degree U 3→4 via the Shape stepper → control count grows AND the rendered
 *     shape stays numerically identical (mesh-vert probe before/after, since a
 *     degree ELEVATION is exact and the span grid is unchanged).
 *   - Rebuild to 10×6 via the Rebuild fields+button → payload counts verified.
 *   - Switch tessellation Segs U → the tessellated mesh face count changes after
 *     __app.surface.sync().
 * Uses the __app.surface probe + payload reads (no pixel reads needed).
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  const id = () => 'window.__app.scene.get(window.__nsurf)';

  const surf = () => t.evaluate(`(() => {
    const s = ${id()}.surface;
    return { degreeU: s.degreeU, degreeV: s.degreeV, pointsU: s.pointsU, pointsV: s.pointsV };
  })()`);

  // The tessellated vert coords — a shape fingerprint. Compared order-independently
  // (FP noise reorders any sort), so a degree ELEVATION must leave every vert
  // sitting on the original vert cloud.
  const vertsProbe = () => t.evaluate(`(() => {
    return [...${id()}.mesh.verts.values()].map((v) => [v.co.x, v.co.y, v.co.z]);
  })()`);
  // Max over every point in `a` of its nearest-neighbor distance in `b` (a
  // one-sided Hausdorff distance) — 0 ⇒ identical clouds regardless of ordering.
  const maxDiff = (a, b) => {
    if (a.length !== b.length) return Infinity;
    let worst = 0;
    for (const p of a) {
      let near = Infinity;
      for (const q of b) {
        const d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
        if (d < near) near = d;
      }
      worst = Math.max(worst, near);
    }
    return Math.sqrt(worst);
  };

  const setField = (field, value) => t.evaluate(`(() => {
    const el = document.querySelector('.surface-tab-input[data-field="${field}"]');
    el.value = '${value}';
    el.dispatchEvent(new Event('change'));
  })()`);

  const faceCount = () => t.evaluate(`${id()}.mesh.faces.size`);
  const vertCount = () => t.evaluate(`${id()}.mesh.verts.size`);

  // ===== (1) Add a 6×4 bicubic surface and select it =========================
  // 6 points in U (degree 3 → cap min(count-1,5)=5) so Degree U can rise to 4.
  await t.evaluate(`(() => {
    const S = window.__app.scene;
    const NU = 6, NV = 4;
    const pts = [];
    for (let i = 0; i < NU; i++) for (let j = 0; j < NV; j++) {
      const bump = Math.sin((i / (NU - 1)) * Math.PI) * Math.sin((j / (NV - 1)) * Math.PI) * 0.5;
      pts.push({ co: [-1 + (2 * i) / (NU - 1), -1 + (2 * j) / (NV - 1), bump] });
    }
    const data = { degreeU: 3, degreeV: 3, pointsU: NU, pointsV: NV, points: pts,
      tess: { mode: 'spans', segsU: 8, segsV: 8, tol: 0.01 } };
    const o = S.addSurface('NSurf', data);
    S.selectOnly(o.id);
    window.__nsurf = o.id;
  })()`);
  await t.evaluate('window.__app.surface.sync()');

  const added = await t.evaluate(`(() => {
    const o = ${id()};
    return { kind: o.kind, verts: o.mesh.verts.size, active: window.__app.scene.activeId === o.id };
  })()`);
  t.check('surface added (kind surface, active, non-empty mesh)',
    !!added && added.kind === 'surface' && added.active && added.verts > 0, JSON.stringify(added));

  // ===== (2) Open the Surface tab ============================================
  const opened = await t.evaluate(`(() => {
    const btn = document.querySelector('.properties-tab-btn[data-tab="surface"]');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  t.check('Surface tab button exists and was clicked', opened === true);
  await t.sleep(150);

  const shown = await t.evaluate(`(() => {
    const du = document.querySelector('.surface-tab-input[data-field="degree-u"]');
    const info = document.querySelector('.surface-tab-info[data-field="shape-info"]');
    return { degU: du ? du.value : null, info: info ? info.textContent : null };
  })()`);
  t.check('Surface tab populates Degree U = 3', shown.degU === '3', JSON.stringify(shown));
  t.check('Shape info shows Points 6 × 4', !!shown.info && shown.info.includes('6 × 4'), shown.info);

  // ===== (3) Degree U 3→4: count grows, shape identical ======================
  const beforeVerts = await vertsProbe();
  const before = await surf();
  await setField('degree-u', 4);
  await t.evaluate('window.__app.surface.sync()');
  const after = await surf();
  t.check('Degree U applied (3 → 4)', after.degreeU === 4, JSON.stringify(after));
  t.check('control count grew in U', after.pointsU > before.pointsU, `${before.pointsU} → ${after.pointsU}`);
  t.check('control count unchanged in V', after.pointsV === before.pointsV, `${before.pointsV} → ${after.pointsV}`);
  const afterVerts = await vertsProbe();
  const diff = maxDiff(beforeVerts, afterVerts);
  t.check('degree elevation leaves the tessellated shape numerically identical',
    diff <= 1e-6, `maxDiff=${diff}`);

  // ===== (4) Rebuild to 10×6 =================================================
  await setField('rb-points-u', 10);
  await setField('rb-points-v', 6);
  await setField('rb-degree-u', 3);
  await setField('rb-degree-v', 3);
  await t.evaluate(`document.querySelector('.surface-tab-btn[data-action="rebuild"]').click()`);
  await t.evaluate('window.__app.surface.sync()');
  const rebuilt = await surf();
  t.check('Rebuild produced 10 × 6 control net', rebuilt.pointsU === 10 && rebuilt.pointsV === 6,
    JSON.stringify(rebuilt));
  t.check('Rebuild kept degrees 3 × 3', rebuilt.degreeU === 3 && rebuilt.degreeV === 3,
    JSON.stringify(rebuilt));

  // ===== (5) Switch tessellation Segs U → face count changes =================
  const facesBefore = await faceCount();
  const vertsBefore = await vertCount();
  await setField('segs-u', 2); // was 8 → far fewer cells
  await t.evaluate('window.__app.surface.sync()');
  const facesAfter = await faceCount();
  const vertsAfter = await vertCount();
  t.check('changing Segs U re-tessellates (face count changes)',
    facesAfter !== facesBefore && facesAfter < facesBefore,
    `faces ${facesBefore} → ${facesAfter}, verts ${vertsBefore} → ${vertsAfter}`);
});
