/**
 * Knife tool e2e (K). Enters edit mode on the default cube, lays a two-click
 * vertical polyline straddling the cube's front face, confirms with Enter, and
 * checks the face + vert counts grew; then Ctrl+Z restores them; then the Esc
 * (cancel) path leaves the mesh untouched.
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  const mode = () => t.evaluate('window.__app.scene.mode');
  const verts = () => t.evaluate('window.__app.scene.editObject.mesh.verts.size');
  const faces = () => t.evaluate('window.__app.scene.editObject.mesh.faces.size');

  t.check('starts in object mode', (await mode()) === 'object');
  await t.key('Tab', 'Tab');
  t.check('Tab enters edit mode on the cube', (await mode()) === 'edit');

  // Project the cube's verts to find a vertical line (at the silhouette's center
  // x) that spans past the top and bottom of the cube — guaranteeing it crosses
  // the front face's top and bottom edges.
  const info = await t.evaluate(`(() => {
    const app = window.__app, obj = app.scene.editObject, cam = app.camera;
    const canvas = document.querySelector('canvas');
    const rect = canvas.getBoundingClientRect();
    const w = rect.width, h = rect.height;
    const vp = cam.projMatrix(w / h).mul(cam.viewMatrix()).mul(obj.transform.matrix());
    let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
    for (const v of obj.mesh.verts.values()) {
      const ndc = vp.transformPoint(v.co);
      const x = (ndc.x + 1) / 2 * w, y = (1 - ndc.y) / 2 * h;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    return { left: rect.left, top: rect.top, cx: (minX + maxX) / 2, minY, maxY };
  })()`);
  const px = Math.round(info.left + info.cx);
  const p1 = [px, Math.round(info.top + info.minY - 12)];
  const p2 = [px, Math.round(info.top + info.maxY + 12)];

  const v0 = await verts();
  const f0 = await faces();
  t.check('default cube starts at 8 verts', v0 === 8, `verts=${v0}`);
  t.check('default cube starts at 6 faces', f0 === 6, `faces=${f0}`);

  // --- Cut: K, two clicks, Enter ---
  await t.key('k', 'KeyK');
  t.check('K starts the knife operator', await t.evaluate('!!document.querySelector(".knife-overlay")'));
  await t.click(p1[0], p1[1]);
  await t.click(p2[0], p2[1]);
  t.check('two knife points drawn in the overlay',
    (await t.evaluate('document.querySelectorAll(".knife-overlay circle").length')) === 2);
  await t.key('Enter', 'Enter');

  const v1 = await verts();
  const f1 = await faces();
  t.check('Enter confirmed the cut — vert count increased', v1 > v0, `verts ${v0}->${v1}`);
  t.check('Enter confirmed the cut — face count increased', f1 > f0, `faces ${f0}->${f1}`);
  t.check('knife overlay cleaned up after confirm',
    !(await t.evaluate('!!document.querySelector(".knife-overlay")')));

  await t.screenshot(process.env.E2E_SHOT ?? '/tmp/vibe-blender-knife.png');

  // --- Undo restores ---
  await t.key('z', 'KeyZ', 2); // ctrl
  t.check('Ctrl+Z restores vert count', (await verts()) === v0, `verts=${await verts()}`);
  t.check('Ctrl+Z restores face count', (await faces()) === f0, `faces=${await faces()}`);

  // --- Cancel (Esc) path leaves the mesh unchanged ---
  await t.key('k', 'KeyK');
  await t.click(p1[0], p1[1]);
  await t.click(p2[0], p2[1]);
  await t.key('Escape', 'Escape');
  t.check('Esc cancel leaves vert count unchanged', (await verts()) === v0, `verts=${await verts()}`);
  t.check('Esc cancel leaves face count unchanged', (await faces()) === f0, `faces=${await faces()}`);
  t.check('knife overlay cleaned up after cancel',
    !(await t.evaluate('!!document.querySelector(".knife-overlay")')));
});
