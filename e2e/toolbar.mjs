/**
 * Viewport tool palette (UR3-1) — Blender's left-edge T-toolbar.
 *
 * Checks: (1) the strip exists with object-mode buttons; (2) clicking Move
 * starts a modal translate (activeOperatorName reports it) and Escape cancels;
 * (3) Tab into edit mode swaps the button set to the mesh-edit tools (Extrude,
 * Knife appear; object-only Intersect goes away); (4) the strip doesn't cover
 * the canvas center.
 *
 * Run: E2E_PORT=<unique> node e2e/toolbar.mjs   (dev server on :5199)
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  await t.key('Escape', 'Escape', 0); // dismiss splash
  t.check('app booted', await t.until('!!window.__app'));

  // --- (1) toolbar exists with object-mode buttons -------------------------
  t.check('toolbar strip is mounted',
    await t.until(`!!document.querySelector('.viewport-toolbar')`));
  const objIds = await t.evaluate(
    `[...document.querySelectorAll('.viewport-toolbar [data-tool-id]')].map(b => b.dataset.toolId)`);
  console.log(`object-mode buttons: ${JSON.stringify(objIds)}`);
  t.check('object-mode Move button present', objIds.includes('move'));
  t.check('object-mode Rotate button present', objIds.includes('rotate'));
  t.check('object-mode Scale button present', objIds.includes('scale'));
  t.check('object-mode Duplicate button present', objIds.includes('duplicate'));
  t.check('object-mode Intersect button present', objIds.includes('intersect'));
  t.check('edit-only tools absent in object mode',
    !objIds.includes('extrude') && !objIds.includes('knife'));

  // The Move button's tooltip is "Name (Shortcut)".
  const moveTitle = await t.evaluate(
    `document.querySelector('.viewport-toolbar [data-tool-id="move"]').title`);
  t.check('Move button tooltip is "Move (G)"', moveTitle === 'Move (G)', moveTitle);

  // --- (2) click Move → modal translate; Escape cancels --------------------
  t.check('no operator active before clicking',
    (await t.evaluate('window.__app.input.activeOperatorName')) === null);
  await t.evaluate(`document.querySelector('.viewport-toolbar [data-tool-id="move"]').click()`);
  await t.sleep(60);
  const afterClick = await t.evaluate('window.__app.input.activeOperatorName');
  t.check('clicking Move starts a modal Move operator', afterClick === 'Move', String(afterClick));
  // The "active" highlight class is painted on the Move button.
  t.check('Move button gets the active highlight',
    await t.until(`document.querySelector('.viewport-toolbar [data-tool-id="move"]').classList.contains('active')`));
  await t.key('Escape', 'Escape', 0);
  await t.sleep(60);
  t.check('Escape cancels the modal Move',
    (await t.evaluate('window.__app.input.activeOperatorName')) === null);
  t.check('active highlight cleared after Escape',
    await t.until(`!document.querySelector('.viewport-toolbar [data-tool-id="move"]').classList.contains('active')`));

  // --- (3) Tab into edit mode → button set swaps ---------------------------
  await t.key('Tab', 'Tab');
  t.check('Tab entered edit mode', (await t.evaluate('window.__app.scene.mode')) === 'edit');
  await t.sleep(80); // let the frame-loop toolbar.update() rebuild
  const editIds = await t.until(
    `[...document.querySelectorAll('.viewport-toolbar [data-tool-id]')].some(b => b.dataset.toolId === 'extrude')`);
  t.check('edit-mode rebuild happened (Extrude present)', editIds);
  const editList = await t.evaluate(
    `[...document.querySelectorAll('.viewport-toolbar [data-tool-id]')].map(b => b.dataset.toolId)`);
  console.log(`edit-mode buttons: ${JSON.stringify(editList)}`);
  t.check('edit-mode has Extrude', editList.includes('extrude'));
  t.check('edit-mode has Knife', editList.includes('knife'));
  t.check('edit-mode has Loop Cut', editList.includes('loopcut'));
  t.check('edit-mode has Edge Slide', editList.includes('edgeslide'));
  t.check('object-only Intersect gone in edit mode', !editList.includes('intersect'));
  t.check('object-only Duplicate gone in edit mode', !editList.includes('duplicate'));

  // Back to object mode restores the object set.
  await t.key('Tab', 'Tab');
  t.check('Tab returned to object mode', (await t.evaluate('window.__app.scene.mode')) === 'object');
  await t.sleep(80);
  t.check('object set restored (Intersect back)',
    await t.until(`[...document.querySelectorAll('.viewport-toolbar [data-tool-id]')].some(b => b.dataset.toolId === 'intersect')`));

  // --- (4) the strip does not cover the canvas center ----------------------
  const geom = await t.evaluate(`(() => {
    const bar = document.querySelector('.viewport-toolbar').getBoundingClientRect();
    const cv = document.querySelector('canvas').getBoundingClientRect();
    const cx = cv.left + cv.width / 2, cy = cv.top + cv.height / 2;
    const inBar = cx >= bar.left && cx <= bar.right && cy >= bar.top && cy <= bar.bottom;
    return { barRight: bar.right, cx, coversCenter: inBar };
  })()`);
  console.log(`toolbar geom: ${JSON.stringify(geom)}`);
  t.check('toolbar strip does not cover the canvas center', geom.coversCenter === false, JSON.stringify(geom));
  t.check('toolbar sits left of center', geom.barRight < geom.cx, JSON.stringify(geom));
});
