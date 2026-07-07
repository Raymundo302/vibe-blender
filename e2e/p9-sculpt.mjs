/**
 * P9-7 e2e — Sculpt-lite brushes (Inflate + Grab), the icing pass.
 * Implements acceptance criterion 2 of tasks/P9-7.md exactly:
 *   subdivided plane → enter the sculpt tool → one inflate stroke at a known
 *   screen point → center verts' Y rose, corners unchanged; Ctrl+Z restores ALL
 *   of it in ONE step; a grab stroke moves verts laterally; the mode/tool exits
 *   cleanly (Tab back to Object Mode, G still grabs objects).
 *
 * Sculpt is a TOOL toggle inside Edit Mode (see sculptBrushes.ts). It is driven
 * through the real InputManager: Shift+I / Shift+G toggle the brush, then an LMB
 * drag on the surface paints. We verify state through the public topbar chip
 * ("Sculpt · inflate/grab" / "Object Mode") since sculptState is a private
 * module singleton.
 *
 * Run with the dev server up (under flock):
 *   flock /tmp/vibe-blender-e2e.lock node e2e/p9-sculpt.mjs
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  await t.evaluate(`document.querySelector('.wsp-tab[data-workspace="Layout"]')?.click()`);
  await t.sleep(120);
  const saved = await t.evaluate('window.__app.io.serialize()');
  await t.key('Escape', 'Escape', 0); // dismiss splash
  await t.sleep(80);

  const chip = () => t.evaluate(`document.querySelector('.topbar-chip').textContent`);

  // ------------------------------------------------------------------
  // Build a flat, finely subdivided plane on the y=0 plane (all vertex
  // normals point +Y), enter Edit Mode on it. N=8 → 0.25 spacing so the
  // default 0.5 brush radius catches the center vert plus its 4 neighbours,
  // while the corners (d≈1.414) stay outside.
  // ------------------------------------------------------------------
  await t.evaluate(`(() => {
    const s = window.__app.scene;
    if (s.editMode) s.exitEditMode();
    const Mesh = s.objects[0].mesh.constructor;
    const Vec = s.objects[0].mesh.verts.get(s.objects[0].mesh.verts.keys().next().value).co.constructor;
    const N = 8, step = 0.25; // spans -1..1
    const m = new Mesh();
    const ids = [];
    for (let i = 0; i <= N; i++) {
      ids[i] = [];
      for (let j = 0; j <= N; j++) ids[i][j] = m.addVert(new Vec(i * step - 1, 0, j * step - 1));
    }
    // CCW seen from +Y so face normals (and thus vertex normals) point up.
    for (let i = 0; i < N; i++)
      for (let j = 0; j < N; j++)
        m.addFace([ids[i][j], ids[i][j + 1], ids[i + 1][j + 1], ids[i + 1][j]]);
    const o = s.add('SculptPlane', m);
    s.selectOnly(o.id);
    s.enterEditMode(o.id);
    s.editMode.setElementMode('vert', m);
    s.editMode.clearSelection();
    window.__cId = ids[N / 2][N / 2];                                   // center vert
    window.__corners = [ids[0][0], ids[0][N], ids[N][0], ids[N][N]];    // 4 corners
  })()`);
  await t.sleep(100);

  const R = await t.evaluate(`(() => {
    const r = document.querySelector('canvas').getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  })()`);

  // Project a LOCAL point on the edit object (= world, identity transform) to page pixels.
  const project = (x, y, z) => t.evaluate(`(() => {
    const s = window.__app.scene, o = s.editObject, cam = window.__app.camera;
    const cv = document.querySelector('canvas'), r = cv.getBoundingClientRect();
    const mvp = cam.projMatrix(cv.width / cv.height).mul(cam.viewMatrix()).mul(o.transform.matrix());
    const V = o.mesh.verts.get(o.mesh.verts.keys().next().value).co.constructor;
    const p = mvp.transformPoint(new V(${x}, ${y}, ${z}));
    return { px: r.left + ((p.x + 1) / 2) * r.width, py: r.top + ((1 - p.y) / 2) * r.height };
  })()`);

  const vy = (id) => t.evaluate(`window.__app.scene.editObject.mesh.verts.get(${id}).co.y`);
  const raisedCount = () => t.evaluate(
    `[...window.__app.scene.editObject.mesh.verts.values()].filter(v => Math.abs(v.co.y) > 1e-6).length`);

  // ------------------------------------------------------------------
  // 1. Inflate stroke — center verts rise along +Y, corners untouched.
  // ------------------------------------------------------------------
  await t.key('i', 'KeyI', 8); // Shift+I → inflate brush ON
  await t.sleep(80);
  t.check('Shift+I turns on the Inflate brush (topbar chip)', (await chip()) === 'Sculpt · inflate');

  const cId = await t.evaluate('window.__cId');
  const corners = await t.evaluate('window.__corners');
  t.check('plane starts flat (center y == 0)', Math.abs(await vy(cId)) < 1e-9);

  const center = await project(0, 0, 0);
  // One stroke: press on the surface (start dab), nudge, release. ONE undo entry.
  await t.mouse('mouseMoved', center.px, center.py);
  await t.mouse('mousePressed', center.px, center.py, 'left');
  await t.sleep(60);
  await t.mouse('mouseMoved', center.px + 4, center.py + 2, 'none');
  await t.sleep(40);
  await t.mouse('mouseMoved', center.px, center.py, 'none');
  await t.sleep(40);
  await t.mouse('mouseReleased', center.px, center.py, 'left');
  await t.sleep(120);

  const cyAfter = await vy(cId);
  t.check('inflate raised the center vert along +Y', cyAfter > 0.05, `y=${cyAfter.toFixed(3)}`);
  const raised = await raisedCount();
  t.check('inflate raised multiple verts (center + neighbours)', raised >= 3, `raised=${raised}`);
  let cornersFlat = true;
  for (const c of corners) if (Math.abs(await vy(c)) > 1e-9) cornersFlat = false;
  t.check('corner verts are unchanged (outside the brush radius)', cornersFlat);

  // ------------------------------------------------------------------
  // 1b. ONE Ctrl+Z restores the ENTIRE stroke in a single step.
  // ------------------------------------------------------------------
  await t.key('z', 'KeyZ', 2); // Ctrl+Z
  await t.sleep(120);
  t.check('one Ctrl+Z restores the whole inflate stroke (0 raised verts)', (await raisedCount()) === 0);
  t.check('center vert back to y == 0 after undo', Math.abs(await vy(cId)) < 1e-9);

  // ------------------------------------------------------------------
  // 2. Grab stroke — captured verts move laterally with the pointer.
  // ------------------------------------------------------------------
  await t.key('g', 'KeyG', 8); // Shift+G → grab brush ON
  await t.sleep(80);
  t.check('Shift+G switches to the Grab brush (topbar chip)', (await chip()) === 'Sculpt · grab');

  const before = await t.evaluate(`(() => {
    const v = window.__app.scene.editObject.mesh.verts.get(${cId}).co; return { x: v.x, y: v.y, z: v.z };
  })()`);
  const g0 = await project(0, 0, 0);
  await t.mouse('mouseMoved', g0.px, g0.py);
  await t.mouse('mousePressed', g0.px, g0.py, 'left');
  await t.sleep(60);
  await t.mouse('mouseMoved', g0.px + 40, g0.py, 'none');
  await t.sleep(40);
  await t.mouse('mouseMoved', g0.px + 80, g0.py, 'none');
  await t.sleep(40);
  await t.mouse('mouseReleased', g0.px + 80, g0.py, 'left');
  await t.sleep(120);

  const after = await t.evaluate(`(() => {
    const v = window.__app.scene.editObject.mesh.verts.get(${cId}).co; return { x: v.x, y: v.y, z: v.z };
  })()`);
  const lateral = Math.hypot(after.x - before.x, after.z - before.z);
  t.check('grab moved the center vert laterally (in the view plane)', lateral > 0.05, `lateral=${lateral.toFixed(3)}`);

  await t.key('z', 'KeyZ', 2); // undo the grab → flat again
  await t.sleep(120);
  t.check('Ctrl+Z restores the grab in one step', (await raisedCount()) === 0);

  // ------------------------------------------------------------------
  // 3. Clean exit — Tab back to Object Mode clears the brush; G grabs objects.
  // ------------------------------------------------------------------
  await t.key('Tab', 'Tab', 0);
  await t.sleep(100);
  t.check('Tab exits to Object Mode (brush cleared)', (await chip()) === 'Object Mode');
  t.check('editMode is null after Tab', (await t.evaluate('window.__app.scene.editMode')) === null);

  await t.evaluate(`window.__app.scene.selectOnly(window.__app.scene.objects.find(o => o.name === 'SculptPlane').id)`);
  const objBefore = await t.evaluate(`(() => { const p = window.__app.scene.activeObject.transform.position; return { x: p.x, y: p.y, z: p.z }; })()`);
  await t.mouse('mouseMoved', R.x + R.w / 2, R.y + R.h / 2);
  await t.key('g', 'KeyG', 0); // object-mode G → TranslateOperator
  await t.sleep(60);
  await t.mouse('mouseMoved', R.x + R.w / 2 + 120, R.y + R.h / 2 + 40, 'none');
  await t.sleep(60);
  const objDuring = await t.evaluate(`(() => { const p = window.__app.scene.activeObject.transform.position; return { x: p.x, y: p.y, z: p.z }; })()`);
  const objMoved = Math.hypot(objDuring.x - objBefore.x, objDuring.y - objBefore.y, objDuring.z - objBefore.z);
  t.check('G still grabs whole objects in Object Mode', objMoved > 0.01, `moved=${objMoved.toFixed(3)}`);
  await t.key('Escape', 'Escape', 0); // cancel the move
  await t.sleep(80);

  // Restore a clean scene for later suites.
  await t.evaluate(`(() => {
    const s = window.__app.scene;
    if (s.editMode) s.exitEditMode();
    window.__app.io.apply(${JSON.stringify(saved)});
    window.__app.renderer.cameraViewId = null;
    window.__app.autosave.clear();
  })()`);
});
