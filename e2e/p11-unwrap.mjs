/**
 * P11-1 e2e — Seams + the unwrapper. Ctrl+E Edge menu (Mark Seam) and the U UV
 * menu (Unwrap / Smart UV Project), through the real InputManager + DOM menus.
 * Run with the dev server up (under flock):
 *   flock /tmp/vibe-blender-e2e.lock node e2e/p11-unwrap.mjs
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  // Layout workspace + a clean single-cube scene.
  await t.evaluate(`document.querySelector('.wsp-tab[data-workspace="Layout"]')?.click()`);
  await t.sleep(120);
  const saved = await t.evaluate('window.__app.io.serialize()');
  await t.evaluate(`window.__app.io.apply(${JSON.stringify(saved)})`);
  await t.key('Escape', 'Escape', 0); // dismiss splash
  await t.sleep(80);

  const R = await t.evaluate(`(() => {
    const r = document.querySelector('canvas').getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  })()`);
  const cx = Math.round(R.x + R.w / 2);
  const cy = Math.round(R.y + R.h / 2);

  // Click a DOM menu item by its exact label; returns whether it was found.
  const clickItem = (label) => t.evaluate(`(() => {
    const b = [...document.querySelectorAll('.add-menu-item')].find((x) => x.textContent === ${JSON.stringify(label)});
    if (b) { b.click(); return true; }
    return false;
  })()`);

  const mesh = () => 'window.__app.scene.editObject.mesh';

  // Enter edit mode on the cube, edge mode, select every edge.
  await t.evaluate(`(() => {
    const s = window.__app.scene;
    if (s.editMode) s.exitEditMode();
    s.selectOnly(s.objects[0].id);
    s.enterEditMode(s.objects[0].id);
    const m = s.editObject.mesh;
    s.editMode.setElementMode('edge', m);
    s.editMode.selectAll(m);
  })()`);
  await t.sleep(80);

  t.check('no seams to start', (await t.evaluate(`${mesh()}.seams.size`)) === 0);

  // ========================================================================
  // 1. Ctrl+E → Edge menu → Mark Seam. Seams land on the mesh (cage tints them).
  // ========================================================================
  await t.mouse('mouseMoved', cx, cy);
  await t.key('e', 'KeyE', 2); // Ctrl+E opens the Edge menu
  await t.sleep(80);
  t.check('Ctrl+E opens the Edge menu (Mark Seam present)', await clickItem('Mark Seam'));
  await t.sleep(120);
  const seamCount = await t.evaluate(`${mesh()}.seams.size`);
  t.check('Mark Seam records seams on the mesh', seamCount > 0, `seams=${seamCount}`);
  t.check('status confirms Mark Seam',
    (await t.evaluate(`document.getElementById('status').textContent`)).startsWith('Mark Seam'));

  // Undo the seam so the unwrap runs on a plain cube (single island).
  await t.key('z', 'KeyZ', 2);
  await t.sleep(120);
  t.check('Ctrl+Z clears the seams', (await t.evaluate(`${mesh()}.seams.size`)) === 0);

  // ========================================================================
  // 2. U → UV menu → Unwrap. Every face gets UVs, all inside [0,1]².
  // ========================================================================
  await t.evaluate(`(() => { const s = window.__app.scene; s.editMode.setElementMode('face', s.editObject.mesh); s.editMode.clearSelection(); })()`);
  await t.sleep(60);
  t.check('no UVs before unwrap', (await t.evaluate(`${mesh()}.uvs.size`)) === 0);

  await t.mouse('mouseMoved', cx, cy);
  await t.key('u', 'KeyU', 0); // U opens the UV menu
  await t.sleep(80);
  t.check('U opens the UV menu (Unwrap present)', await clickItem('Unwrap'));
  await t.sleep(150);

  const uvReport = await t.evaluate(`(() => {
    const m = window.__app.scene.editObject.mesh;
    let all = true, count = 0;
    for (const uvs of m.uvs.values()) {
      for (const [u, v] of uvs) {
        count++;
        if (!Number.isFinite(u) || !Number.isFinite(v) || u < -1e-6 || u > 1 + 1e-6 || v < -1e-6 || v > 1 + 1e-6) all = false;
      }
    }
    return { faces: m.faces.size, uvFaces: m.uvs.size, allInUnit: all, corners: count };
  })()`);
  t.check('Unwrap populates UVs for every face',
    uvReport.uvFaces === uvReport.faces && uvReport.uvFaces > 0,
    `${uvReport.uvFaces}/${uvReport.faces}`);
  t.check('all Unwrap UVs are inside [0,1]²', uvReport.allInUnit === true, `corners=${uvReport.corners}`);

  // ========================================================================
  // 3. Ctrl+Z clears the UVs.
  // ========================================================================
  await t.key('z', 'KeyZ', 2);
  await t.sleep(120);
  t.check('Ctrl+Z clears the unwrapped UVs', (await t.evaluate(`${mesh()}.uvs.size`)) === 0);

  // ========================================================================
  // 4. U → Smart UV Project also populates every face.
  // ========================================================================
  await t.mouse('mouseMoved', cx, cy);
  await t.key('u', 'KeyU', 0);
  await t.sleep(80);
  t.check('UV menu offers Smart UV Project', await clickItem('Smart UV Project'));
  await t.sleep(150);
  const smart = await t.evaluate(`(() => {
    const m = window.__app.scene.editObject.mesh;
    let all = true;
    for (const uvs of m.uvs.values()) for (const [u, v] of uvs) {
      if (u < -1e-6 || u > 1 + 1e-6 || v < -1e-6 || v > 1 + 1e-6) all = false;
    }
    return { uvFaces: m.uvs.size, faces: m.faces.size, allInUnit: all };
  })()`);
  t.check('Smart UV Project populates every face',
    smart.uvFaces === smart.faces && smart.uvFaces > 0, `${smart.uvFaces}/${smart.faces}`);
  t.check('all Smart UV Project UVs are inside [0,1]²', smart.allInUnit === true);

  // Restore a clean scene for later suites.
  await t.evaluate(`(() => {
    const s = window.__app.scene;
    if (s.editMode) s.exitEditMode();
    window.__app.io.apply(${JSON.stringify(saved)});
    window.__app.renderer.cameraViewId = null;
    window.__app.autosave.clear();
  })()`);
});
