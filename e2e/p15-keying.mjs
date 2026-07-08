/**
 * Keying menu e2e (P15-2). The I key opens Blender's Insert-Keyframe popup
 * (Location / Rotation / Scale / LocRotScale) in object mode. Verifies:
 *   - I opens the menu (.key-menu present)
 *   - clicking Location keys ONLY the three location channels (3 fcurves)
 *   - I,I keys all nine LocRotScale channels
 *   - Ctrl+Z undoes one menu action wholesale
 *   - Esc closes the menu without keying
 */
import { runE2e } from './harness.mjs';

const CLEAR_ANIM = `(() => {
  const o = window.__app.scene.activeObject;
  o.anim = undefined;
  window.__app.scene.frameCurrent = 1;
})()`;

const FCURVES = `(() => {
  const o = window.__app.scene.activeObject;
  return o.anim ? o.anim.fcurves.map(c => c.channelPath).sort() : [];
})()`;

const menuOpen = `!!document.querySelector('.key-menu')`;

const clickItem = (label) => `(() => {
  const btn = [...document.querySelectorAll('.key-menu-item')].find(b => b.textContent === ${JSON.stringify(label)});
  if (!btn) return false;
  btn.click();
  return true;
})()`;

runE2e(async (t) => {
  t.check('starts in object mode with an active cube',
    await t.evaluate(`!!(window.__app && window.__app.scene && window.__app.scene.activeObject)`));

  // --- 1. I opens the menu -------------------------------------------------
  await t.evaluate(CLEAR_ANIM);
  await t.key('i', 'KeyI');
  t.check('I opened the keying menu', await t.evaluate(menuOpen));
  t.check('menu lists LocRotScale as the default entry',
    await t.evaluate(`(() => {
      const d = document.querySelector('.key-menu-item.default');
      return !!d && d.textContent === 'LocRotScale';
    })()`));
  t.check('menu lists all four keying sets',
    await t.evaluate(`(() => {
      const labels = [...document.querySelectorAll('.key-menu-item')].map(b => b.textContent);
      return ['Location','Rotation','Scale','LocRotScale'].every(l => labels.includes(l));
    })()`));

  // --- 2. Esc closes without keying ---------------------------------------
  await t.key('Escape', 'Escape');
  t.check('Esc closed the menu', !(await t.evaluate(menuOpen)));
  t.check('Esc left no keyframes', (await t.evaluate(FCURVES)).length === 0);

  // --- 3. Clicking Location keys ONLY the three location channels ----------
  await t.evaluate(CLEAR_ANIM);
  await t.key('i', 'KeyI');
  t.check('menu open before clicking Location', await t.evaluate(menuOpen));
  t.check('clicked Location entry', await t.evaluate(clickItem('Location')));
  t.check('clicking Location closed the menu', !(await t.evaluate(menuOpen)));
  const locCurves = await t.evaluate(FCURVES);
  t.check('Location keyed exactly 3 fcurves', locCurves.length === 3, JSON.stringify(locCurves));
  t.check('the 3 fcurves are location.x/y/z',
    JSON.stringify(locCurves) === JSON.stringify(['location.x', 'location.y', 'location.z']),
    JSON.stringify(locCurves));

  // --- 4. Ctrl+Z undoes that one menu action wholesale --------------------
  await t.key('z', 'KeyZ', 2); // ctrl
  const afterUndo = await t.evaluate(FCURVES);
  t.check('Ctrl+Z removed all keyframes from the Location action', afterUndo.length === 0, JSON.stringify(afterUndo));

  // --- 5. I,I keys all nine LocRotScale channels --------------------------
  await t.evaluate(CLEAR_ANIM);
  await t.key('i', 'KeyI'); // open
  t.check('menu open for I,I test', await t.evaluate(menuOpen));
  await t.key('i', 'KeyI'); // second I confirms the highlighted default
  t.check('second I closed the menu', !(await t.evaluate(menuOpen)));
  const allCurves = await t.evaluate(FCURVES);
  t.check('I,I keyed all nine LocRotScale channels', allCurves.length === 9, JSON.stringify(allCurves));
  t.check('the nine include rotation + scale',
    ['location.x', 'rotation.y', 'scale.z'].every((c) => allCurves.includes(c)), JSON.stringify(allCurves));

  // --- 6. Ctrl+Z undoes the I,I action wholesale too ----------------------
  await t.key('z', 'KeyZ', 2);
  t.check('Ctrl+Z undid the I,I keying wholesale', (await t.evaluate(FCURVES)).length === 0);

  // --- 7. Empty selection → status message, no menu -----------------------
  await t.evaluate(`window.__app.scene.deselectAll()`);
  await t.key('i', 'KeyI');
  t.check('no menu opens with an empty selection', !(await t.evaluate(menuOpen)));
});
