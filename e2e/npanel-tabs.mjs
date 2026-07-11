/**
 * UR5-6 — N-panel Item + View tabs.
 *
 * Covers: (1) N opens with two tabs, Item default; (2) View lens 100mm narrows
 * the viewport FOV (projected-position probe); (3) passepartout checkbox gates
 * the overlay in camera view + survives reload; (4) camera-view section appears
 * only through a camera and its focal-length edit is undoable CameraData; (5)
 * Item-tab regression: transform fields still commit.
 *
 * Run: E2E_PORT=9439 node e2e/npanel-tabs.mjs
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  // Clean single-cube scene, cube active, object mode.
  await t.evaluate(`(() => { const s = window.__app.scene; if (s.editMode) s.exitEditMode(); s.selectOnly(s.objects[0].id); })()`);
  await t.sleep(100);

  // ---- (1) N opens with two tabs, Item default -----------------------------
  t.check('N-panel starts hidden',
    await t.evaluate(`(() => { const p = document.querySelector('.n-panel'); return !p || p.style.display === 'none'; })()`));
  await t.key('n', 'KeyN');
  await t.sleep(120);
  t.check('N opens the panel',
    await t.evaluate(`(() => { const p = document.querySelector('.n-panel'); return !!p && p.style.display !== 'none'; })()`));
  t.check('two vertical tabs present (Item + View)',
    await t.evaluate(`document.querySelectorAll('.n-panel-tab').length === 2
      && !!document.querySelector('.n-panel-tab[data-tab="item"]')
      && !!document.querySelector('.n-panel-tab[data-tab="view"]')`));
  t.check('Item tab is active by default',
    await t.evaluate(`document.querySelector('.n-panel-tab[data-tab="item"]').classList.contains('n-panel-tab-active')`));
  t.check('Item content shows the active object name',
    await t.evaluate(`document.querySelector('.n-panel .n-panel-name').textContent === 'Cube'`));

  // ---- (5) Item-tab regression: transform fields still commit --------------
  const locX = () => t.evaluate('window.__app.scene.activeObject.transform.position.x');
  const beforeX = await locX();
  const pushBefore = await t.evaluate('window.__app.undo.pushCount');
  await t.evaluate(`(() => {
    const input = document.querySelector('.n-panel .n-panel-item .properties-input');
    input.value = '3'; input.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(120);
  t.check('Item Location X edit moves the object (X = 3)', Math.abs((await locX()) - 3) < 1e-6);
  t.check('Item transform edit pushed one undo command',
    (await t.evaluate('window.__app.undo.pushCount')) === pushBefore + 1);
  await t.key('z', 'KeyZ', 2); // ctrl+z
  await t.sleep(120);
  t.check('Ctrl+Z undoes the Item location edit', Math.abs((await locX()) - beforeX) < 1e-6);

  // ---- (2) View tab: lens 100mm narrows the viewport FOV -------------------
  // Off-axis probe point projected to NDC; a narrower FOV magnifies it.
  const ndcRadius = () => t.evaluate(`(() => {
    const c = window.__app.camera;
    const V = window.__app.scene.objects[0].transform.position.constructor;
    const p = c.projMatrix(1.6).mul(c.viewMatrix()).transformPoint(new V(2, 0, 0));
    return Math.hypot(p.x, p.y);
  })()`);

  await t.evaluate(`document.querySelector('.n-panel-tab[data-tab="view"]').click()`);
  await t.sleep(100);
  t.check('View tab active after click',
    await t.evaluate(`document.querySelector('.n-panel-tab[data-tab="view"]').classList.contains('n-panel-tab-active')`));
  t.check('Item content hidden while View tab active',
    await t.evaluate(`document.querySelector('.n-panel .n-panel-item').style.display === 'none'`));
  t.check('View lens field present',
    await t.evaluate(`!!document.querySelector('.n-panel [data-field="view-focal"]')`));

  const fovBefore = await t.evaluate('window.__app.camera.fovY');
  const rBefore = await ndcRadius();
  const pushBeforeLens = await t.evaluate('window.__app.undo.pushCount');
  await t.evaluate(`(() => {
    const i = document.querySelector('.n-panel [data-field="view-focal"]');
    i.value = '100'; i.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(100);
  const fovAfter = await t.evaluate('window.__app.camera.fovY');
  const rAfter = await ndcRadius();
  t.check('lens 100mm narrows the viewport FOV', fovAfter < fovBefore,
    `${fovBefore.toFixed(3)} -> ${fovAfter.toFixed(3)}`);
  t.check('narrower FOV magnifies the projected probe point', rAfter > rBefore,
    `${rBefore.toFixed(3)} -> ${rAfter.toFixed(3)}`);
  t.check('camera.fovY equals the shared mm→fov helper for 100mm',
    await t.evaluate(`Math.abs(window.__app.camera.fovY - 2*Math.atan(12/100)) < 1e-6`));
  t.check('viewport lens edit makes NO undo entry',
    (await t.evaluate('window.__app.undo.pushCount')) === pushBeforeLens);

  // ---- (4) In-camera-view section ------------------------------------------
  // Not through a camera yet → section hidden.
  t.check('camera-view section hidden when not looking through a camera',
    await t.evaluate(`document.querySelector('.n-panel .n-panel-cam-section').style.display === 'none'`));

  // Add a camera + look through it (mirrors Numpad0 setting cameraViewId).
  await t.evaluate(`(() => {
    const s = window.__app.scene;
    let cam = s.objects.find(o => o.kind === 'camera') || s.addCamera('Camera');
    window.__camId = cam.id;
    s.activeCameraId = cam.id;
    window.__app.renderer.cameraViewId = cam.id;
  })()`);
  await t.sleep(150);
  t.check('camera-view section appears through a camera',
    await t.evaluate(`document.querySelector('.n-panel .n-panel-cam-section').style.display !== 'none'`));
  t.check('camera focal field present',
    await t.evaluate(`!!document.querySelector('.n-panel [data-field="cam-focal"]')`));

  const camFocalBefore = await t.evaluate('window.__app.scene.get(window.__camId).camera.focalLength');
  const pushBeforeCam = await t.evaluate('window.__app.undo.pushCount');
  await t.evaluate(`(() => {
    const i = document.querySelector('.n-panel [data-field="cam-focal"]');
    i.value = '85'; i.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(120);
  t.check('editing camera focal changes CameraData (85mm)',
    Math.abs((await t.evaluate('window.__app.scene.get(window.__camId).camera.focalLength')) - 85) < 1e-6);
  t.check('camera focal edit pushed one undo command',
    (await t.evaluate('window.__app.undo.pushCount')) === pushBeforeCam + 1);
  t.check('the pushed command is a focal-length command',
    await t.evaluate(`window.__app.undo.peek().name === 'Set Focal Length'`));
  await t.key('z', 'KeyZ', 2); // ctrl+z
  await t.sleep(120);
  t.check('Ctrl+Z restores the camera focal length',
    Math.abs((await t.evaluate('window.__app.scene.get(window.__camId).camera.focalLength')) - camFocalBefore) < 1e-6);

  // ---- (3) Passepartout gate + persistence ---------------------------------
  t.check('passepartout checkbox present',
    await t.evaluate(`!!document.querySelector('.n-panel [data-action="passepartout"]')`));
  // ON + camera view → overlay visible.
  await t.evaluate(`(() => {
    const cb = document.querySelector('.n-panel [data-action="passepartout"]');
    if (!cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change')); }
  })()`);
  await t.sleep(120);
  t.check('passepartout ON → overlay visible in camera view',
    await t.evaluate(`(() => { const p = document.querySelector('.passepartout'); return !!p && p.style.display !== 'none'; })()`));
  // OFF → overlay hidden.
  await t.evaluate(`(() => {
    const cb = document.querySelector('.n-panel [data-action="passepartout"]');
    cb.checked = false; cb.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(120);
  t.check('passepartout OFF → overlay hidden in camera view',
    await t.evaluate(`(() => { const p = document.querySelector('.passepartout'); return !p || p.style.display === 'none'; })()`));
  t.check('passepartout pref persisted (localStorage false)',
    await t.evaluate(`JSON.parse(localStorage.getItem('vibe-view-v1')).passepartout === false`));

  await t.screenshot('/tmp/ur5-6-view-tab.png');

  // Pref survives reload → View-tab checkbox comes back unchecked.
  await t.reload();
  await t.key('n', 'KeyN');
  await t.sleep(120);
  await t.evaluate(`document.querySelector('.n-panel-tab[data-tab="view"]').click()`);
  await t.sleep(100);
  t.check('passepartout pref survives reload (checkbox unchecked)',
    await t.evaluate(`document.querySelector('.n-panel [data-action="passepartout"]').checked === false`));
});
