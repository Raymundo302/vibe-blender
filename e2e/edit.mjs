/**
 * Edit-mode e2e (Phase 2). Covers P2-1 today; element picking / tools checks
 * are appended as P2-2..P2-8 land.
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  const mode = () => t.evaluate('window.__app.scene.mode');
  // Canvas-relative points (the workspace layout shrinks the canvas).
  const rect = await t.evaluate('(() => { const r = document.querySelector("canvas").getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()');
  const cv = (fx, fy) => [Math.round(rect.x + rect.w * fx), Math.round(rect.y + rect.h * fy)];
  const [ccX, ccY] = cv(0.5, 0.48);   // canvas center (cube)
  const [emptyX, emptyY] = cv(0.08, 0.12);
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
  await t.mouse('mouseMoved', ccX + 60, ccY - 60);
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
  await t.click(ccX, ccY);
  t.check('face click selects one face', (await editSel('e.faces.size')) === 1);

  // Click empty space clears the whole element selection.
  await t.click(emptyX, emptyY);
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
  await t.mouse('mouseMoved', ccX + 140, ccY - 60);
  await t.sleep(120);
  await t.click(ccX + 140, ccY - 60); // LMB confirms
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
  await t.mouse('mouseMoved', ccX, ccY - 110);
  await t.sleep(120);
  await t.mouse('mouseMoved', ccX, ccY - 160);
  await t.sleep(120);
  await t.click(ccX, ccY - 160); // LMB confirms
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

  // --- P5-1: Delete-key alias for X + Dissolve Edges ---
  // Delete opens the SAME edit-mode menu as X (users kept pressing Delete).
  await t.key('3', 'Digit3'); // face mode
  await t.evaluate(`(() => {
    const e = window.__app.scene.editMode;
    const fid = [...window.__app.scene.editObject.mesh.faces.keys()][0];
    e.clearSelection(); e.faces.add(fid); e.touch();
  })()`);
  await t.key('Delete', 'Delete');
  t.check('Delete key opens the edit-mode Delete menu',
    await t.evaluate(`document.querySelector('.add-menu .add-menu-heading')?.textContent === 'Delete'`));
  t.check('Delete menu is the same one X opens (has Faces + Dissolve Edges)',
    await t.evaluate(`(() => { const labels = [...document.querySelectorAll('.add-menu-item')].map((b) => b.textContent); return labels.includes('Faces') && labels.includes('Dissolve Edges'); })()`));
  await t.key('Escape', 'Escape');
  t.check('Escape closes the Delete menu', await t.evaluate(`!document.querySelector('.add-menu')`));

  // Edge mode: select an interior cube edge, dissolve it → faces merge (6 → 5).
  await t.key('2', 'Digit2');
  await t.evaluate(`(() => {
    const e = window.__app.scene.editMode;
    e.clearSelection(); e.edges.add('0,1'); e.touch();
  })()`);
  const facesPreDissolve = await t.evaluate('window.__app.scene.editObject.mesh.faces.size');
  await t.key('x', 'KeyX');
  t.check('Dissolve Edges entry is enabled with an interior edge selected',
    await t.evaluate(`(() => { const b = [...document.querySelectorAll('.add-menu-item')].find((x) => x.textContent === 'Dissolve Edges'); return !!b && !b.disabled; })()`));
  await t.evaluate(`(() => {
    [...document.querySelectorAll('.add-menu-item')].find((b) => b.textContent === 'Dissolve Edges').click();
  })()`);
  await t.sleep(60);
  const facesPostDissolve = await t.evaluate('window.__app.scene.editObject.mesh.faces.size');
  t.check('Dissolve Edges merges the two faces (6 → 5)',
    facesPostDissolve === facesPreDissolve - 1, `${facesPreDissolve} → ${facesPostDissolve}`);
  t.check('dissolve keeps all 8 verts',
    (await t.evaluate('window.__app.scene.editObject.mesh.verts.size')) === 8);
  t.check('a 6-gon exists after dissolve',
    await t.evaluate('[...window.__app.scene.editObject.mesh.faces.values()].some((f) => f.verts.length === 6)'));
  await t.key('z', 'KeyZ', 2); // ctrl-z
  t.check('Ctrl+Z restores faces after dissolve',
    (await t.evaluate('window.__app.scene.editObject.mesh.faces.size')) === facesPreDissolve);

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

  // --- P2-7: loop cut (Ctrl+R) ---
  // Fresh state: reselect nothing, vert counts back to the cube's 8 via undo
  // stack is NOT guaranteed here, so read counts dynamically instead.
  await t.key('2', 'Digit2'); // edge select
  await t.key('a', 'KeyA', 1); // alt: deselect all
  const vertsBefore = await t.evaluate('window.__app.scene.editObject.mesh.verts.size');
  const facesBefore = await t.evaluate('window.__app.scene.editObject.mesh.faces.size');

  // Find a pickable (front-facing) edge by projecting each edge midpoint and
  // asking the edge-mode pick pass what's actually hit there.
  const edgeHit = await t.evaluate(`(() => {
    const app = window.__app, obj = app.scene.editObject, cam = app.camera;
    const canvas = document.querySelector('canvas');
    const rect = canvas.getBoundingClientRect();
    const w = rect.width, h = rect.height;
    const vp = cam.projMatrix(w / h).mul(cam.viewMatrix());
    for (const [key, e] of obj.mesh.edges()) {
      const a = obj.mesh.verts.get(e.v0).co, b = obj.mesh.verts.get(e.v1).co;
      const mid = { x: (a.x+b.x)/2, y: (a.y+b.y)/2, z: (a.z+b.z)/2 };
      const world = obj.transform.matrix().transformPoint(mid);
      const ndc = vp.transformPoint(world);
      const cssX = (ndc.x + 1) / 2 * w, cssY = (1 - ndc.y) / 2 * h;
      const hit = app.renderer.pickElement(app.scene, cam, cssX, cssY, 'edge');
      if (hit && hit.kind === 'edge' && hit.key === key) {
        return { key, pageX: rect.left + cssX, pageY: rect.top + cssY };
      }
    }
    return null;
  })()`);
  t.check('a front edge is hoverable for loop cut', edgeHit !== null);

  // Ctrl+R at that edge → preview appears (status + renderer preview buffer).
  await t.mouse('mouseMoved', Math.round(edgeHit.pageX), Math.round(edgeHit.pageY));
  await t.sleep(80);
  await t.key('r', 'KeyR', 2); // ctrl
  await t.mouse('mouseMoved', Math.round(edgeHit.pageX), Math.round(edgeHit.pageY));
  await t.sleep(120);
  t.check('loop-cut preview is live',
    await t.evaluate(`document.getElementById('status').textContent.startsWith('Loop Cut')`));
  t.check('preview polyline exists', await t.evaluate('!!window.__app.renderer.editPreviewLines'));

  // LMB confirms the cut: +4 verts, +4 faces on a pristine ring, new loop selected.
  await t.click(Math.round(edgeHit.pageX), Math.round(edgeHit.pageY));
  const vertsAfter = await t.evaluate('window.__app.scene.editObject.mesh.verts.size');
  const facesAfter = await t.evaluate('window.__app.scene.editObject.mesh.faces.size');
  t.check('loop cut added ring verts', vertsAfter > vertsBefore, `${vertsBefore} → ${vertsAfter}`);
  t.check('loop cut split strip faces', facesAfter > facesBefore, `${facesBefore} → ${facesAfter}`);
  t.check('new loop selected in edge mode',
    (await editSel('e.elementMode')) === 'edge' && (await editSel('e.edges.size')) > 0);
  t.check('preview cleared after confirm',
    await t.evaluate('window.__app.renderer.editPreviewLines === null'));

  // Ctrl+Z restores the original topology.
  await t.key('z', 'KeyZ', 2);
  t.check('Ctrl+Z restores pre-cut topology',
    (await t.evaluate('window.__app.scene.editObject.mesh.verts.size')) === vertsBefore);

  // Esc cancels a pending preview without touching the mesh.
  await t.key('r', 'KeyR', 2);
  await t.sleep(80);
  await t.key('Escape', 'Escape');
  t.check('Esc cancels loop cut without changes',
    (await t.evaluate('window.__app.scene.editObject.mesh.verts.size')) === vertsBefore &&
    (await t.evaluate('window.__app.renderer.editPreviewLines === null')));

  await t.key('Tab', 'Tab');
  t.check('Tab exits back to object mode', (await mode()) === 'object');

  // --- P5-1: Delete key deletes the active object in object mode (undoable) ---
  await t.click(ccX, ccY); // select the cube
  const objCountBeforeDel = await t.evaluate('window.__app.scene.objects.length');
  t.check('cube selected for object-mode delete',
    (await t.evaluate('window.__app.scene.selection.size')) > 0);
  await t.key('Delete', 'Delete');
  t.check('Delete key removes the object in object mode',
    (await t.evaluate('window.__app.scene.objects.length')) === objCountBeforeDel - 1);
  await t.key('z', 'KeyZ', 2); // ctrl-z
  t.check('Ctrl+Z restores the object deleted with Delete',
    (await t.evaluate('window.__app.scene.objects.length')) === objCountBeforeDel);

  // --- P5-2: bridge edge loops (Ctrl+E) ---
  // Clean slate, then import a two-quad OBJ: two parallel quads offset +2 on Y.
  // Their boundaries are two separate 4-edge loops — the bridge inputs.
  await t.evaluate(`(() => {
    const s = window.__app.scene;
    if (s.editMode) s.exitEditMode();
    for (const o of [...s.objects]) s.remove(o.id);
  })()`);
  const objFixture = 'v 0 0 0\nv 1 0 0\nv 1 0 1\nv 0 0 1\nv 0 2 0\nv 1 2 0\nv 1 2 1\nv 0 2 1\nf 1 2 3 4\nf 5 6 7 8\n';
  await t.evaluate('window.__app.io.importObj(' + JSON.stringify(objFixture) + ')');
  t.check('two-quad OBJ imported as one object',
    (await t.evaluate('window.__app.scene.objects.length')) === 1 &&
    (await t.evaluate('window.__app.scene.objects[0].mesh.faces.size')) === 2);

  await t.key('Tab', 'Tab');
  t.check('entered edit mode on imported mesh', (await mode()) === 'edit');
  const bFaces = () => t.evaluate('window.__app.scene.editObject.mesh.faces.size');
  const facesBeforeBridge = await bFaces();

  // Ctrl+E in vert mode: status message, no mutation.
  await t.key('1', 'Digit1');
  await t.key('a', 'KeyA'); // select all verts
  await t.key('e', 'KeyE', 2); // ctrl+e
  t.check('Ctrl+E in vert mode shows edge-mode-only status',
    (await t.evaluate(`document.getElementById('status').textContent`)).includes('edge mode only'));
  t.check('Ctrl+E in vert mode mutates nothing', (await bFaces()) === facesBeforeBridge);

  // Edge mode, select all → Ctrl+E bridges the two loops (+4 faces).
  await t.key('2', 'Digit2');
  await t.key('a', 'KeyA'); // select all 8 edges
  t.check('all 8 edges selected for bridge', (await editSel('e.edges.size')) === 8);
  await t.key('e', 'KeyE', 2); // ctrl+e
  t.check('bridge added 4 faces', (await bFaces()) === facesBeforeBridge + 4,
    `${facesBeforeBridge} → ${await bFaces()}`);
  t.check('bridge status reported', (await t.evaluate(`document.getElementById('status').textContent`)).startsWith('Bridged'));

  await t.key('z', 'KeyZ', 2); // ctrl-z
  t.check('Ctrl+Z restores pre-bridge faces', (await bFaces()) === facesBeforeBridge);

  // --- P5-3: bevel edges (Ctrl+B) ---
  // Fresh cube via OBJ import (the bridge section left an imported mesh behind).
  await t.evaluate(`(() => {
    const s = window.__app.scene;
    if (s.editMode) s.exitEditMode();
    for (const o of [...s.objects]) s.remove(o.id);
  })()`);
  const cubeObj = 'v -1 -1 -1\nv 1 -1 -1\nv 1 1 -1\nv -1 1 -1\nv -1 -1 1\nv 1 -1 1\nv 1 1 1\nv -1 1 1\n' +
    'f 5 6 7 8\nf 2 1 4 3\nf 6 2 3 7\nf 1 5 8 4\nf 8 7 3 4\nf 1 2 6 5\n';
  await t.evaluate('window.__app.io.importObj(' + JSON.stringify(cubeObj) + ')');
  t.check('cube OBJ imported (8 verts, 6 faces)',
    (await t.evaluate('window.__app.scene.objects[0].mesh.verts.size')) === 8 &&
    (await t.evaluate('window.__app.scene.objects[0].mesh.faces.size')) === 6);

  await t.key('Tab', 'Tab');
  t.check('entered edit mode on imported cube', (await mode()) === 'edit');
  await t.key('2', 'Digit2'); // edge select
  await t.key('a', 'KeyA', 1); // deselect all
  const bvFaces = () => t.evaluate('window.__app.scene.editObject.mesh.faces.size');
  const facesPreBevel = await bvFaces();

  // Find a pickable (front-facing) edge the same way loop cut does.
  const bvEdge = await t.evaluate(`(() => {
    const app = window.__app, obj = app.scene.editObject, cam = app.camera;
    const canvas = document.querySelector('canvas');
    const rect = canvas.getBoundingClientRect();
    const w = rect.width, h = rect.height;
    const vp = cam.projMatrix(w / h).mul(cam.viewMatrix());
    for (const [key, e] of obj.mesh.edges()) {
      const a = obj.mesh.verts.get(e.v0).co, b = obj.mesh.verts.get(e.v1).co;
      const mid = { x: (a.x+b.x)/2, y: (a.y+b.y)/2, z: (a.z+b.z)/2 };
      const world = obj.transform.matrix().transformPoint(mid);
      const ndc = vp.transformPoint(world);
      const cssX = (ndc.x + 1) / 2 * w, cssY = (1 - ndc.y) / 2 * h;
      const hit = app.renderer.pickElement(app.scene, cam, cssX, cssY, 'edge');
      if (hit && hit.kind === 'edge' && hit.key === key) {
        return { key, pageX: rect.left + cssX, pageY: rect.top + cssY };
      }
    }
    return null;
  })()`);
  t.check('a front edge is pickable for bevel', bvEdge !== null);

  // Select it, then Ctrl+B → drag right to grow width → LMB confirm. +1 face.
  await t.click(Math.round(bvEdge.pageX), Math.round(bvEdge.pageY));
  t.check('one edge selected before bevel', (await editSel('e.edges.size')) === 1);
  await t.mouse('mouseMoved', Math.round(bvEdge.pageX), Math.round(bvEdge.pageY));
  await t.key('b', 'KeyB', 2); // ctrl+b
  t.check('bevel modal is live', await t.evaluate(`document.getElementById('status').textContent.startsWith('Bevel')`));
  await t.mouse('mouseMoved', Math.round(bvEdge.pageX) + 70, Math.round(bvEdge.pageY));
  await t.sleep(120);
  await t.click(Math.round(bvEdge.pageX) + 70, Math.round(bvEdge.pageY)); // confirm
  t.check('bevel one edge grows the cube to 7 faces',
    (await bvFaces()) === facesPreBevel + 1, `${facesPreBevel} → ${await bvFaces()}`);
  t.check('bevel leaves 10 verts',
    (await t.evaluate('window.__app.scene.editObject.mesh.verts.size')) === 10);

  // Ctrl+Z restores the 6-face cube.
  await t.key('z', 'KeyZ', 2);
  t.check('Ctrl+Z restores 6 faces after bevel', (await bvFaces()) === facesPreBevel);

  // Esc cancels a bevel without touching the mesh.
  await t.key('a', 'KeyA', 1); // deselect
  await t.click(Math.round(bvEdge.pageX), Math.round(bvEdge.pageY)); // reselect the edge
  const facesBeforeCancel = await bvFaces();
  await t.mouse('mouseMoved', Math.round(bvEdge.pageX), Math.round(bvEdge.pageY));
  await t.key('b', 'KeyB', 2); // ctrl+b
  await t.mouse('mouseMoved', Math.round(bvEdge.pageX) + 70, Math.round(bvEdge.pageY));
  await t.sleep(80);
  await t.key('Escape', 'Escape');
  t.check('Esc cancels bevel without changes', (await bvFaces()) === facesBeforeCancel);

  // --- P5-4: frame selection (.), fill (F), subdivide (Ctrl+D) ---
  // Fresh cube via OBJ, back in object mode, moved to (3, 0, 4).
  await t.evaluate(`(() => {
    const s = window.__app.scene;
    if (s.editMode) s.exitEditMode();
    for (const o of [...s.objects]) s.remove(o.id);
  })()`);
  await t.evaluate('window.__app.io.importObj(' + JSON.stringify(cubeObj) + ')');
  // Move the cube using the mesh's own Vec3 class (not exposed globally).
  await t.evaluate(`(() => {
    const obj = window.__app.scene.objects[0];
    const V = obj.mesh.verts.values().next().value.co.constructor;
    obj.transform = obj.transform.withPosition(new V(3, 0, 4));
  })()`);
  t.check('cube selected in object mode before frame',
    (await mode()) === 'object' && (await t.evaluate('window.__app.scene.selection.size')) > 0);

  // Period frames the selection: the orbit target snaps to the cube's center.
  await t.key('.', 'Period');
  const tgt = await t.evaluate('({x: window.__app.camera.target.x, y: window.__app.camera.target.y, z: window.__app.camera.target.z})');
  t.check('Period recenters camera target onto the moved cube',
    Math.abs(tgt.x - 3) < 0.5 && Math.abs(tgt.y - 0) < 0.5 && Math.abs(tgt.z - 4) < 0.5,
    `target ${tgt.x.toFixed(2)},${tgt.y.toFixed(2)},${tgt.z.toFixed(2)}`);

  // Fill (F): enter edit, delete one face directly, select its boundary verts,
  // F rebuilds the face → back to 6, Ctrl+Z undoes the fill (→ 5).
  await t.key('Tab', 'Tab');
  t.check('entered edit mode for fill', (await mode()) === 'edit');
  const fillSetup = await t.evaluate(`(() => {
    const s = window.__app.scene, m = s.editObject.mesh, e = s.editMode;
    const fid = [...m.faces.keys()][0];
    const verts = [...m.faces.get(fid).verts];
    m.deleteFaces([fid]);
    e.setElementMode('vert', m); e.clearSelection();
    for (const v of verts) e.verts.add(v); e.touch();
    return { faces: m.faces.size, sel: e.verts.size };
  })()`);
  t.check('deleted a face and selected its 4 boundary verts',
    fillSetup.faces === 5 && fillSetup.sel === 4);
  await t.key('f', 'KeyF');
  t.check('F fills the hole back to 6 faces',
    (await t.evaluate('window.__app.scene.editObject.mesh.faces.size')) === 6);
  t.check('filled face is a quad',
    await t.evaluate('[...window.__app.scene.editObject.mesh.faces.values()].every((f) => f.verts.length === 4)'));
  await t.key('z', 'KeyZ', 2); // ctrl-z
  t.check('Ctrl+Z undoes the fill (back to 5 faces)',
    (await t.evaluate('window.__app.scene.editObject.mesh.faces.size')) === 5);

  // Subdivide (Ctrl+D): fresh cube, select one face, Ctrl+D grows faces by 3.
  await t.evaluate(`(() => {
    const s = window.__app.scene;
    if (s.editMode) s.exitEditMode();
    for (const o of [...s.objects]) s.remove(o.id);
  })()`);
  await t.evaluate('window.__app.io.importObj(' + JSON.stringify(cubeObj) + ')');
  await t.key('Tab', 'Tab');
  await t.key('3', 'Digit3'); // face mode
  await t.evaluate(`(() => {
    const s = window.__app.scene, m = s.editObject.mesh, e = s.editMode;
    e.clearSelection(); e.faces.add([...m.faces.keys()][0]); e.touch();
  })()`);
  const facesPreSubdiv = await t.evaluate('window.__app.scene.editObject.mesh.faces.size');
  await t.key('d', 'KeyD', 2); // ctrl+d
  const facesPostSubdiv = await t.evaluate('window.__app.scene.editObject.mesh.faces.size');
  t.check('Ctrl+D subdivides one face, growing face count by 3',
    facesPostSubdiv === facesPreSubdiv + 3, `${facesPreSubdiv} → ${facesPostSubdiv}`);
  t.check('subdivide selects the 4 child faces', (await editSel('e.faces.size')) === 4);
  await t.key('z', 'KeyZ', 2); // ctrl-z
  t.check('Ctrl+Z undoes the subdivide',
    (await t.evaluate('window.__app.scene.editObject.mesh.faces.size')) === facesPreSubdiv);

  // --- P6-5: proportional editing (O) ---
  // Fresh cube (corners at ±1), edit + vert mode, select ONE corner (vert 0).
  await t.evaluate(`(() => {
    const s = window.__app.scene;
    if (s.editMode) s.exitEditMode();
    for (const o of [...s.objects]) s.remove(o.id);
  })()`);
  await t.evaluate('window.__app.io.importObj(' + JSON.stringify(cubeObj) + ')');
  await t.key('Tab', 'Tab');
  await t.key('1', 'Digit1');
  const selCorner = `(() => {
    const e = window.__app.scene.editMode;
    e.clearSelection(); e.verts.add(0); e.touch();
    return e.verts.size;
  })()`;
  t.check('selected a single corner vert', (await t.evaluate(selCorner)) === 1);

  const vco = (id) => t.evaluate(`(() => { const c = window.__app.scene.editObject.mesh.verts.get(${id}).co; return { x: c.x, y: c.y, z: c.z }; })()`);
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  // vert 0 = (-1,-1,-1) selected; vert 6 = (1,1,1) is the diagonally-opposite
  // corner (distance 2√3 ≈ 3.46); vert 1 = (1,-1,-1) is an edge neighbour (dist 2).
  const before0 = await vco(0), before1 = await vco(1), before6 = await vco(6);

  // O toggles proportional editing on (status message).
  await t.key('o', 'KeyO');
  t.check('O turns proportional editing on (status)',
    (await t.evaluate("document.getElementById('status').textContent")).includes('on'));

  // Grab starts from the canvas center; wheel up to grow the falloff radius past
  // the cube edge length (2) so the edge neighbour is inside the influence but the
  // far corner (dist 2√3 ≈ 3.46) is not. Read the radius back from the status line
  // and stop once it clears 2.5 — keeps it safely under the far corner's distance.
  const readRadius = () => t.evaluate(`(() => { const m = document.getElementById('status').textContent.match(/radius:\\s*([0-9.]+)/i); return m ? parseFloat(m[1]) : null; })()`);
  await t.mouse('mouseMoved', ccX, ccY);
  await t.key('g', 'KeyG');
  let radius = null;
  for (let i = 0; i < 12; i++) {
    await t.mouse('mouseWheel', ccX, ccY, 'none', { deltaX: 0, deltaY: -120 });
    await t.sleep(20);
    radius = await readRadius();
    if (radius !== null && radius >= 2.5) break;
  }
  t.check('wheel adjusts the proportional radius (status)',
    radius !== null && radius >= 2.5 && radius < 3.4, `radius=${radius}`);
  await t.mouse('mouseMoved', ccX + 120, ccY - 70);
  await t.sleep(100);
  await t.click(ccX + 120, ccY - 70); // LMB confirms

  const after0 = await vco(0), after1 = await vco(1), after6 = await vco(6);
  const d0 = dist(after0, before0), d1 = dist(after1, before1), d6 = dist(after6, before6);
  t.check('selected corner moved', d0 > 1e-4, `d0=${d0.toFixed(4)}`);
  t.check('diagonally-opposite vert did not move (beyond radius)', d6 < 1e-4, `d6=${d6.toFixed(6)}`);
  t.check('edge-neighbour moved a nonzero amount less than the selected vert',
    d1 > 1e-4 && d1 < d0 - 1e-6, `d1=${d1.toFixed(4)} d0=${d0.toFixed(4)}`);

  // Ctrl+Z restores every vert.
  await t.key('z', 'KeyZ', 2);
  const undo0 = await vco(0), undo1 = await vco(1);
  t.check('Ctrl+Z restores the proportional move',
    dist(undo0, before0) < 1e-6 && dist(undo1, before1) < 1e-6);

  // O off → G only moves the selected vert; the neighbour stays put.
  await t.key('o', 'KeyO');
  t.check('O turns proportional editing off (status)',
    (await t.evaluate("document.getElementById('status').textContent")).includes('off'));
  await t.evaluate(selCorner); // undo may have refreshed the selection
  const off0b = await vco(0), off1b = await vco(1);
  await t.mouse('mouseMoved', ccX, ccY); // reset the grab origin so the move has a delta
  await t.key('g', 'KeyG');
  await t.mouse('mouseMoved', ccX + 120, ccY - 70);
  await t.sleep(100);
  await t.click(ccX + 120, ccY - 70);
  const off0a = await vco(0), off1a = await vco(1);
  t.check('proportional off: selected vert moves', dist(off0a, off0b) > 1e-4);
  t.check('proportional off: neighbour stays put', dist(off1a, off1b) < 1e-6);

  // --- P7-2: separate selection (P) ---
  // Reload for a pristine single-cube scene (earlier checks left the mesh moved).
  await t.send('Page.reload', {});
  await t.until('!!window.__app');
  await t.sleep(200);

  await t.key('Tab', 'Tab');           // enter edit mode on the cube
  t.check('P7-2: entered edit mode', (await mode()) === 'edit');
  await t.key('3', 'Digit3');          // face select mode
  // Select exactly one face deterministically.
  await t.evaluate(`(() => {
    const e = window.__app.scene.editMode, m = window.__app.scene.editObject.mesh;
    e.faces.clear(); e.faces.add([...m.faces.keys()][0]); e.touch();
  })()`);
  const objCountBeforeSep = await t.evaluate('window.__app.scene.objects.length');

  await t.key('p', 'KeyP');            // separate
  t.check('P adds a second object to the outliner',
    (await t.evaluate('window.__app.scene.objects.length')) === objCountBeforeSep + 1);
  t.check('stays in edit mode on the source', (await mode()) === 'edit');
  t.check('source mesh drops to 5 faces',
    (await t.evaluate('window.__app.scene.editObject.mesh.faces.size')) === 5);
  t.check('new object is named <name>.sep',
    await t.evaluate(`window.__app.scene.objects.at(-1).name.endsWith('.sep')`));
  t.check('new object has 4 verts / 1 face',
    await t.evaluate('window.__app.scene.objects.at(-1).mesh.verts.size') === 4 &&
    await t.evaluate('window.__app.scene.objects.at(-1).mesh.faces.size') === 1);

  await t.key('z', 'KeyZ', 2);         // Ctrl+Z
  t.check('Ctrl+Z removes the new object',
    (await t.evaluate('window.__app.scene.objects.length')) === objCountBeforeSep);
  t.check('Ctrl+Z restores the source to 6 faces',
    (await t.evaluate('window.__app.scene.editObject.mesh.faces.size')) === 6);
});
