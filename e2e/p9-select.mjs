/**
 * P9-6 e2e — Selection & viewport UX: loop select (Alt+click), X-ray box select
 * (Alt+Z), edge crease (Shift+E), camera-to-view (Ctrl+Alt+Numpad0).
 * Run with the dev server up (under flock):
 *   flock /tmp/vibe-blender-e2e.lock node e2e/p9-select.mjs
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  // Layout workspace so the topbar chips are on screen; clean single-cube scene.
  await t.evaluate(`document.querySelector('.wsp-tab[data-workspace="Layout"]')?.click()`);
  await t.sleep(120);
  const saved = await t.evaluate('window.__app.io.serialize()');
  await t.evaluate(`window.__app.io.apply(${JSON.stringify(saved)})`);
  await t.key('Escape', 'Escape', 0); // dismiss splash
  await t.sleep(80);

  const rect = async () => t.evaluate(`(() => {
    const r = document.querySelector('canvas').getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  })()`);
  const R = await rect();
  const cx = Math.round(R.x + R.w / 2);
  const cy = Math.round(R.y + R.h / 2);

  // ========================================================================
  // 1. X-ray select-through — clicking the occluded back corner of the cube
  //    picks it only with X-ray ON. (Box select is a pure screen-projection
  //    test with no depth, unchanged by X-ray; select-through lives in the
  //    element-pick/click path — see the Result note.)
  // ========================================================================
  await t.evaluate(`(() => {
    const s = window.__app.scene;
    if (s.editMode) s.exitEditMode();
    s.selectOnly(s.objects[0].id);
    s.enterEditMode(s.objects[0].id);
    s.editMode.setElementMode('vert', s.editObject.mesh);
    s.editMode.clearSelection();
  })()`);
  await t.sleep(80);

  // Screen position of the back-bottom corner vert (id 0 = (-1,-1,-1)), which is
  // hidden behind the cube in the default orbit view.
  const backVert = await t.evaluate(`(() => {
    const s = window.__app.scene, o = s.editObject, m = o.mesh, cam = window.__app.camera;
    const cv = document.querySelector('canvas'), r = cv.getBoundingClientRect();
    const mvp = cam.projMatrix(cv.width / cv.height).mul(cam.viewMatrix()).mul(o.transform.matrix());
    // The vert with the most negative view-space Z (farthest from the camera).
    let far = null, farZ = Infinity;
    const view = cam.viewMatrix().mul(o.transform.matrix());
    for (const [id, v] of m.verts) { const p = view.transformPoint(v.co); if (p.z < farZ) { farZ = p.z; far = id; } }
    const co = m.verts.get(far).co, p = mvp.transformPoint(co);
    return { id: far, px: r.left + ((p.x + 1) / 2) * r.width, py: r.top + ((1 - p.y) / 2) * r.height };
  })()`);

  // X-ray OFF: the occluded back vert is NOT pickable.
  await t.click(backVert.px, backVert.py, 'left', 0);
  await t.sleep(80);
  t.check('x-ray OFF: clicking the occluded back vert does NOT select it',
    (await t.evaluate(`window.__app.scene.editMode.verts.has(${backVert.id})`)) === false);

  // Toggle X-ray ON via Alt+Z, verify the topbar chip mirrors it.
  await t.key('z', 'KeyZ', 1); // Alt+Z
  await t.sleep(80);
  t.check('Alt+Z lights the topbar X-ray chip',
    (await t.evaluate(`document.querySelector('[data-action="xray-toggle"]').classList.contains('topbar-btn-on')`)) === true);

  await t.evaluate(`window.__app.scene.editMode.clearSelection()`);
  await t.click(backVert.px, backVert.py, 'left', 0);
  await t.sleep(80);
  t.check('x-ray ON: the same click selects the back vert (select-through)',
    (await t.evaluate(`window.__app.scene.editMode.verts.has(${backVert.id})`)) === true);

  // Turn X-ray back OFF for the rest of the suite.
  await t.key('z', 'KeyZ', 1);
  await t.sleep(60);
  t.check('Alt+Z toggles the X-ray chip back off',
    (await t.evaluate(`document.querySelector('[data-action="xray-toggle"]').classList.contains('topbar-btn-on')`)) === false);

  // ========================================================================
  // 2. Shift+E crease — drag sets crease > 0 on selected edges; Ctrl+Z clears.
  // ========================================================================
  await t.evaluate(`(() => {
    const s = window.__app.scene, m = s.editObject.mesh;
    s.editMode.setElementMode('edge', m);
    s.editMode.selectAll(m);
  })()`);
  await t.sleep(80);
  t.check('crease starts with no creased edges',
    (await t.evaluate('window.__app.scene.editObject.mesh.creases.size')) === 0);

  await t.mouse('mouseMoved', cx, cy); // baseline pointer for the drag origin
  await t.key('e', 'KeyE', 8); // Shift+E → CreaseOperator
  await t.sleep(80);
  await t.mouse('mouseMoved', cx + 160, cy); // horizontal drag → weight ≈ 0.8
  await t.sleep(60);
  await t.key('Enter', 'Enter', 0); // confirm
  await t.sleep(100);

  const creased = await t.evaluate('window.__app.scene.editObject.mesh.creases.size');
  const maxW = await t.evaluate(`Math.max(0, ...window.__app.scene.editObject.mesh.creases.values())`);
  t.check('Shift+E drag creases the selected edges', creased > 0, `creased=${creased}`);
  t.check('crease weight is > 0', maxW > 0, `maxWeight=${maxW.toFixed(3)}`);

  await t.key('z', 'KeyZ', 2); // Ctrl+Z
  await t.sleep(120);
  t.check('Ctrl+Z restores crease weights to 0',
    (await t.evaluate('window.__app.scene.editObject.mesh.creases.size')) === 0);

  await t.evaluate(`window.__app.scene.exitEditMode()`);
  await t.sleep(60);

  // ========================================================================
  // 3. Camera-to-view — Ctrl+Alt+Numpad0 snaps/creates the active camera.
  // ========================================================================
  t.check('scene has no camera to start', (await t.evaluate('window.__app.scene.activeCamera')) === null);

  await t.key('0', 'Numpad0', 3); // Ctrl(2)+Alt(1) + Numpad0
  await t.sleep(120);
  t.check('Ctrl+Alt+Numpad0 creates + activates a camera',
    (await t.evaluate('window.__app.scene.activeCamera !== null')) === true);
  t.check('status reads "Camera set to view"',
    (await t.evaluate(`document.getElementById('status').textContent`)) === 'Camera set to view');
  const posMatchesEye = await t.evaluate(`(() => {
    const cam = window.__app.scene.activeCamera, eye = window.__app.camera.eye;
    const p = cam.transform.position;
    return Math.hypot(p.x - eye.x, p.y - eye.y, p.z - eye.z);
  })()`);
  t.check('new camera sits at the current view eye', posMatchesEye < 1e-3, `dist=${posMatchesEye.toExponential(2)}`);

  await t.key('z', 'KeyZ', 2); // Ctrl+Z → remove the created camera
  await t.sleep(120);
  t.check('Ctrl+Z removes the created camera', (await t.evaluate('window.__app.scene.activeCamera')) === null);

  // Existing-camera path: add one at the origin, snap it, confirm it moved + undo.
  await t.evaluate(`(() => {
    const s = window.__app.scene;
    const c = s.addCamera('Camera');
    const V = c.transform.position.constructor;
    c.transform = c.transform.withPosition(new V(0, 0, 0));
    s.selectOnly(c.id);
  })()`);
  await t.sleep(80);
  await t.key('0', 'Numpad0', 3);
  await t.sleep(120);
  const movedDist = await t.evaluate(`(() => {
    const p = window.__app.scene.activeCamera.transform.position;
    return Math.hypot(p.x, p.y, p.z);
  })()`);
  t.check('Ctrl+Alt+Numpad0 moves an existing camera off the origin', movedDist > 1, `dist=${movedDist.toFixed(2)}`);
  await t.key('z', 'KeyZ', 2);
  await t.sleep(120);
  t.check('Ctrl+Z restores the camera to the origin',
    (await t.evaluate(`(() => { const p = window.__app.scene.activeCamera.transform.position; return Math.hypot(p.x, p.y, p.z); })()`)) < 1e-3);

  // ========================================================================
  // 4. Alt+click loop select — on a 4×4 torus (all quads) every loop is 4.
  // ========================================================================
  await t.evaluate(`(() => {
    const s = window.__app.scene;
    if (s.editMode) s.exitEditMode();
    const Mesh = s.objects[0].mesh.constructor;
    const Vec = s.objects[0].mesh.verts.get(0).co.constructor;
    const major = 4, minor = 4, Rr = 1.6, rr = 0.7;
    const m = new Mesh();
    const ids = [];
    for (let i = 0; i < major; i++) {
      const u = 2 * Math.PI * i / major;
      for (let j = 0; j < minor; j++) {
        const v = 2 * Math.PI * j / minor;
        const rad = Rr + rr * Math.cos(v);
        ids.push(m.addVert(new Vec(rad * Math.cos(u), rr * Math.sin(v), rad * Math.sin(u))));
      }
    }
    const idx = (i, j) => (i % major) * minor + (j % minor);
    for (let i = 0; i < major; i++)
      for (let j = 0; j < minor; j++)
        m.addFace([idx(i, j), idx(i, j + 1), idx(i + 1, j + 1), idx(i + 1, j)]);
    const o = s.add('LoopTorus', m);
    s.selectOnly(o.id);
    s.enterEditMode(o.id);
    s.editMode.setElementMode('edge', m);
    s.editMode.clearSelection();
    window.__loopIdx = idx;
  })()`);
  await t.sleep(100);

  // Project an edge midpoint (two vert ids) to page pixels.
  const edgeMid = (a, b) => t.evaluate(`(() => {
    const s = window.__app.scene, o = s.editObject, m = o.mesh, cam = window.__app.camera;
    const cv = document.querySelector('canvas'), r = cv.getBoundingClientRect();
    const mvp = cam.projMatrix(cv.width / cv.height).mul(cam.viewMatrix()).mul(o.transform.matrix());
    const A = m.verts.get(${a}).co, B = m.verts.get(${b}).co;
    const mid = A.add(B).scale(0.5);
    const p = mvp.transformPoint(mid);
    return { px: r.left + ((p.x + 1) / 2) * r.width, py: r.top + ((1 - p.y) / 2) * r.height };
  })()`);

  const idxOf = (i, j) => (i % 4) * 4 + (j % 4);

  // X-ray ON so the exact-midpoint pick lands on the intended edge regardless of
  // occlusion (the torus back faces would otherwise hide it).
  await t.key('z', 'KeyZ', 1);
  await t.sleep(60);

  // Minor-direction edge (i=0): loop = the minor ring of 4 edges.
  let mid = await edgeMid(idxOf(0, 0), idxOf(0, 1));
  await t.click(mid.px, mid.py, 'left', 1); // Alt+click
  await t.sleep(120);
  t.check('Alt+click selects a 4-edge loop',
    (await t.evaluate('window.__app.scene.editMode.edges.size')) === 4);

  // Shift+Alt+click a major-direction edge (j=0): adds a second, disjoint loop.
  mid = await edgeMid(idxOf(0, 0), idxOf(1, 0));
  await t.click(mid.px, mid.py, 'left', 1 | 8); // Alt+Shift
  await t.sleep(120);
  t.check('Shift+Alt+click adds a second loop (8 edges total)',
    (await t.evaluate('window.__app.scene.editMode.edges.size')) === 8);

  // Plain Alt+click replaces the selection with a single loop again.
  mid = await edgeMid(idxOf(0, 0), idxOf(0, 1));
  await t.click(mid.px, mid.py, 'left', 1);
  await t.sleep(120);
  t.check('plain Alt+click replaces the selection (back to 4)',
    (await t.evaluate('window.__app.scene.editMode.edges.size')) === 4);

  // Vertex-mode loop: the same ring selects its 4 verts.
  await t.evaluate(`(() => { const s = window.__app.scene; s.editMode.setElementMode('vert', s.editObject.mesh); s.editMode.clearSelection(); })()`);
  await t.sleep(60);
  mid = await edgeMid(idxOf(0, 0), idxOf(0, 1));
  await t.click(mid.px, mid.py, 'left', 1);
  await t.sleep(120);
  t.check('vertex-mode Alt+click selects the loop\'s 4 verts',
    (await t.evaluate('window.__app.scene.editMode.verts.size')) === 4);

  await t.key('z', 'KeyZ', 1); // X-ray back off

  // Restore a clean scene for later suites.
  await t.evaluate(`(() => {
    const s = window.__app.scene;
    if (s.editMode) s.exitEditMode();
    window.__app.io.apply(${JSON.stringify(saved)});
    window.__app.renderer.cameraViewId = null;
    window.__app.autosave.clear();
  })()`);
});
