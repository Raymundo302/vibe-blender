/**
 * UR5-7 e2e — Empty objects + camera Focus Object (DoF) & Look At target.
 * Run with the dev server up (unique E2E_PORT for parallel runs):
 *   E2E_PORT=9441 node e2e/empty-camera-targets.mjs
 *
 * Covers:
 *  (1) Shift+A → Empty appears in the outliner, is clickable in the viewport,
 *      and movable with G.
 *  (2) A camera with a Look At empty keeps the empty centered in the
 *      through-camera view even as the empty moves.
 *  (3) A Focus Object drives depth of field: with aperture > 0 the object the
 *      camera focuses on renders sharper than the other (and the sharpness
 *      ordering FLIPS when the focus object changes).
 *  (4) Deleting a target object leaves the camera rendering fine and the Camera
 *      tab pickers reading None.
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  // Layout workspace → Properties panel + Outliner on screen.
  await t.evaluate(`document.querySelector('.wsp-tab[data-workspace="Layout"]')?.click()`);
  await t.sleep(150);

  // Clean single-Cube scene; dismiss the splash so pointer events reach the canvas.
  const saved = await t.evaluate('window.__app.io.serialize()');
  await t.evaluate(`window.__app.io.apply(${JSON.stringify(saved)})`);
  await t.key('Escape', 'Escape', 0);
  await t.sleep(80);

  const rect = await t.evaluate(`(() => {
    const r = document.querySelector('canvas').getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  })()`);
  const cv = (fx, fy) => [Math.round(rect.x + rect.w * fx), Math.round(rect.y + rect.h * fy)];
  const status = () => t.evaluate('document.getElementById("status").textContent');

  // === Part 1: Shift+A → Empty ============================================
  // Empty the scene so the Empty is the only object at the origin (a default cube
  // there would win the center pick). Cursor stays at origin.
  await t.evaluate(`(() => { const s = window.__app.scene; if (s.editMode) s.exitEditMode(); for (const o of [...s.objects]) s.remove(o.id); })()`);
  await t.sleep(60);
  // Move the pointer over the canvas center first (Shift+A spawns at the cursor;
  // the modal Move reads the live pointer).
  const [ccx, ccy] = cv(0.5, 0.5);
  await t.mouse('mouseMoved', ccx, ccy);
  await t.sleep(30);

  const objCountBefore = await t.evaluate('window.__app.scene.objects.length');
  await t.key('a', 'KeyA', 8); // Shift+A
  await t.sleep(80);
  t.check('Shift+A opens the Add menu', await t.evaluate(`!!document.querySelector('.add-menu')`));
  t.check('Add menu lists an Empty item',
    await t.evaluate(`[...document.querySelectorAll('.add-menu-item')].some((b) => b.textContent === 'Empty')`));

  await t.evaluate(`[...document.querySelectorAll('.add-menu-item')].find((b) => b.textContent === 'Empty').click()`);
  await t.sleep(120);

  const emptyInfo = await t.evaluate(`(() => {
    const s = window.__app.scene;
    const e = s.objects.find((o) => o.kind === 'empty');
    return e ? { id: e.id, selected: s.selection.has(e.id), size: e.empty.displaySize } : null;
  })()`);
  t.check('Empty object was added', emptyInfo !== null && (await t.evaluate('window.__app.scene.objects.length')) === objCountBefore + 1);
  t.check('Empty has kind empty + default displaySize 1', emptyInfo && emptyInfo.size === 1);
  t.check('new Empty is selected', emptyInfo && emptyInfo.selected);
  const emptyId = emptyInfo.id;

  // Outliner: a row with the empty glyph + name.
  t.check('Empty appears in the outliner',
    await t.evaluate(`[...document.querySelectorAll('.outliner-row, .outliner-object')].some((r) => /Empty/.test(r.textContent))`)
    || await t.evaluate(`document.querySelector('.outliner')?.textContent.includes('Empty')`));

  // Clickable in the viewport: deselect (drops the gizmo, which otherwise wins
  // the pick at the origin), then click canvas center where the empty sits →
  // the icon pick path selects it.
  await t.evaluate('window.__app.scene.deselectAll()');
  await t.sleep(60);
  await t.mouse('mouseMoved', ccx, ccy);
  await t.mouse('mousePressed', ccx, ccy, 'left');
  await t.mouse('mouseReleased', ccx, ccy, 'left');
  await t.sleep(120);
  t.check('clicking the Empty in the viewport selects it',
    (await t.evaluate(`window.__app.scene.selection.has(${emptyId}) && window.__app.scene.selection.size === 1`)));

  // Movable with G: start Move, drag the pointer, confirm with LMB.
  const epos = () => t.evaluate(`(() => { const p = window.__app.scene.get(${emptyId}).transform.position; return [p.x, p.y, p.z]; })()`);
  const startPos = await epos();
  await t.mouse('mouseMoved', ccx, ccy);
  await t.key('g', 'KeyG');
  await t.sleep(80);
  const [dragX, dragY] = [ccx + 120, ccy + 40];
  await t.mouse('mouseMoved', dragX, dragY);
  await t.sleep(80);
  t.check('G starts a Move on the Empty', (await status()).startsWith('Move'), await status());
  const during = await epos();
  t.check('pointer move translates the Empty',
    Math.abs(during[0] - startPos[0]) + Math.abs(during[1] - startPos[1]) + Math.abs(during[2] - startPos[2]) > 0.1,
    during.map((v) => v.toFixed(2)).join(','));
  await t.mouse('mousePressed', dragX, dragY, 'left');
  await t.mouse('mouseReleased', dragX, dragY, 'left');
  await t.sleep(100);

  // === Part 2: Look At keeps the target centered ==========================
  // Reset to a clean scene, then build camera + a look-at empty in-page.
  await t.evaluate(`window.__app.io.apply(${JSON.stringify(saved)})`);
  await t.sleep(80);
  const ids = await t.evaluate(`(() => {
    const s = window.__app.scene;
    if (s.editMode) s.exitEditMode();
    const V = s.objects[0].transform.position.constructor;
    const cam = s.addCamera('Camera');
    cam.transform = cam.transform.withPosition(new V(0, 0, 12));
    const emp = s.addEmpty('LookTarget');
    emp.transform = emp.transform.withPosition(new V(0, 0, 0));
    cam.camera.lookAtId = emp.id;
    s.activeCameraId = cam.id;
    s.selectOnly(cam.id);
    window.__app.renderer.cameraViewId = cam.id; // look through it
    return { camId: cam.id, empId: emp.id };
  })()`);
  await t.sleep(120);

  // Project the empty's world origin through the CURRENT (through-camera) view.
  const projEmpty = () => t.evaluate(`(() => {
    const s = window.__app.scene;
    const emp = s.get(${ids.empId});
    const vp = window.__app.renderer.currentViewProj(s, window.__app.camera);
    const p = s.worldTransformOf(emp).position;
    const ndc = vp.transformPoint(p);
    return { x: ndc.x, y: ndc.y };
  })()`);
  const c0 = await projEmpty();
  t.check('look-at target is centered in the through-camera view',
    Math.abs(c0.x) < 0.03 && Math.abs(c0.y) < 0.03, `ndc=(${c0.x.toFixed(3)},${c0.y.toFixed(3)})`);

  // Move the empty far to the side/up — the camera re-aims, keeping it centered.
  await t.evaluate(`(() => {
    const s = window.__app.scene;
    const emp = s.get(${ids.empId});
    const V = emp.transform.position.constructor;
    emp.transform = emp.transform.withPosition(new V(4, 3, -2));
  })()`);
  await t.sleep(80);
  const c1 = await projEmpty();
  t.check('moving the target keeps it centered (lookAt re-aims)',
    Math.abs(c1.x) < 0.03 && Math.abs(c1.y) < 0.03, `ndc=(${c1.x.toFixed(3)},${c1.y.toFixed(3)})`);

  await t.evaluate(`window.__app.renderer.cameraViewId = null`);

  // === Part 3: Focus Object drives depth of field =========================
  await t.evaluate(`window.__app.io.apply(${JSON.stringify(saved)})`);
  await t.sleep(80);
  // Build the DoF scene: two COMPACT cubes at different depths, well separated on
  // screen (a wide 24mm lens), against a dark flat world so each cube is a crisp
  // bright/dark silhouette (high local contrast). Screen sizes are matched
  // (scale ∝ depth) so the comparison isn't confounded by size. The cube mesh
  // comes from cloning the freshly-applied default cube.
  const dofIds = await t.evaluate(`(() => {
    const s = window.__app.scene;
    if (s.editMode) s.exitEditMode();
    const proto = s.objects.find((o) => o.kind === 'mesh');
    const makeCubeMesh = () => proto.mesh.clone();
    for (const o of [...s.objects]) s.remove(o.id);
    // Dark flat world for maximal cube/background contrast.
    s.world = { mode: 'flat', color: [0.02, 0.02, 0.02], horizon: [0.02, 0.02, 0.02], zenith: [0.02, 0.02, 0.02], strength: 1, hdri: null, hdriImage: null };
    const V = window.__app.camera.target.constructor;
    const near = s.add('Near', makeCubeMesh());
    near.transform = near.transform.withPosition(new V(-4, 0, 12)).withScale(new V(0.9, 0.9, 0.9)); // dist ~8.9
    const far = s.add('Far', makeCubeMesh());
    far.transform = far.transform.withPosition(new V(4, 0, 2)).withScale(new V(2.0, 2.0, 2.0)); // dist ~18.4
    s.addLight('Sun', 'sun'); // default identity rotation → lights the camera-facing faces
    const cam = s.addCamera('Camera');
    cam.transform = cam.transform.withPosition(new V(0, 0, 20));
    cam.camera.focalLength = 24; // wide → the cubes can spread apart on screen
    s.activeCameraId = cam.id;
    s.selectOnly(cam.id);
    return { nearId: near.id, farId: far.id, camId: cam.id };
  })()`);
  await t.sleep(80);

  // Local-contrast sharpness metric over a patch of the render-result canvas:
  // the spatial VARIANCE of luminance (the P9 DoF prior art). A sharply-focused
  // object is a crisp bright/dark step (bimodal → high variance); defocusing
  // spreads its edge into a ramp (lower variance). Variance is robust to path-
  // tracer grain, which the raw Laplacian is NOT (defocused regions are noisier
  // at fixed spp, which inverts a gradient/Laplacian metric).
  await t.evaluate(`window.__sharp = (x0f, x1f, y0f, y1f) => {
    const cvs = window.__renderEngine.canvas();
    const ctx = cvs.getContext('2d');
    const w = cvs.width, h = cvs.height;
    const x0 = Math.floor(w * x0f), x1 = Math.floor(w * x1f);
    const y0 = Math.floor(h * y0f), y1 = Math.floor(h * y1f);
    const pw = x1 - x0, ph = y1 - y0, n = pw * ph;
    const d = ctx.getImageData(x0, y0, pw, ph).data;
    let s = 0, s2 = 0;
    for (let i = 0; i < d.length; i += 4) {
      const L = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      s += L; s2 += L * L;
    }
    const m = s / n;
    return s2 / n - m * m;
  }; true`);

  // Project a cube's world center to a screen fraction through the ACTIVE
  // camera, at the render-window aspect (so the sample patches land on each cube
  // regardless of window shape / which side each ends up on).
  await t.evaluate(`window.__projScreen = (objId) => {
    const s = window.__app.scene;
    const cam = s.activeCamera;
    const m = s.cameraWorldMatrix(cam).m;
    const ex = m[12], ey = m[13], ez = m[14];
    const rx = m[0], ry = m[1], rz = m[2];
    const ux = m[4], uy = m[5], uz = m[6];
    const fx = -m[8], fy = -m[9], fz = -m[10];
    const p = s.worldTransformOf(s.get(objId)).position;
    const dx = p.x - ex, dy = p.y - ey, dz = p.z - ez;
    const zc = dx * fx + dy * fy + dz * fz;
    const xc = dx * rx + dy * ry + dz * rz;
    const yc = dx * ux + dy * uy + dz * uz;
    const th = 12 / cam.camera.focalLength; // tan(fovY/2)
    const cvs = window.__renderEngine.canvas();
    const aspect = cvs.width / cvs.height;
    const ndcx = xc / zc / (aspect * th);
    const ndcy = yc / zc / th;
    return { sx: (ndcx + 1) / 2, sy: (1 - ndcy) / 2 };
  }; true`);

  const nearC = await t.evaluate(`window.__projScreen(${dofIds.nearId})`);
  const farC = await t.evaluate(`window.__projScreen(${dofIds.farId})`);
  t.check('both DoF cubes project on-screen and are separated',
    nearC.sx > 0.05 && nearC.sx < 0.95 && farC.sx > 0.05 && farC.sx < 0.95 && Math.abs(nearC.sx - farC.sx) > 0.2,
    `near.sx=${nearC.sx.toFixed(2)} far.sx=${farC.sx.toFixed(2)}`);

  // A patch around each projected cube, sized to STRADDLE its silhouette edges
  // (where the sharp/blur contrast lives), with a background margin.
  const patch = (c) => [Math.max(0, c.sx - 0.14), Math.min(1, c.sx + 0.14), Math.max(0, c.sy - 0.16), Math.min(1, c.sy + 0.16)];
  const [nx0, nx1, ny0, ny1] = patch(nearC);
  const [fx0, fx1, fy0, fy1] = patch(farC);

  const SPP = 40;
  await t.evaluate('window.__renderEngine.setAperture(0.6)'); // window closed → just sets it
  await t.sleep(40);

  const renderTV = async (label, focusId, spp) => {
    await t.evaluate(`window.__app.scene.get(${dofIds.camId}).camera.focusObjectId = ${focusId}`);
    await t.evaluate('window.__renderEngine.start()');
    await t.sleep(60);
    // The render window's focus field shows the auto (focus-object) distance.
    const focusDist = parseFloat(await t.evaluate(`document.querySelector('.render-win-focus')?.placeholder || '0'`));
    const ok = await t.until(`window.__renderEngine.sample() >= ${spp}`, 120000);
    t.check(`${label}: render reaches >= ${spp} samples`, ok);
    const near = await t.evaluate(`window.__sharp(${nx0}, ${nx1}, ${ny0}, ${ny1})`);
    const far = await t.evaluate(`window.__sharp(${fx0}, ${fx1}, ${fy0}, ${fy1})`);
    await t.evaluate('window.__renderEngine.close()');
    await t.sleep(140);
    return { near, far, focusDist };
  };

  const focusNear = await renderTV('focus Near', dofIds.nearId, SPP);
  const focusFar = await renderTV('focus Far', dofIds.farId, SPP);

  // The Focus Object drives the tracer's focus distance per render: Near ≈ 8,
  // Far ≈ 20 (camera→target world-origin distance).
  t.check('Focus Object Near sets focus distance ≈ camera→Near distance',
    Math.abs(focusNear.focusDist - 8.94) < 0.5, `focusDist=${focusNear.focusDist}`);
  t.check('Focus Object Far sets focus distance ≈ camera→Far distance',
    Math.abs(focusFar.focusDist - 18.44) < 0.6, `focusDist=${focusFar.focusDist}`);

  // Within the focus-Near render, the Near (target) patch is sharper than the
  // defocused Far patch.
  t.check('focused target (Near) is sharper than the other object (Far)',
    focusNear.near > focusNear.far * 1.05,
    `near=${focusNear.near.toFixed(2)} far=${focusNear.far.toFixed(2)}`);
  // The sharpness ordering FLIPS with the focus object — the honest DoF proof.
  t.check('Near patch is sharper when focused on Near than on Far',
    focusNear.near > focusFar.near * 1.05,
    `focusNear=${focusNear.near.toFixed(2)} focusFar=${focusFar.near.toFixed(2)}`);
  t.check('Far patch is sharper when focused on Far than on Near',
    focusFar.far > focusNear.far * 1.05,
    `focusFar=${focusFar.far.toFixed(2)} focusNear=${focusNear.far.toFixed(2)}`);

  // === Part 4: deleting a target → camera renders fine, fields read None ===
  await t.evaluate(`window.__app.io.apply(${JSON.stringify(saved)})`);
  await t.sleep(80);
  const p4 = await t.evaluate(`(() => {
    const s = window.__app.scene;
    if (s.editMode) s.exitEditMode();
    const V = window.__app.camera.target.constructor;
    const cam = s.addCamera('Camera');
    cam.transform = cam.transform.withPosition(new V(0, 0, 10));
    const focusE = s.addEmpty('Focus');
    focusE.transform = focusE.transform.withPosition(new V(0, 0, 0));
    const lookE = s.addEmpty('Look');
    lookE.transform = lookE.transform.withPosition(new V(2, 0, 0));
    cam.camera.focusObjectId = focusE.id;
    cam.camera.lookAtId = lookE.id;
    s.activeCameraId = cam.id;
    s.selectOnly(cam.id);
    return { camId: cam.id, focusId: focusE.id, lookId: lookE.id };
  })()`);
  await t.sleep(80);
  // Delete both targets.
  await t.evaluate(`(() => { const s = window.__app.scene; s.remove(${p4.focusId}); s.remove(${p4.lookId}); s.selectOnly(${p4.camId}); })()`);
  await t.sleep(80);

  // The lookAt/focus refs are stale → treated as unset (defensive).
  t.check('deleted lookAt target resolves to null (defensive)',
    (await t.evaluate(`window.__app.scene.cameraLookAtTarget(window.__app.scene.get(${p4.camId})) === null`)));

  // Camera still renders fine (a few tracer samples, no exception).
  await t.evaluate(`window.__app.scene.get(${p4.camId}).camera.focusObjectId; window.__renderEngine.setAperture(0.4); true`);
  await t.evaluate('window.__renderEngine.start()');
  const rendered = await t.until('window.__renderEngine.sample() >= 3', 60000);
  t.check('camera with deleted targets still renders', rendered);
  await t.evaluate('window.__renderEngine.close()');
  await t.sleep(120);

  // Camera tab pickers read None.
  await t.evaluate(`document.querySelector('.properties-tab-btn[data-tab="camera"]')?.click()`);
  await t.sleep(150);
  t.check('Focus Object picker reads None after target deleted',
    (await t.evaluate(`document.querySelector('.camera-tab-select[data-field="focusObject"]')?.value`)) === '-1');
  t.check('Look At picker reads None after target deleted',
    (await t.evaluate(`document.querySelector('.camera-tab-select[data-field="lookAt"]')?.value`)) === '-1');

  await t.screenshot('/tmp/ur5-7-empty-camera-targets.png');

  // Restore a clean scene for later suites.
  await t.evaluate('window.__renderEngine.setAperture(0)');
  await t.evaluate(`window.__app.io.apply(${JSON.stringify(saved)})`);
  await t.evaluate('window.__app.renderer.cameraViewId = null');
  await t.evaluate('window.__app.autosave.clear()');
});
