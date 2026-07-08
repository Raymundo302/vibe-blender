/**
 * P12-1 e2e — radial pie menu + Shift+S snap pie + snapOps.
 * Run with the dev server up: `node e2e/p12-pie.mjs` (wrap in flock).
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  await t.key('Escape', 'Escape', 0); // dismiss splash if present

  // Canvas rect → a point safely inside it to aim keyboard/mouse events.
  const rect = await t.evaluate(
    `(() => { const r = document.querySelector('canvas').getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  const cx = Math.round(rect.x + rect.w / 2);
  const cy = Math.round(rect.y + rect.h / 2);

  // Reset scene state: select the default Cube, clear undo, place the cursor.
  await t.evaluate(`(() => {
    const s = window.__app.scene;
    if (s.editMode) s.exitEditMode();
    s.selectOnly(s.objects[0].id);
    s.cursor = new (s.cursor.constructor)(1.5, 2, -3);
    window.__app.undo.clear();
  })()`);

  // Move the pointer into the canvas so the pie opens at a sane position.
  await t.mouse('mouseMoved', cx, cy, 'none');

  // --- Shift+S opens the pie with 5 wedges ---
  await t.key('s', 'KeyS', 8); // shift
  t.check('pie menu opens on Shift+S',
    (await t.evaluate(`!!document.querySelector('.pie-menu')`)) === true);
  t.check('pie has 5 wedges',
    (await t.evaluate(`document.querySelectorAll('.pie-menu .pie-menu-wedge').length`)) === 5);
  t.check('pie title chip reads Snap',
    (await t.evaluate(`document.querySelector('.pie-menu .pie-menu-title').textContent`)) === 'Snap');

  // --- Click 'Selection to Cursor' → the Cube moves to the cursor ---
  await t.evaluate(`(() => {
    const w = [...document.querySelectorAll('.pie-menu .pie-menu-wedge')]
      .find((b) => b.textContent === 'Selection to Cursor');
    w.click();
  })()`);
  await t.sleep(80);
  t.check('pie closes after clicking a wedge',
    (await t.evaluate(`!!document.querySelector('.pie-menu')`)) === false);

  const moved = await t.evaluate(`(() => {
    const s = window.__app.scene, o = s.objects[0];
    const p = s.worldTransformOf(o).position, c = s.cursor;
    return { dx: p.x - c.x, dy: p.y - c.y, dz: p.z - c.z };
  })()`);
  t.check('Cube world position equals the cursor',
    Math.abs(moved.dx) < 1e-5 && Math.abs(moved.dy) < 1e-5 && Math.abs(moved.dz) < 1e-5);

  // --- Ctrl+Z restores the Cube ---
  await t.key('z', 'KeyZ', 2); // ctrl
  const restored = await t.evaluate(`(() => {
    const p = window.__app.scene.worldTransformOf(window.__app.scene.objects[0]).position;
    return { x: p.x, y: p.y, z: p.z };
  })()`);
  t.check('Ctrl+Z restores the Cube to the origin',
    Math.abs(restored.x) < 1e-5 && Math.abs(restored.y) < 1e-5 && Math.abs(restored.z) < 1e-5);

  // --- Escape closes a reopened pie ---
  await t.mouse('mouseMoved', cx, cy, 'none');
  await t.key('s', 'KeyS', 8);
  t.check('pie reopens on Shift+S',
    (await t.evaluate(`!!document.querySelector('.pie-menu')`)) === true);
  await t.key('Escape', 'Escape', 0);
  t.check('Escape closes the pie',
    (await t.evaluate(`!!document.querySelector('.pie-menu')`)) === false);

  // --- Edit mode: the two Selection wedges are disabled ---
  await t.key('Tab', 'Tab', 0); // enter edit mode on the Cube
  t.check('entered edit mode', (await t.evaluate(`!!window.__app.scene.editMode`)) === true);
  await t.mouse('mouseMoved', cx, cy, 'none');
  await t.key('s', 'KeyS', 8);
  t.check('pie opens in edit mode',
    (await t.evaluate(`!!document.querySelector('.pie-menu')`)) === true);
  const disabled = await t.evaluate(`(() => {
    const wedges = [...document.querySelectorAll('.pie-menu .pie-menu-wedge')];
    const sel = wedges.filter((b) => b.textContent.startsWith('Selection to'));
    return { count: sel.length, allDisabled: sel.every((b) => b.classList.contains('disabled')) };
  })()`);
  t.check('both Selection wedges present in edit mode', disabled.count === 2);
  t.check('Selection wedges have the disabled class in edit mode', disabled.allDisabled === true);

  await t.key('Escape', 'Escape', 0);
  await t.key('Tab', 'Tab', 0); // back to object mode (tidy)
});
