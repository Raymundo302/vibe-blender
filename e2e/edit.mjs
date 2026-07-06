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

  // --- P2-2: element click-select (verts / faces / miss) ---
  // Reset to a clean vert selection.
  await t.key('1', 'Digit1');
  await t.key('a', 'KeyA', 1); // alt: deselect all
  t.check('cleared before element picking', (await editSel('e.verts.size')) === 0);

  // Find front (unoccluded) cube corners by projecting each vert and asking the
  // element-pick pass what is actually hit there — returns page-space click points.
  const corners = await t.evaluate(`(() => {
    const app = window.__app, obj = app.scene.editObject, cam = app.camera;
    const canvas = document.querySelector('canvas');
    const rect = canvas.getBoundingClientRect();
    const w = rect.width, h = rect.height;
    const vp = cam.projMatrix(w / h).mul(cam.viewMatrix());
    const out = [];
    for (const id of obj.mesh.verts.keys()) {
      const co = obj.mesh.verts.get(id).co;
      const world = obj.transform.matrix().transformPoint(co);
      const ndc = vp.transformPoint(world);
      const cssX = (ndc.x + 1) / 2 * w, cssY = (1 - ndc.y) / 2 * h;
      const hit = app.renderer.pickElement(app.scene, cam, cssX, cssY);
      if (hit && hit.kind === 'vert' && hit.id === id) {
        out.push({ id, pageX: rect.left + cssX, pageY: rect.top + cssY });
      }
    }
    return out;
  })()`);
  t.check('at least two front corners are pickable', corners.length >= 2, `${corners.length} pickable`);

  await t.click(Math.round(corners[0].pageX), Math.round(corners[0].pageY));
  t.check('vert click selects one vert', (await editSel('e.verts.size')) === 1);

  await t.click(Math.round(corners[1].pageX), Math.round(corners[1].pageY), 'left', 8); // shift
  t.check('shift-click adds a second vert', (await editSel('e.verts.size')) === 2);

  // Face mode: click the cube center → exactly one face selected.
  await t.key('3', 'Digit3');
  await t.click(640, 380);
  t.check('face click selects one face', (await editSel('e.faces.size')) === 1);

  // Click empty space clears the whole element selection.
  await t.click(100, 100);
  t.check('clicking empty space clears selection', (await editSel('e.faces.size')) === 0);

  // --- P2-3: G/R/S on selected elements ---
  // Back to vert mode, select all 8 verts of the cube.
  await t.key('1', 'Digit1');
  await t.key('a', 'KeyA');
  t.check('all verts selected for transform', (await editSel('e.verts.size')) === 8);

  const vert0 = () => t.evaluate('(() => { const c = window.__app.scene.editObject.mesh.verts.get(0).co; return { x: c.x, y: c.y, z: c.z }; })()');

  // G: grab, move the pointer, LMB-confirm → vert 0 moved.
  const before = await vert0();
  await t.key('g', 'KeyG');
  await t.mouse('mouseMoved', 780, 300);
  await t.sleep(120);
  await t.click(780, 300); // LMB confirms
  const afterMove = await vert0();
  t.check('G moved vert 0', before.x !== afterMove.x || before.y !== afterMove.y || before.z !== afterMove.z);

  // Ctrl+Z restores the moved vert.
  await t.key('z', 'KeyZ', 2); // ctrl
  const afterUndo = await vert0();
  t.check('Ctrl+Z restores vert 0 after move',
    Math.abs(afterUndo.x - before.x) < 1e-6 && Math.abs(afterUndo.y - before.y) < 1e-6 && Math.abs(afterUndo.z - before.z) < 1e-6);

  // S with numeric "2" + Enter → vert 0 doubled from the origin pivot.
  await t.key('a', 'KeyA'); // reselect all (undo may have refreshed selection)
  const preScale = await vert0();
  await t.key('s', 'KeyS');
  await t.key('2', 'Digit2');
  await t.key('Enter', 'Enter');
  const afterScale = await vert0();
  t.check('S "2" doubles vert 0 from pivot',
    Math.abs(afterScale.x - preScale.x * 2) < 1e-6 &&
    Math.abs(afterScale.y - preScale.y * 2) < 1e-6 &&
    Math.abs(afterScale.z - preScale.z * 2) < 1e-6);

  // Ctrl+Z restores the scaled vert.
  await t.key('z', 'KeyZ', 2);
  const afterScaleUndo = await vert0();
  t.check('Ctrl+Z restores vert 0 after scale',
    Math.abs(afterScaleUndo.x - preScale.x) < 1e-6 &&
    Math.abs(afterScaleUndo.y - preScale.y) < 1e-6 &&
    Math.abs(afterScaleUndo.z - preScale.z) < 1e-6);

  await t.key('Tab', 'Tab');
  t.check('Tab exits back to object mode', (await mode()) === 'object');
});
