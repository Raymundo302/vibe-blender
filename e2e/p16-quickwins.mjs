/**
 * P16-4 e2e — quick-wins batch:
 *   1. Theme picker 🎨 toggle-close (real pointer events).
 *   2. M → New Collection is ONE undo (returns objects AND removes collection).
 *   4. Proportional-edit default radius (1.0) + remembered per session.
 *   3. Lock-to-view rig adopts the viewport framing distance (no teleport).
 *
 * Run with the dev server up, under flock:
 *   flock /tmp/vibe-blender-e2e.lock node e2e/p16-quickwins.mjs
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  await t.evaluate(`document.querySelector('.wsp-tab[data-workspace="Layout"]')?.click()`);
  await t.sleep(120);
  const saved = await t.evaluate('window.__app.io.serialize()');
  await t.key('Escape', 'Escape', 0); // dismiss splash
  await t.sleep(60);

  // ---------------------------------------------------------------- item 1 ---
  // Theme picker toggles shut when 🎨 is clicked a second time (real pointer
  // sequence: pointerdown on the anchor used to close+reopen it).
  const themeRect = await t.evaluate(`(() => {
    const b = document.querySelector('.topbar-btn[data-action="theme-picker"]');
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  await t.click(themeRect.x, themeRect.y, 'left', 0);
  await t.until(`!!document.querySelector('.theme-picker')`, 3000);
  t.check('first 🎨 click opens the picker',
    await t.evaluate(`!!document.querySelector('.theme-picker')`));
  await t.click(themeRect.x, themeRect.y, 'left', 0);
  await t.sleep(120);
  t.check('second 🎨 click CLOSES the picker (toggle)',
    (await t.evaluate(`!!document.querySelector('.theme-picker')`)) === false);
  // And it can be re-opened afterwards (state left clean).
  await t.click(themeRect.x, themeRect.y, 'left', 0);
  await t.until(`!!document.querySelector('.theme-picker')`, 3000);
  t.check('picker re-opens on a fresh click',
    await t.evaluate(`!!document.querySelector('.theme-picker')`));
  await t.key('Escape', 'Escape', 0); // close it
  await t.sleep(80);

  // ---------------------------------------------------------------- item 2 ---
  // M → New Collection: exactly ONE undo entry; undo returns the object AND
  // removes the fresh collection.
  const canvasRect = await t.evaluate(`(() => {
    const r = document.querySelector('canvas').getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  })()`);
  const cx = Math.round(canvasRect.x + canvasRect.w / 2);
  const cy = Math.round(canvasRect.y + canvasRect.h / 2);

  const setup = await t.evaluate(`(() => {
    const s = window.__app.scene;
    if (s.editMode) s.exitEditMode();
    const objs = s.objects.filter(o => o.kind === 'mesh');
    const obj = objs[0];
    s.selectOnly(obj.id);
    window.__app.undo.clear();
    return { objId: obj.id, before: obj.collectionId, cols: s.collections.length };
  })()`);
  // Focus the viewport with a pointer move so M opens the popup at the pointer.
  await t.mouse('mouseMoved', cx, cy);
  await t.key('m', 'KeyM', 0);
  await t.until(`!!document.querySelector('.col-menu')`, 3000);
  t.check('M opens the collection popup',
    await t.evaluate(`!!document.querySelector('.col-menu')`));
  await t.evaluate(`(() => {
    const item = [...document.querySelectorAll('.col-menu-item')]
      .find(el => el.textContent.includes('New Collection'));
    item.click();
  })()`);
  await t.sleep(120);

  const afterMove = await t.evaluate(`(() => {
    const s = window.__app.scene;
    return {
      cols: s.collections.length,
      objCol: s.get(${setup.objId}).collectionId,
      undoLen: window.__app.undo.undoStack.length,
    };
  })()`);
  t.check('New Collection created one collection', afterMove.cols === setup.cols + 1);
  t.check('object moved into the new collection', afterMove.objCol !== null && afterMove.objCol !== setup.before);
  t.check('New Collection pushed EXACTLY ONE undo entry', afterMove.undoLen === 1);

  await t.key('z', 'KeyZ', 2); // Ctrl+Z
  await t.sleep(120);
  const afterUndo = await t.evaluate(`(() => {
    const s = window.__app.scene;
    return { cols: s.collections.length, objCol: s.get(${setup.objId}).collectionId };
  })()`);
  t.check('ONE undo removes the new collection', afterUndo.cols === setup.cols);
  t.check('ONE undo returns the object to its previous collection', afterUndo.objCol === setup.before);

  // ---------------------------------------------------------------- item 4 ---
  // Proportional-edit default radius is a sane 1.0 world unit and is remembered.
  const radius0 = await t.evaluate('window.__proportional.radius');
  t.check('proportional default radius is 1.0', Math.abs(radius0 - 1.0) < 1e-9);
  // Simulate the user dialling a new radius, then run + cancel a transform;
  // the radius must survive (module-level state = remembered per session).
  await t.evaluate('window.__proportional.radius = 4.25');
  await t.evaluate(`(() => {
    const s = window.__app.scene;
    const obj = s.objects.find(o => o.kind === 'mesh');
    s.selectOnly(obj.id);
    if (!s.editMode) s.enterEditMode(obj.id);
  })()`);
  await t.sleep(80);
  await t.key('g', 'KeyG', 0);   // start a proportional-capable transform
  await t.sleep(40);
  await t.key('Escape', 'Escape', 0); // cancel it
  await t.sleep(60);
  t.check('proportional radius is REMEMBERED across a transform',
    Math.abs((await t.evaluate('window.__proportional.radius')) - 4.25) < 1e-9);
  await t.evaluate(`(() => { const s = window.__app.scene; if (s.editMode) s.exitEditMode(); window.__proportional.radius = 1.0; })()`);
  await t.sleep(60);

  // ---------------------------------------------------------------- item 3 ---
  // Lock-to-view: the rig now pivots at the VIEWPORT distance, so the first
  // orbit's camera motion scales with that distance (old code always pivoted at
  // the clamped world-origin projection → a fixed, teleporty framing).
  const camId = await t.evaluate(`(() => {
    const s = window.__app.scene;
    if (s.editMode) s.exitEditMode();
    const cam = s.addCamera('Camera');
    const V = cam.transform.position.constructor;
    // Aimed straight down -Z from a point OFF the origin axis, so the origin
    // projection along the aim clamps to the 1.0 floor regardless of viewport.
    cam.transform = cam.transform.withPosition(new V(12, 0, 0));
    cam.camera.lockToView = true;
    window.__camInit = cam.transform; // immutable snapshot for pose resets
    s.selectOnly(cam.id);
    return cam.id;
  })()`);
  await t.sleep(80);

  const posOf = () => t.evaluate(`(() => { const p = window.__app.scene.get(${camId}).transform.position; return { x: p.x, y: p.y, z: p.z }; })()`);
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  const orbitOnce = async () => {
    await t.mouse('mouseMoved', cx, cy);
    await t.mouse('mousePressed', cx, cy, 'middle');
    await t.mouse('mouseMoved', cx + 60, cy, 'middle');
    await t.mouse('mouseReleased', cx + 60, cy, 'middle');
    await t.sleep(60);
  };
  const resetCamPose = () => t.evaluate(`(() => {
    window.__app.scene.get(${camId}).transform = window.__camInit;
  })()`);

  // Small viewport distance → small first-orbit motion.
  await t.evaluate('window.__app.camera.distance = 4');
  await resetCamPose();
  await t.key('0', 'Numpad0', 0);
  await t.sleep(60);
  t.check('entered locked camera view', (await t.evaluate('window.__app.renderer.cameraViewId')) === camId);
  const entryPos = await posOf();
  t.check('no teleport at entry (pose unchanged before first orbit)',
    dist(entryPos, { x: 12, y: 0, z: 0 }) < 1e-6);
  await orbitOnce();
  const moved4 = dist(await posOf(), entryPos);
  await t.key('0', 'Numpad0', 0); // leave (commits the fly)
  await t.sleep(60);

  // Large viewport distance → proportionally larger first-orbit motion.
  await t.evaluate('window.__app.camera.distance = 16');
  await resetCamPose();
  await t.evaluate('window.__app.undo.clear()');
  await t.key('0', 'Numpad0', 0);
  await t.sleep(60);
  const entryPos2 = await posOf();
  await orbitOnce();
  const moved16 = dist(await posOf(), entryPos2);
  await t.key('0', 'Numpad0', 0);
  await t.sleep(60);

  t.check('first-orbit motion scales with the viewport distance (adopts framing)',
    moved16 > moved4 * 2, `d4=${moved4.toFixed(3)} d16=${moved16.toFixed(3)}`);
  t.check('leaving locked view commits ONE undo entry',
    (await t.evaluate('window.__app.undo.undoStack.length')) === 1);

  // ----------------------------------------------------------------- reset ---
  await t.evaluate(`window.__app.io.apply(${JSON.stringify(saved)})`);
  await t.evaluate('window.__app.renderer.cameraViewId = null');
  await t.evaluate('window.__app.autosave.clear()');
});
