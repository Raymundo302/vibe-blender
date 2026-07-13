/**
 * P10-2 e2e — Lock Camera to View + passepartout.
 * Run with the dev server up (under flock):
 *   flock /tmp/vibe-blender-e2e.lock node e2e/p10-camera2.mjs
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  // Layout workspace so the Properties panel (Camera tab) is on screen.
  await t.evaluate(`document.querySelector('.wsp-tab[data-workspace="Layout"]')?.click()`);
  await t.sleep(150);

  const saved = await t.evaluate('window.__app.io.serialize()');
  await t.evaluate(`window.__app.io.apply(${JSON.stringify(saved)})`);
  await t.key('Escape', 'Escape', 0); // dismiss splash
  await t.sleep(80);

  // Camera at (0,0,6) looking down -Z at the cube; make it the active camera.
  const camId = await t.evaluate(`(() => {
    const s = window.__app.scene;
    if (s.editMode) s.exitEditMode();
    // Default scene ships a Camera — clear cameras so the added one is active.
    for (const o of [...s.objects]) if (o.kind === 'camera') s.remove(o.id);
    const cam = s.addCamera('Camera');
    const V = cam.transform.position.constructor;
    cam.transform = cam.transform.withPosition(new V(0, 0, 6));
    s.selectOnly(cam.id);
    return cam.id;
  })()`);
  await t.sleep(120);
  t.check('camera is active', (await t.evaluate('window.__app.scene.activeCameraId')) === camId);

  // Canvas rect + center for real mouse events.
  const rect = await t.evaluate(`(() => {
    const r = document.querySelector('canvas').getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  })()`);
  const cx = Math.round(rect.x + rect.w / 2);
  const cy = Math.round(rect.y + rect.h / 2);

  const posOf = () => t.evaluate(`(() => {
    const p = window.__app.scene.get(${camId}).transform.position;
    return { x: p.x, y: p.y, z: p.z };
  })()`);
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  const flyDrag = async () => {
    await t.mouse('mouseMoved', cx, cy);
    await t.mouse('mousePressed', cx, cy, 'middle');
    await t.mouse('mouseMoved', cx + 50, cy + 25, 'middle');
    await t.mouse('mouseMoved', cx + 90, cy + 40, 'middle');
    await t.mouse('mouseReleased', cx + 90, cy + 40, 'middle');
    await t.sleep(80);
  };

  // --- lockToView OFF: MMB drag EXITS camera view --------------------------
  t.check('lockToView defaults off',
    (await t.evaluate(`!window.__app.scene.get(${camId}).camera.lockToView`)));
  await t.key('0', 'Numpad0', 0);
  await t.sleep(60);
  t.check('Numpad0 enters camera view',
    (await t.evaluate('window.__app.renderer.cameraViewId')) === camId);
  const posBeforeUnlocked = await posOf();
  await flyDrag();
  t.check('MMB drag with lock OFF exits camera view',
    (await t.evaluate('window.__app.renderer.cameraViewId')) === null);
  t.check('camera did NOT move while unlocked',
    dist(await posOf(), posBeforeUnlocked) < 1e-6);

  // --- Toggle Lock to View ON via the Camera tab ---------------------------
  await t.evaluate(`document.querySelector('.properties-tab-btn[data-tab="camera"]')?.click()`);
  await t.sleep(120);
  t.check('Lock to View checkbox present',
    await t.evaluate(`!!document.querySelector('.camera-tab-lock[data-field="lockToView"]')`));
  await t.evaluate(`(() => {
    const c = document.querySelector('.camera-tab-lock[data-field="lockToView"]');
    c.checked = true;
    c.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(120);
  t.check('checkbox commit set lockToView true',
    (await t.evaluate(`window.__app.scene.get(${camId}).camera.lockToView`)) === true);

  // Re-enter camera view; clear undo so we can count the fly's single entry.
  await t.key('0', 'Numpad0', 0);
  await t.sleep(60);
  t.check('back in camera view (locked)',
    (await t.evaluate('window.__app.renderer.cameraViewId')) === camId);
  await t.evaluate('window.__app.undo.clear()');
  const posBeforeFly = await posOf();

  await flyDrag();
  t.check('MMB drag with lock ON STAYS in camera view',
    (await t.evaluate('window.__app.renderer.cameraViewId')) === camId);
  t.check('camera transform CHANGED (flew the camera)',
    dist(await posOf(), posBeforeFly) > 1e-3);
  t.check('continuous fly pushes NOTHING mid-session (undo empty)',
    (await t.evaluate('window.__app.undo.undoStack.length')) === 0);

  // Leaving camera view commits exactly ONE undo entry.
  await t.key('0', 'Numpad0', 0);
  await t.sleep(60);
  t.check('Numpad0 leaves camera view',
    (await t.evaluate('window.__app.renderer.cameraViewId')) === null);
  t.check('leaving pushes EXACTLY ONE undo entry',
    (await t.evaluate('window.__app.undo.undoStack.length')) === 1);

  await t.key('z', 'KeyZ', 2); // Ctrl+Z
  await t.sleep(100);
  t.check('Ctrl+Z restores the original camera pose',
    dist(await posOf(), posBeforeFly) < 1e-6);

  // --- Passepartout --------------------------------------------------------
  // Enter camera view again so the overlay shows.
  await t.key('0', 'Numpad0', 0);
  await t.sleep(80);
  const ppIn = await t.evaluate(`(() => {
    const root = document.querySelector('.passepartout');
    const masks = document.querySelectorAll('.passepartout-mask');
    const frame = document.querySelector('.passepartout-frame');
    const cr = document.querySelector('canvas').getBoundingClientRect();
    const inRect = (r, x, y) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom && r.width > 0 && r.height > 0;
    const corner = { x: cr.left + 2, y: cr.top + 2 };
    const center = { x: cr.left + cr.width / 2, y: cr.top + cr.height / 2 };
    let cornerMasked = false, centerMasked = false;
    for (const m of masks) {
      const r = m.getBoundingClientRect();
      if (inRect(r, corner.x, corner.y)) cornerMasked = true;
      if (inRect(r, center.x, center.y)) centerMasked = true;
    }
    const fr = frame ? frame.getBoundingClientRect() : null;
    return {
      visible: !!root && root.style.display !== 'none',
      maskCount: masks.length,
      hasFrame: !!frame,
      cornerMasked, centerMasked,
      centerInFrame: fr ? inRect(fr, center.x, center.y) : false,
    };
  })()`);
  t.check('passepartout visible in camera view', ppIn.visible);
  t.check('four mask panes present', ppIn.maskCount === 4);
  t.check('frame rect present', ppIn.hasFrame);
  t.check('a corner pixel is overlaid by a mask', ppIn.cornerMasked);
  t.check('the center pixel is NOT overlaid', !ppIn.centerMasked);
  t.check('the center pixel lies inside the render frame', ppIn.centerInFrame);

  // Clicks still select THROUGH the overlay: deselect, click the cube (center).
  await t.evaluate('window.__app.scene.deselectAll()');
  await t.sleep(40);
  await t.click(cx, cy, 'left', 0);
  await t.sleep(80);
  t.check('click selects the cube through the passepartout',
    (await t.evaluate('window.__app.scene.selection.size')) >= 1);

  // Leave camera view → passepartout hides.
  await t.key('0', 'Numpad0', 0);
  await t.sleep(80);
  t.check('passepartout hidden outside camera view',
    (await t.evaluate(`(() => {
      const root = document.querySelector('.passepartout');
      return !!root && root.style.display === 'none';
    })()`)));

  // Restore a clean scene for later suites.
  await t.evaluate(`window.__app.io.apply(${JSON.stringify(saved)})`);
  await t.evaluate(`window.__app.renderer.cameraViewId = null`);
  await t.evaluate(`window.__app.autosave.clear()`);
});
