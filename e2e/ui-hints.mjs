/**
 * UR14-1 — status & hints batch (UI-REVIEW items 1, 4, 15, 16, 17, 18).
 *
 * Drives the app and asserts the visibility-of-status surfaces via text (no
 * pixel reads): the modal-key hint bar rewrites across modes/ops, empty states
 * point forward, the one mode chip announces special modes, the topbar dirty dot
 * toggles on edit/undo/save, and destructive actions toast. Screenshots the hint
 * bar during a Move and the mode chip for eyes-on review.
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  // Retrying evaluate: CDP Runtime.evaluate occasionally reports a bare
  // "Uncaught" transient (context busy right after a screenshot / rapid calls).
  // Every expression here is a pure read or an idempotent write, so a retry is
  // safe and keeps the suite from aborting on infra flake.
  const ev = async (expr) => {
    for (let i = 0; i < 6; i++) {
      try { return await t.evaluate(expr); }
      catch { await t.sleep(150); }
    }
    return t.evaluate(expr);
  };
  const shot = async (path) => { await t.screenshot(path); await t.sleep(150); };

  const bar = () => ev('window.__app.hints.bar()');
  const chip = () => ev('window.__app.hints.chip()');
  const dirty = () => ev('window.__app.hints.dirty()');
  const mode = () => ev('window.__app.scene.mode');
  const barDom = () => ev('document.getElementById("hint-bar").textContent');
  const chipHidden = () => ev('document.getElementById("mode-chip").hidden');

  // Canvas center for a click that lands on the default cube.
  const rect = await ev(
    '(() => { const r = document.querySelector("canvas").getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()',
  );
  const cv = (fx, fy) => [rect.x + rect.w * fx, rect.y + rect.h * fy];

  // --- Boot: object-mode idle ----------------------------------------------
  t.check('hint bar exists in the DOM', await ev('!!document.getElementById("hint-bar")'));
  t.check('boot hint bar = object-mode idle', (await bar()).startsWith('G move'));
  t.check('boot hint bar DOM mirrors it', (await barDom()) === (await bar()));
  t.check('boot mode chip empty', (await chip()) === '');
  t.check('boot mode chip hidden', (await chipHidden()) === true);
  t.check('boot NOT dirty', (await dirty()) === false);

  // Properties shows the active cube (not the empty state).
  const propsEmptyShown = () => ev(
    '(() => { const e = [...document.querySelectorAll(".properties-empty")].find(x => x.offsetParent !== null); return e ? e.textContent : null; })()',
  );
  t.check('boot: properties NOT in empty state (cube active)', (await propsEmptyShown()) === null);

  // --- Edit-mode idle hints, per element mode ------------------------------
  await t.key('Tab', 'Tab');
  t.check('Tab enters edit mode', (await mode()) === 'edit');
  t.check('edit idle hint (vert)', (await bar()).includes('vert') && (await bar()).includes('Tab exit'));
  await t.key('2', 'Digit2');
  t.check('edge-mode hint mentions Ctrl+E', (await bar()).includes('Ctrl+E'));
  await t.key('3', 'Digit3');
  t.check('face-mode hint mentions inset', (await bar()).toLowerCase().includes('inset'));
  await t.key('1', 'Digit1');
  t.check('back to vert-mode hint', (await bar()).includes('E extrude'));
  await t.key('Tab', 'Tab');
  t.check('Tab exits to object mode', (await mode()) === 'object');
  t.check('object-mode idle hint restored', (await bar()).startsWith('G move'));

  // --- Modal op: Move rewrites the hint bar ---------------------------------
  // Select the cube via the scene API (a canvas-center click can land on the
  // gizmo origin where the arrows converge — see CLAUDE.md e2e note).
  await ev('(() => { const c = window.__app.scene.objects.find(o => o.name === "Cube"); if (c) window.__app.scene.selectOnly(c.id); })()');
  await t.sleep(80);
  await t.key('g', 'KeyG');
  await t.sleep(60);
  const moveHint = await bar();
  t.check('Move op hint shows axis + confirm/cancel',
    moveHint.includes('X/Y/Z') && moveHint.includes('Esc cancel'), moveHint);
  t.check('Move op hint DOM mirrors it', (await barDom()) === moveHint);
  t.check('mode chip still empty during Move', (await chip()) === '');
  await shot('research/ur14-1-hintbar-move.png');
  await t.key('Escape', 'Escape');
  t.check('after cancel, back to object idle', (await bar()).startsWith('G move'));

  // --- One mode chip: Viewing Camera ---------------------------------------
  await ev(`(() => {
    const app = window.__app;
    const cam = app.scene.addCamera('Camera');
    app.scene.selectOnly(cam.id);
    app.renderer.cameraViewId = cam.id;
  })()`);
  await t.sleep(160);
  const camChip = await ev('(() => { const el = document.getElementById("mode-chip"); return { chip: window.__app.hints.chip(), hidden: el.hidden, text: el.textContent }; })()');
  t.check('mode chip announces camera view', camChip.chip === 'Viewing Camera — Numpad0 exits');
  t.check('mode chip DOM visible', camChip.hidden === false);
  t.check('mode chip DOM text set', camChip.text === 'Viewing Camera — Numpad0 exits');
  await shot('research/ur14-1-modechip-camera.png');
  // Exit camera view; chip clears.
  await ev('window.__app.renderer.cameraViewId = null');
  await t.sleep(160);
  const camGone = await ev('(() => { const el = document.getElementById("mode-chip"); return { chip: window.__app.hints.chip(), hidden: el.hidden }; })()');
  t.check('mode chip clears after exiting camera view', camGone.chip === '');
  t.check('mode chip hidden again', camGone.hidden === true);

  // Re-select the cube for the deletion tests (camera add left it active).
  await ev('(() => { const c = window.__app.scene.objects.find(o => o.name === "Cube"); if (c) window.__app.scene.selectOnly(c.id); })()');
  await t.sleep(60);

  // --- Destructive toast + dirty dot ---------------------------------------
  const objCount = () => ev('window.__app.scene.objects.length');
  const before = await objCount();
  // Outliner × on the Cube row → delete + toast + dirty.
  await ev(`(() => {
    const rows = [...document.querySelectorAll('.outliner-row')];
    const cubeRow = rows.find(r => (r.textContent || '').includes('Cube'));
    const del = (cubeRow || document).querySelector('.outliner-del');
    if (del) del.click();
  })()`);
  await t.sleep(120);
  t.check('outliner × deleted the cube', (await objCount()) === before - 1);
  const toastText = await ev('(() => { const el = document.querySelector(".vb-toast"); return el ? el.textContent : null; })()');
  t.check('destructive toast text', toastText === 'Deleted Cube — Ctrl+Z restores', String(toastText));
  t.check('dirty after delete', (await dirty()) === true);

  // Empty states now that nothing is active.
  t.check('properties empty state points forward',
    (await propsEmptyShown()) === 'No active object — Shift+A adds one');
  const timelineRows = await ev('window.__timeline ? window.__timeline.rowCount() : -1');
  t.check('timeline has no rows → empty hint drawn', timelineRows === 0);

  // Undo restores the cube and returns to the clean (saved) position.
  await t.key('z', 'KeyZ', 2); // Ctrl+Z
  await t.sleep(120);
  t.check('undo restored the cube', (await objCount()) === before);
  t.check('clean again after undo back to saved position', (await dirty()) === false);

  // --- Dirty dot cleared by Save -------------------------------------------
  // Delete again to become dirty, then Save → clean.
  await ev(`(() => {
    const rows = [...document.querySelectorAll('.outliner-row')];
    const cubeRow = rows.find(r => (r.textContent || '').includes('Cube'));
    const del = (cubeRow || document).querySelector('.outliner-del');
    if (del) del.click();
  })()`);
  await t.sleep(100);
  t.check('dirty again after second delete', (await dirty()) === true);
  // UR14-2 item 5: Save moved into the File ▾ menu; the dirty dot lives on the
  // File button now.
  const saveHasDot = () => ev('document.querySelector("[data-action=\\"file-menu\\"]").classList.contains("topbar-dirty")');
  // Frame loop drives the dot; give it a couple frames.
  await t.sleep(120);
  t.check('File button shows the dirty dot', (await saveHasDot()) === true);
  // Open the File menu and click Save.
  await ev('document.querySelector("[data-action=\\"file-menu\\"]").click()');
  await t.sleep(40);
  await ev('document.querySelector(".topbar-menu-row[data-action=\\"save-scene\\"]").click()');
  await t.sleep(150);
  t.check('File ▸ Save clears the dirty state', (await dirty()) === false);
  await t.sleep(120);
  t.check('File button dirty dot cleared', (await saveHasDot()) === false);
});
