/**
 * P8-2 e2e — Camera objects: frustum + view-through (Numpad0) + Camera tab.
 * Run with the dev server up (under flock):
 *   flock /tmp/vibe-blender-e2e.lock node e2e/p8-camera.mjs
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  // Force the Layout workspace so the Properties panel is on screen.
  await t.evaluate(`document.querySelector('.wsp-tab[data-workspace="Layout"]')?.click()`);
  await t.sleep(150);

  // Clean single-Cube scene; dismiss the splash so real pointer events reach the canvas.
  const saved = await t.evaluate('window.__app.io.serialize()');
  await t.evaluate(`window.__app.io.apply(${JSON.stringify(saved)})`);
  await t.key('Escape', 'Escape', 0); // dismiss splash (no-op key otherwise)
  await t.sleep(80);

  // --- Add a camera at (0,0,6) looking down -Z straight at the cube ---------
  const camId = await t.evaluate(`(() => {
    const s = window.__app.scene;
    if (s.editMode) s.exitEditMode();
    // Default scene ships a Camera — clear cameras so the added one is "first".
    for (const o of [...s.objects]) if (o.kind === 'camera') s.remove(o.id);
    const cam = s.addCamera('Camera');
    const V = cam.transform.position.constructor;
    cam.transform = cam.transform.withPosition(new V(0, 0, 6));
    s.selectOnly(cam.id);
    return cam.id;
  })()`);
  await t.sleep(120);
  t.check('addCamera set it active (first camera)',
    (await t.evaluate('window.__app.scene.activeCameraId')) === camId);

  // Canvas rect for pixel math (workspace layout shrinks the canvas).
  const rect = await t.evaluate(`(() => {
    const r = document.querySelector('canvas').getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  })()`);
  const cx = Math.round(rect.x + rect.w / 2);
  const cy = Math.round(rect.y + rect.h / 2);

  // Canvas-relative pick helper (renderer.pick takes canvas-local CSS px).
  const pickAt = (fx, fy) => t.evaluate(`(() => {
    const r = document.querySelector('canvas').getBoundingClientRect();
    return window.__app.renderer.pick(window.__app.scene, window.__app.camera, r.width * ${fx}, r.height * ${fy});
  })()`);

  // --- Numpad0: look through the active camera -----------------------------
  await t.key('0', 'Numpad0', 0);
  await t.sleep(80);
  t.check('Numpad0 enters camera view (cameraViewId = active camera)',
    (await t.evaluate('window.__app.renderer.cameraViewId')) === camId);
  t.check('Numpad0 status reads "View: Camera"',
    (await t.evaluate(`document.getElementById('status').textContent`)) === 'View: Camera');

  // The cube is centered in the camera's view: a center pick lands on it (non-bg).
  const centerHit = await pickAt(0.5, 0.5);
  t.check('center pick through the camera hits the cube (non-background)',
    centerHit && centerHit.kind === 'object');

  // Project the cube corner (1,1,1) via the SAME math the helpers use (scale-free
  // model⁻¹ view, cameraFovY proj) and record its NDC x magnitude.
  const projX = (focal) => t.evaluate(`(() => {
    const cam = window.__app.scene.get(${camId});
    const M = cam.transform.matrix();          // scale is identity → equals model matrix
    const Mat4 = M.constructor;
    const view = M.invert();
    const fovY = 2 * Math.atan(12 / ${focal});
    const proj = Mat4.perspective(fovY, ${rect.w} / ${rect.h}, cam.camera.near, cam.camera.far);
    const V = cam.transform.position.constructor;
    const p = proj.mul(view).transformPoint(new V(1, 1, 1));
    return Math.abs(p.x);
  })()`);
  const ndc50 = await projX(50);
  t.check('cube corner projects on-screen at focal 50', ndc50 > 0 && ndc50 < 1);

  // --- Camera tab: focal 50 → 24 widens the view ---------------------------
  await t.evaluate(`document.querySelector('.properties-tab-btn[data-tab="camera"]')?.click()`);
  await t.sleep(120);
  t.check('Camera tab button present (🎥)',
    await t.evaluate(`!!document.querySelector('.properties-tab-btn[data-tab="camera"]')`));
  t.check('Camera tab tooltip reads "Camera"',
    (await t.evaluate(`document.querySelector('.properties-tab-btn[data-tab="camera"]').title`)) === 'Camera');
  t.check('focal field shows 50',
    Math.abs(parseFloat(await t.evaluate(`document.querySelector('.camera-tab-input[data-field="focal"]').value`)) - 50) < 1e-6);

  await t.evaluate(`(() => {
    const inp = document.querySelector('.camera-tab-input[data-field="focal"]');
    inp.value = '24';
    inp.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(120);
  t.check('focal edit applies to CameraData (24)',
    Math.abs((await t.evaluate(`window.__app.scene.get(${camId}).camera.focalLength`)) - 24) < 1e-6);

  const ndc24 = await projX(24);
  t.check('focal 50 → 24 widens the view (cube projects smaller / nearer center)',
    ndc24 < ndc50, `|ndc.x| 50=${ndc50.toFixed(4)} 24=${ndc24.toFixed(4)}`);

  // Undo restores focal length 50.
  await t.key('z', 'KeyZ', 2); // ctrl+z
  await t.sleep(120);
  t.check('Ctrl+Z restores focal length to 50',
    Math.abs((await t.evaluate(`window.__app.scene.get(${camId}).camera.focalLength`)) - 50) < 1e-6);

  // --- Orbit (MMB drag) exits camera view ----------------------------------
  t.check('still in camera view before orbit',
    (await t.evaluate('window.__app.renderer.cameraViewId')) === camId);
  await t.mouse('mouseMoved', cx, cy);
  await t.mouse('mousePressed', cx, cy, 'middle');
  await t.mouse('mouseMoved', cx + 40, cy + 20, 'middle');
  await t.mouse('mouseReleased', cx + 40, cy + 20, 'middle');
  await t.sleep(80);
  t.check('MMB orbit exits camera view (cameraViewId === null)',
    (await t.evaluate('window.__app.renderer.cameraViewId')) === null);

  // --- Set Active + undo ----------------------------------------------------
  // Add a second camera (does NOT auto-activate — first camera is still active),
  // select it, then Set Active via the tab button.
  const cam2 = await t.evaluate(`(() => {
    const s = window.__app.scene;
    const c = s.addCamera('Camera.001');
    s.selectOnly(c.id);
    return c.id;
  })()`);
  await t.sleep(120);
  t.check('second camera is not auto-active',
    (await t.evaluate('window.__app.scene.activeCameraId')) === camId);

  await t.evaluate(`document.querySelector('.properties-tab-btn[data-tab="camera"]')?.click()`);
  await t.sleep(100);
  t.check('Set Active button enabled for a non-active camera',
    (await t.evaluate(`document.querySelector('[data-action="set-active-camera"]').disabled`)) === false);

  await t.evaluate(`document.querySelector('[data-action="set-active-camera"]').click()`);
  await t.sleep(120);
  t.check('Set Active makes the second camera active',
    (await t.evaluate('window.__app.scene.activeCameraId')) === cam2);
  t.check('Set Active button now disabled (already active)',
    (await t.evaluate(`document.querySelector('[data-action="set-active-camera"]').disabled`)) === true);
  t.check('Active ✓ badge visible for the active camera',
    (await t.evaluate(`document.querySelector('.camera-tab-active-badge').hidden`)) === false);

  await t.key('z', 'KeyZ', 2); // ctrl+z
  await t.sleep(120);
  t.check('Ctrl+Z reverts Set Active to the first camera',
    (await t.evaluate('window.__app.scene.activeCameraId')) === camId);

  // Empty state: select the (mesh) cube → tab shows "No camera selected".
  await t.evaluate(`(() => { const s = window.__app.scene; s.selectOnly(s.objects[0].id); })()`);
  await t.sleep(120);
  t.check('Camera tab shows empty state for a non-camera object',
    (await t.evaluate(`(() => {
      const empty = document.querySelector('.properties-pane[data-tab="camera"] .properties-empty');
      return !!empty && empty.style.display !== 'none';
    })()`)));

  // Restore a clean scene so a later suite starts fresh.
  await t.evaluate(`window.__app.io.apply(${JSON.stringify(saved)})`);
  await t.evaluate(`window.__app.renderer.cameraViewId = null`);
  await t.evaluate(`window.__app.autosave.clear()`);
});
