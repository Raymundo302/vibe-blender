/**
 * Edit-mode e2e (Phase 2). Covers P2-1 today; element picking / tools checks
 * are appended as P2-2..P2-8 land.
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  const mode = () => t.evaluate('window.__app.scene.mode');
  const editSel = (expr) => t.evaluate(`(() => { const e = window.__app.scene.editMode; return e ? ${expr} : null; })()`);

  // --- P2-1: mode toggle, element modes, selection state ---
  t.check('starts in object mode', (await mode()) === 'object');

  await t.key('Tab', 'Tab');
  t.check('Tab enters edit mode on the cube', (await mode()) === 'edit');
  t.check('defaults to vert select', (await editSel('e.elementMode')) === 'vert');
  t.check('topbar chip shows edit mode',
    await t.evaluate(`document.querySelector('.topbar-chip').textContent.startsWith('Edit Mode')`));

  await t.key('2', 'Digit2');
  t.check('2 switches to edge select', (await editSel('e.elementMode')) === 'edge');
  await t.key('3', 'Digit3');
  t.check('3 switches to face select', (await editSel('e.elementMode')) === 'face');
  await t.key('1', 'Digit1');
  t.check('1 switches back to vert select', (await editSel('e.elementMode')) === 'vert');

  await t.key('a', 'KeyA');
  t.check('A selects all 8 verts', (await editSel('e.verts.size')) === 8);
  await t.key('a', 'KeyA', 1); // alt
  t.check('Alt+A deselects all', (await editSel('e.verts.size')) === 0);

  // Object-mode keys must not leak through
  const posBefore = await t.evaluate('window.__app.scene.objects[0].transform.position.x');
  await t.key('g', 'KeyG');
  await t.mouse('mouseMoved', 700, 300);
  await t.sleep(120);
  const posAfter = await t.evaluate('window.__app.scene.objects[0].transform.position.x');
  t.check('G does not move the object while in edit mode', posBefore === posAfter);
  await t.key('Escape', 'Escape');

  const objCount = await t.evaluate('window.__app.scene.objects.length');
  await t.key('x', 'KeyX');
  t.check('X does not delete the object while in edit mode',
    (await t.evaluate('window.__app.scene.objects.length')) === objCount);

  await t.screenshot(process.env.E2E_SHOT ?? '/tmp/vibe-blender-edit-mode.png');

  await t.key('Tab', 'Tab');
  t.check('Tab exits back to object mode', (await mode()) === 'object');
});
