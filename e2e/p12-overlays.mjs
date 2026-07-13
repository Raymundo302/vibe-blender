/**
 * P12-2 e2e — Overlays dropdown, Pivot dropdown, 💡 lights toggle, persistence.
 * Run with the dev server up (under flock):
 *   flock /tmp/vibe-blender-e2e.lock node e2e/p12-overlays.mjs
 */
import { runE2e } from './harness.mjs';
import { readFile } from 'node:fs/promises';

const SHOT_A = '/tmp/p12-overlays-grid-on.png';
const SHOT_B = '/tmp/p12-overlays-grid-off.png';

runE2e(async (t) => {
  // Start from a clean overlay state so the run is deterministic regardless of
  // a prior session's stored prefs.
  await t.evaluate(`(() => { localStorage.removeItem('vibe-overlays'); })()`);
  await t.reload();

  // Force the Layout workspace so the topbar + viewport are on screen.
  await t.evaluate(`document.querySelector('.wsp-tab[data-workspace="Layout"]')?.click()`);
  await t.sleep(150);

  // --- Overlays dropdown --------------------------------------------------
  t.check('Overlays button present',
    await t.evaluate(`!!document.querySelector('.vh-overlays')`));

  // Open it; the five checkbox rows appear in the popover.
  await t.evaluate(`document.querySelector('.vh-overlays').click()`);
  await t.sleep(120);
  t.check('Overlays popover has 7 checkbox rows',
    (await t.evaluate(`document.querySelectorAll('.vh-overlays-row[data-overlay]').length`)) === 7);
  t.check('Grid checkbox starts checked',
    await t.evaluate(`document.querySelector('.vh-overlays-row[data-overlay="grid"] input').checked`));

  // Screenshot with the grid ON, then un-check Grid and screenshot again.
  await t.screenshot(SHOT_A);
  await t.evaluate(`(() => {
    const box = document.querySelector('.vh-overlays-row[data-overlay="grid"] input');
    box.checked = false;
    box.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(150);
  t.check('un-checking Grid persists the pref to localStorage',
    (await t.evaluate(`JSON.parse(localStorage.getItem('vibe-overlays')).grid`)) === false);
  // Close the popover (a second click on the button toggles it shut).
  await t.evaluate(`document.querySelector('.vh-overlays').click()`);
  await t.sleep(80);

  // render() still runs without throwing after the grid is off.
  t.check('render() runs with grid off (no throw)',
    (await t.evaluate(`(() => { window.__app.renderer.render(window.__app.scene, window.__app.camera); return true; })()`)) === true);

  await t.sleep(80);
  await t.screenshot(SHOT_B);
  const a = await readFile(SHOT_A);
  const b = await readFile(SHOT_B);
  t.check('viewport screenshot changes when the grid is hidden', !a.equals(b));

  // --- Icons overlay gates pickability ------------------------------------
  // Isolate a single light at the world origin (hide meshes so nothing else is
  // pickable there), then probe its projected screen position.
  const lightId = await t.evaluate(`(() => {
    const s = window.__app.scene;
    if (s.editMode) s.exitEditMode();
    for (const o of s.objects) o.visible = (o.kind !== 'mesh') ? o.visible : false;
    const l = s.addLight('Probe', 'point'); // new Transform() → world origin
    // Deselect everything so no translate gizmo sits over the icon at the
    // origin (gizmo handles win the pick); icons are pickable regardless.
    s.deselectAll();
    return l.id;
  })()`);
  await t.sleep(120);

  const pickAtLight = `(() => {
    const app = window.__app;
    const s = app.scene, r = app.renderer, cam = app.camera;
    const canvas = document.querySelector('#viewport-wrap canvas') || document.querySelector('canvas');
    const rect = canvas.getBoundingClientRect();
    const vp = r.currentViewProj(s, cam);
    const p = s.worldTransformOf(s.get(${lightId})).position;
    const ndc = vp.transformPoint(p);
    const x = (ndc.x + 1) / 2 * rect.width;
    const y = (1 - ndc.y) / 2 * rect.height;
    const hit = r.pick(s, cam, x, y);
    return hit && hit.kind === 'object' ? hit.id : -1;
  })()`;

  // Icons ON (default): the light's billboard is pickable at its position.
  t.check('with Icons on, the light is pickable at its projected position',
    (await t.evaluate(pickAtLight)) === lightId);

  // Toggle Icons OFF via the dropdown checkbox.
  await t.evaluate(`document.querySelector('.vh-overlays').click()`);
  await t.sleep(100);
  await t.evaluate(`(() => {
    const box = document.querySelector('.vh-overlays-row[data-overlay="icons"] input');
    box.checked = false;
    box.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(120);
  t.check('with Icons off, the light is NOT pickable at that position',
    (await t.evaluate(pickAtLight)) !== lightId);
  // Close the popover before moving on.
  await t.evaluate(`document.querySelector('.vh-overlays').click()`);
  await t.sleep(80);

  // --- Pivot dropdown -----------------------------------------------------
  t.check('pivotMode starts as median',
    (await t.evaluate(`window.__app.scene.pivotMode`)) === 'median');
  await t.evaluate(`(() => { const s = document.querySelector('.vh-pivot'); s.value = 'cursor'; s.dispatchEvent(new Event('change')); })()`);
  await t.sleep(120);
  t.check('choosing 3D Cursor writes scene.pivotMode = cursor',
    (await t.evaluate(`window.__app.scene.pivotMode`)) === 'cursor');
  t.check('pivot select reflects the mode',
    (await t.evaluate(`document.querySelector('.vh-pivot').value`)) === 'cursor');

  // --- Object Types dropdown: Lights show/select --------------------------
  // (The old topbar 💡 toggle moved here.) Hiding the Lights type makes the
  // light unpickable at its icon; showing it again restores pickability.
  // Re-enable the Icons overlay (a prior section turned it off) so the light's
  // billboard is drawn/pickable and this section isolates the TYPE toggle.
  await t.evaluate(`(() => { window.__app.overlays.icons = true; })()`);
  await t.sleep(60);
  await t.evaluate(`document.querySelector('.vh-vis').click()`);
  await t.sleep(100);
  t.check('Object Types panel has 6 type rows',
    (await t.evaluate(`document.querySelectorAll('.vh-vis-row[data-kind]').length`)) === 6);
  t.check('Lights start pickable (type shown+selectable)',
    (await t.evaluate(pickAtLight)) === lightId);
  await t.evaluate(`(() => {
    const box = document.querySelector('.vh-vis-row[data-kind="light"] input[data-role="show"]');
    box.checked = false; box.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(120);
  t.check('hiding the Lights type makes the light unpickable',
    (await t.evaluate(pickAtLight)) !== lightId);
  t.check('hiding Lights persists to localStorage',
    (await t.evaluate(`JSON.parse(localStorage.getItem('vibe-object-types')).light.show`)) === false);
  // Re-show and confirm it comes back.
  await t.evaluate(`(() => {
    const box = document.querySelector('.vh-vis-row[data-kind="light"] input[data-role="show"]');
    box.checked = true; box.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(120);
  t.check('re-showing Lights restores pickability', (await t.evaluate(pickAtLight)) === lightId);
  await t.evaluate(`document.querySelector('.vh-vis').click()`); // close
  await t.sleep(80);

  // --- Persistence across reload -----------------------------------------
  // Grid + Icons were un-checked earlier; both should survive the reload.
  await t.reload();
  await t.evaluate(`document.querySelector('.wsp-tab[data-workspace="Layout"]')?.click()`);
  await t.sleep(150);
  t.check('grid pref persisted through reload (localStorage)',
    (await t.evaluate(`JSON.parse(localStorage.getItem('vibe-overlays')).grid`)) === false);
  await t.evaluate(`document.querySelector('.vh-overlays').click()`);
  await t.sleep(120);
  t.check('reopened Overlays menu shows Grid un-checked (pref applied at boot)',
    (await t.evaluate(`document.querySelector('.vh-overlays-row[data-overlay="grid"] input').checked`)) === false);
  t.check('reopened Overlays menu shows Icons un-checked',
    (await t.evaluate(`document.querySelector('.vh-overlays-row[data-overlay="icons"] input').checked`)) === false);

  // Clean up: restore all-on prefs so we don't leave the shared browser dirty.
  await t.evaluate(`(() => { localStorage.removeItem('vibe-overlays'); })()`);
});
