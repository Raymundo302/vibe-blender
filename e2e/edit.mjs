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

  // --- P2-4: extrude (E), face mode ---
  // Undo the scale from P2-3 so the cube is back to its default size, then face mode.
  await t.key('z', 'KeyZ', 2); // ctrl-z (revert scale, back to 8 verts / 6 faces)
  await t.key('3', 'Digit3');  // face select
  await t.key('a', 'KeyA', 1); // alt: deselect all
  t.check('cube back to 8 verts before extrude',
    (await t.evaluate('window.__app.scene.editObject.mesh.verts.size')) === 8);

  // Pick a front-facing cube face by projecting each face centroid and asking the
  // element-pick pass what's actually hit there — returns a page-space click point.
  const faceHit = await t.evaluate(`(() => {
    const app = window.__app, obj = app.scene.editObject, cam = app.camera;
    const canvas = document.querySelector('canvas');
    const rect = canvas.getBoundingClientRect();
    const w = rect.width, h = rect.height;
    const vp = cam.projMatrix(w / h).mul(cam.viewMatrix());
    for (const fid of obj.mesh.faces.keys()) {
      const f = obj.mesh.faces.get(fid);
      let cx = 0, cy = 0, cz = 0;
      for (const vid of f.verts) { const c = obj.mesh.verts.get(vid).co; cx += c.x; cy += c.y; cz += c.z; }
      const n = f.verts.length;
      const world = obj.transform.matrix().transformPoint({ x: cx/n, y: cy/n, z: cz/n });
      const ndc = vp.transformPoint(world);
      const cssX = (ndc.x + 1) / 2 * w, cssY = (1 - ndc.y) / 2 * h;
      const hit = app.renderer.pickElement(app.scene, cam, cssX, cssY);
      if (hit && hit.kind === 'face' && hit.id === fid) {
        return { id: fid, pageX: rect.left + cssX, pageY: rect.top + cssY };
      }
    }
    return null;
  })()`);
  t.check('a front cube face is pickable for extrude', faceHit !== null);

  await t.click(Math.round(faceHit.pageX), Math.round(faceHit.pageY));
  t.check('face selected before extrude', (await editSel('e.faces.size')) === 1);

  // E → drag the pointer → LMB confirm. Cap grows the mesh to 12 verts.
  await t.key('e', 'KeyE');
  await t.mouse('mouseMoved', 640, 250);
  await t.sleep(120);
  await t.mouse('mouseMoved', 640, 200);
  await t.sleep(120);
  await t.click(640, 200); // LMB confirms
  t.check('extrude grows the cube to 12 verts',
    (await t.evaluate('window.__app.scene.editObject.mesh.verts.size')) === 12);
  t.check('extrude selects the cap face', (await editSel('e.faces.size')) === 1);

  // Ctrl+Z restores the original 8 verts.
  await t.key('z', 'KeyZ', 2);
  t.check('Ctrl+Z restores 8 verts after extrude',
    (await t.evaluate('window.__app.scene.editObject.mesh.verts.size')) === 8);

  // Vert/edge mode: E only reports "face mode only".
  await t.key('1', 'Digit1');
  await t.key('e', 'KeyE');
  t.check('E in vert mode shows face-only status',
    await t.evaluate(`document.getElementById('status').textContent.includes('face mode only')`));

  // --- P2-5: inset (I), face mode ---
  await t.key('3', 'Digit3');  // face select
  await t.key('a', 'KeyA', 1); // alt: deselect all
  t.check('cube back to 6 faces before inset',
    (await t.evaluate('window.__app.scene.editObject.mesh.faces.size')) === 6);

  // Pick a front-facing cube face the same way the extrude section does.
  const insetFaceHit = await t.evaluate(`(() => {
    const app = window.__app, obj = app.scene.editObject, cam = app.camera;
    const canvas = document.querySelector('canvas');
    const rect = canvas.getBoundingClientRect();
    const w = rect.width, h = rect.height;
    const vp = cam.projMatrix(w / h).mul(cam.viewMatrix());
    for (const fid of obj.mesh.faces.keys()) {
      const f = obj.mesh.faces.get(fid);
      let cx = 0, cy = 0, cz = 0;
      for (const vid of f.verts) { const c = obj.mesh.verts.get(vid).co; cx += c.x; cy += c.y; cz += c.z; }
      const n = f.verts.length;
      const world = obj.transform.matrix().transformPoint({ x: cx/n, y: cy/n, z: cz/n });
      const ndc = vp.transformPoint(world);
      const cssX = (ndc.x + 1) / 2 * w, cssY = (1 - ndc.y) / 2 * h;
      const hit = app.renderer.pickElement(app.scene, cam, cssX, cssY);
      if (hit && hit.kind === 'face' && hit.id === fid) {
        return { id: fid, pageX: rect.left + cssX, pageY: rect.top + cssY };
      }
    }
    return null;
  })()`);
  t.check('a front cube face is pickable for inset', insetFaceHit !== null);

  await t.click(Math.round(insetFaceHit.pageX), Math.round(insetFaceHit.pageY));
  t.check('face selected before inset', (await editSel('e.faces.size')) === 1);

  // I → drag the pointer horizontally → LMB confirm. Face count grows to 10.
  await t.key('i', 'KeyI');
  await t.mouse('mouseMoved', 720, 380);
  await t.sleep(120);
  await t.mouse('mouseMoved', 760, 380);
  await t.sleep(120);
  await t.click(760, 380); // LMB confirms
  t.check('inset grows the cube to 10 faces',
    (await t.evaluate('window.__app.scene.editObject.mesh.faces.size')) === 10);
  t.check('inset grows the cube to 12 verts',
    (await t.evaluate('window.__app.scene.editObject.mesh.verts.size')) === 12);
  t.check('inset selects the inner face', (await editSel('e.faces.size')) === 1);

  // Ctrl+Z restores the original 6 faces.
  await t.key('z', 'KeyZ', 2);
  t.check('Ctrl+Z restores 6 faces after inset',
    (await t.evaluate('window.__app.scene.editObject.mesh.faces.size')) === 6);

  // Vert/edge mode: I only reports "face mode only".
  await t.key('1', 'Digit1');
  await t.key('i', 'KeyI');
  t.check('I in vert mode shows face-only status',
    await t.evaluate(`document.getElementById('status').textContent.includes('Inset: face mode only')`));

  // --- P2-6: delete menu (X) + merge at center (M) ---
  // Vert mode: select 2 corner verts via __app, then M merges them.
  await t.key('1', 'Digit1');
  await t.evaluate(`(() => {
    const e = window.__app.scene.editMode;
    e.clearSelection();
    const ids = [...window.__app.scene.editObject.mesh.verts.keys()].slice(0, 2);
    for (const id of ids) e.verts.add(id);
    e.touch();
  })()`);
  t.check('two verts selected before merge', (await editSel('e.verts.size')) === 2);
  await t.key('m', 'KeyM');
  t.check('M merges the cube to 7 verts',
    (await t.evaluate('window.__app.scene.editObject.mesh.verts.size')) === 7);
  t.check('M leaves the survivor vert selected', (await editSel('e.verts.size')) === 1);
  await t.key('z', 'KeyZ', 2); // ctrl-z
  t.check('Ctrl+Z restores 8 verts after merge',
    (await t.evaluate('window.__app.scene.editObject.mesh.verts.size')) === 8);

  // Face mode: select 1 face, X → menu → Faces → 5 faces.
  await t.key('3', 'Digit3');
  await t.key('a', 'KeyA', 1); // deselect all
  await t.evaluate(`(() => {
    const e = window.__app.scene.editMode;
    const fid = [...window.__app.scene.editObject.mesh.faces.keys()][0];
    e.faces.add(fid); e.touch();
  })()`);
  t.check('one face selected before delete', (await editSel('e.faces.size')) === 1);
  await t.key('x', 'KeyX');
  t.check('X opens the delete menu', await t.evaluate(`!!document.querySelector('.add-menu')`));
  // Click the "Faces" entry.
  await t.evaluate(`(() => {
    const items = [...document.querySelectorAll('.add-menu-item')];
    items.find((b) => b.textContent === 'Faces').click();
  })()`);
  await t.sleep(60);
  t.check('Delete → Faces removes the face (6 → 5)',
    (await t.evaluate('window.__app.scene.editObject.mesh.faces.size')) === 5);
  t.check('delete leaves nothing selected', (await editSel('e.faces.size')) === 0);
  t.check('delete menu closed after choosing', await t.evaluate(`!document.querySelector('.add-menu')`));
  await t.key('z', 'KeyZ', 2); // ctrl-z
  t.check('Ctrl+Z restores 6 faces after delete',
    (await t.evaluate('window.__app.scene.editObject.mesh.faces.size')) === 6);

  // X with an empty selection opens no menu and never deletes the object.
  await t.key('a', 'KeyA', 1); // deselect all
  const objCountBeforeX = await t.evaluate('window.__app.scene.objects.length');
  await t.key('x', 'KeyX');
  t.check('X with empty selection opens no menu', await t.evaluate(`!document.querySelector('.add-menu')`));
  t.check('X with empty selection keeps the object',
    (await t.evaluate('window.__app.scene.objects.length')) === objCountBeforeX);

  // --- P2-8: box select (B) + invert (Ctrl+I) ---
  // Project all cube verts to page-space so we can drag a rect around them.
  const vertPts = await t.evaluate(`(() => {
    const app = window.__app, obj = app.scene.editObject, cam = app.camera;
    const canvas = document.querySelector('canvas');
    const rect = canvas.getBoundingClientRect();
    const w = rect.width, h = rect.height;
    const vp = cam.projMatrix(w / h).mul(cam.viewMatrix()).mul(obj.transform.matrix());
    const out = [];
    for (const id of obj.mesh.verts.keys()) {
      const co = obj.mesh.verts.get(id).co;
      const ndc = vp.transformPoint(co);
      out.push({ id, pageX: rect.left + (ndc.x + 1) / 2 * w, pageY: rect.top + (1 - ndc.y) / 2 * h });
    }
    return out;
  })()`);
  const xs = vertPts.map((p) => p.pageX), ys = vertPts.map((p) => p.pageY);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const midX = (minX + maxX) / 2;

  // Drag a box rect: B, then LMB press→move→release. `shift` at release removes.
  const boxDrag = async (x0, y0, x1, y1, shift = false) => {
    await t.key('b', 'KeyB');
    await t.mouse('mouseMoved', x0, y0);
    await t.mouse('mousePressed', x0, y0, 'left');
    await t.sleep(60);
    await t.mouse('mouseMoved', x1, y1);
    await t.sleep(60);
    await t.mouse('mouseReleased', x1, y1, 'left', shift ? { modifiers: 8 } : {});
    await t.sleep(120);
  };

  await t.key('1', 'Digit1');       // vert mode
  await t.key('a', 'KeyA', 1);      // Alt+A: deselect all
  t.check('cleared before box select', (await editSel('e.verts.size')) === 0);

  // Box around the whole cube → all 8 verts added.
  await boxDrag(minX - 25, minY - 25, maxX + 25, maxY + 25);
  t.check('B box around whole cube selects 8 verts', (await editSel('e.verts.size')) === 8);

  // Shift-release box over the left half → those verts removed → fewer selected.
  await boxDrag(minX - 25, minY - 25, midX, maxY + 25, true);
  const afterRemove = await editSel('e.verts.size');
  t.check('B + Shift-release removes inside verts (fewer than 8)',
    afterRemove < 8 && afterRemove > 0, `${afterRemove} left`);

  // Ctrl+I → complement of the current selection.
  await t.key('i', 'KeyI', 2);
  t.check('Ctrl+I inverts to the complement',
    (await editSel('e.verts.size')) === 8 - afterRemove);

  // Esc during a box drag leaves the selection untouched.
  const beforeEsc = await editSel('e.verts.size');
  await t.key('b', 'KeyB');
  await t.mouse('mouseMoved', minX - 25, minY - 25, 'none');
  await t.mouse('mousePressed', minX - 25, minY - 25, 'left');
  await t.sleep(60);
  await t.mouse('mouseMoved', maxX + 25, maxY + 25);
  await t.sleep(60);
  await t.key('Escape', 'Escape');
  await t.mouse('mouseReleased', maxX + 25, maxY + 25, 'left');
  await t.sleep(80);
  t.check('Esc during box drag leaves selection unchanged',
    (await editSel('e.verts.size')) === beforeEsc, `${beforeEsc}`);
  t.check('box-select overlay removed after cancel',
    await t.evaluate(`!document.querySelector('.box-select-rect')`));

  await t.key('Tab', 'Tab');
  t.check('Tab exits back to object mode', (await mode()) === 'object');
});
