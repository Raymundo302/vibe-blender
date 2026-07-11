/**
 * UR5-4 e2e — Select modes: Box / Circle / Lasso, W cycles.
 *
 * Covers: (1) W cycles the three modes (status text + input.selectMode);
 * (2) circle paint selects near verts + wheel changes radius state;
 * (3) lasso loop around the cube selects all verts, plain lasso elsewhere
 * replaces the selection; (4) circle + lasso each commit exactly one undo entry
 * and Ctrl+Z restores the prior selection; (5) box select via B still works.
 *
 * Run: E2E_PORT=9435 node e2e/select-modes.mjs
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  const editSel = (expr) => t.evaluate(`(() => { const e = window.__app.scene.editMode; return e ? ${expr} : null; })()`);
  const selectMode = () => t.evaluate('window.__app.input.selectMode');
  const activeOp = () => t.evaluate('window.__app.input.activeOperatorName');
  const pushCount = () => t.evaluate('window.__app.undo.pushCount');
  const radius = () => t.evaluate('window.__app.input.circleSelectRadius');
  const statusText = () => t.evaluate(`(document.getElementById('status')||{}).textContent`);

  // Enter edit mode on the default cube, vert mode, clean selection.
  await t.until('!!window.__app.scene');
  await t.key('Tab', 'Tab');
  t.check('entered edit mode', (await t.evaluate('window.__app.scene.mode')) === 'edit');
  await t.key('1', 'Digit1');
  await t.key('a', 'KeyA', 1); // Alt+A deselect all

  // Project all cube verts to page space (reused across tools).
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

  // --- (1) W cycles Box → Circle → Lasso → Box (status text) ---
  t.check('starts in Box select mode', (await selectMode()) === 'box');
  await t.key('w', 'KeyW');
  t.check('W → Circle mode', (await selectMode()) === 'circle');
  t.check('status announces Circle', /Select:\s*Circle/.test(await statusText()));
  await t.key('w', 'KeyW');
  t.check('W → Lasso mode', (await selectMode()) === 'lasso');
  t.check('status announces Lasso', /Select:\s*Lasso/.test(await statusText()));
  await t.key('w', 'KeyW');
  t.check('W → back to Box mode', (await selectMode()) === 'box');
  t.check('status announces Box', /Select:\s*Box/.test(await statusText()));

  // --- (2) Circle: paint near verts → selected; wheel changes radius ---
  await t.key('w', 'KeyW'); // box → circle
  t.check('mode is circle for paint test', (await selectMode()) === 'circle');
  await t.key('a', 'KeyA', 1); // deselect all
  const push0 = await pushCount();
  await t.key('b', 'KeyB'); // B starts area select = circle
  t.check('B started the Circle Select operator', (await activeOp()) === 'Circle Select');

  // Wheel grows the brush radius (state changes).
  const r0 = await radius();
  await t.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: minX, y: minY, deltaX: 0, deltaY: -120 });
  await t.sleep(60);
  const r1 = await radius();
  t.check('wheel changed the circle radius state', r1 !== r0, `${r0} → ${r1}`);

  // Paint a stroke visiting every projected vert → projection-only membership
  // selects them all (selects through geometry, like box today).
  await t.mouse('mouseMoved', Math.round(vertPts[0].pageX), Math.round(vertPts[0].pageY));
  await t.mouse('mousePressed', Math.round(vertPts[0].pageX), Math.round(vertPts[0].pageY), 'left');
  for (const p of vertPts) {
    await t.mouse('mouseMoved', Math.round(p.pageX), Math.round(p.pageY), 'left');
    await t.sleep(25);
  }
  await t.mouse('mouseReleased', Math.round(vertPts.at(-1).pageX), Math.round(vertPts.at(-1).pageY), 'left');
  await t.sleep(80);
  const paintedCount = await editSel('e.verts.size');
  t.check('circle paint selected the cube verts', paintedCount >= 4, `${paintedCount} verts`);

  // End the tool (Esc) → commits exactly ONE undo entry.
  await t.key('Escape', 'Escape');
  t.check('circle operator ended after Esc', (await activeOp()) === null);
  t.check('circle overlay removed', await t.evaluate(`!document.querySelector('.circle-select-overlay')`));
  t.check('circle committed exactly one undo entry', (await pushCount()) === push0 + 1);

  // Ctrl+Z restores the prior (empty) selection.
  await t.key('z', 'KeyZ', 2);
  t.check('Ctrl+Z restores the pre-circle selection', (await editSel('e.verts.size')) === 0);

  // --- (3)+(4) Lasso: loop around the cube → all verts; one undo; replace ---
  await t.key('w', 'KeyW'); // circle → lasso
  t.check('mode is lasso', (await selectMode()) === 'lasso');
  await t.key('a', 'KeyA', 1); // deselect all
  const lassoPush0 = await pushCount();

  // Draw a rectangular loop around the whole cube.
  const drawLoop = async (corners, shift = false) => {
    await t.key('b', 'KeyB');
    await t.mouse('mouseMoved', corners[0][0], corners[0][1]);
    await t.mouse('mousePressed', corners[0][0], corners[0][1], 'left');
    for (const [x, y] of corners.slice(1)) {
      await t.mouse('mouseMoved', x, y, 'left');
      await t.sleep(30);
    }
    const last = corners.at(-1);
    await t.mouse('mouseReleased', last[0], last[1], 'left', shift ? { modifiers: 8 } : {});
    await t.sleep(100);
  };
  const around = [
    [Math.round(minX - 30), Math.round(minY - 30)],
    [Math.round(maxX + 30), Math.round(minY - 30)],
    [Math.round(maxX + 30), Math.round(maxY + 30)],
    [Math.round(minX - 30), Math.round(maxY + 30)],
  ];
  await drawLoop(around);
  t.check('lasso around the cube selects all 8 verts', (await editSel('e.verts.size')) === 8);
  t.check('lasso committed exactly one undo entry', (await pushCount()) === lassoPush0 + 1);

  // Ctrl+Z restores the prior (empty) selection.
  await t.key('z', 'KeyZ', 2);
  t.check('Ctrl+Z restores the pre-lasso selection', (await editSel('e.verts.size')) === 0);

  // Re-select all with a lasso, then a PLAIN lasso over empty space REPLACES it.
  await drawLoop(around);
  t.check('lasso re-selected all 8 verts', (await editSel('e.verts.size')) === 8);
  const rect = await t.evaluate('(() => { const r = document.querySelector("canvas").getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()');
  const emptyLoop = [
    [Math.round(rect.x + 8), Math.round(rect.y + 8)],
    [Math.round(rect.x + 60), Math.round(rect.y + 8)],
    [Math.round(rect.x + 60), Math.round(rect.y + 60)],
    [Math.round(rect.x + 8), Math.round(rect.y + 60)],
  ];
  await drawLoop(emptyLoop); // plain (no shift) → replace
  t.check('plain lasso over empty space replaces selection (now empty)',
    (await editSel('e.verts.size')) === 0);

  // --- (5) Box select via B still works (regression) ---
  await t.key('w', 'KeyW'); // lasso → box
  t.check('mode back to box', (await selectMode()) === 'box');
  await t.key('a', 'KeyA', 1); // deselect all
  t.check('cleared before box regression', (await editSel('e.verts.size')) === 0);
  await t.key('b', 'KeyB');
  t.check('B started the Box Select operator', (await activeOp()) === 'Box Select');
  await t.mouse('mouseMoved', Math.round(minX - 25), Math.round(minY - 25));
  await t.mouse('mousePressed', Math.round(minX - 25), Math.round(minY - 25), 'left');
  await t.sleep(50);
  await t.mouse('mouseMoved', Math.round(maxX + 25), Math.round(maxY + 25));
  await t.sleep(50);
  await t.mouse('mouseReleased', Math.round(maxX + 25), Math.round(maxY + 25), 'left');
  await t.sleep(100);
  t.check('B box select still selects all 8 verts', (await editSel('e.verts.size')) === 8);

  await t.screenshot(process.env.E2E_SHOT ?? '/tmp/vibe-blender-select-modes.png');
});
