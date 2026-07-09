/**
 * Graph Editor e2e. Switches a workspace area to the Graph Editor, keys the
 * cube at frames 1 and 24 (I-key flow, moving location.x to 2), then exercises:
 * __graph exposed + keysShown lists the keyed channels; dragging a key changes
 * the scene fcurve value and Ctrl+Z reverts it; dragging a bezier handle sets
 * handleMode 'free' + an offset and Ctrl+Z reverts; fit() + wheel don't throw.
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  // Deterministic layout + frame range.
  await t.evaluate(`localStorage.removeItem('vibe-blender-workspaces-v2')`);
  await t.reload();
  await t.evaluate(`(() => {
    const s = window.__app.scene;
    s.frameStart = 1; s.frameEnd = 24; s.frameCurrent = 1; s.playing = false;
  })()`);

  // 1. Switch an area to the Graph Editor.
  t.check("'Graph Editor' offered in every area dropdown",
    await t.evaluate(`[...document.querySelectorAll('.wsp-area-select option')].some(o => o.value === 'graph')`));
  await t.evaluate(`(() => {
    const sel = [...document.querySelectorAll('.wsp-area-select')].find(s => s.value === 'properties' || s.value === 'outliner');
    sel.value = 'graph';
    sel.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(300);

  t.check('graph canvas mounted', await t.evaluate(`!!document.querySelector('.graph-canvas')`));
  t.check('__graph debug handle exposed',
    await t.evaluate(`!!(window.__graph && window.__graph.keysShown && window.__graph.viewToPx)`));

  // 2. Key the cube at frame 1, move location.x to 2, key at frame 24.
  await t.evaluate(`(() => { window.__app.scene.frameCurrent = 1; })()`);
  await t.key('i', 'KeyI');
  await t.key('i', 'KeyI'); // I,I → insert LocRotScale @ frame 1
  await t.evaluate(`(() => {
    const s = window.__app.scene;
    const obj = s.activeObject;
    const V = obj.transform.position.constructor;
    obj.transform = obj.transform.withPosition(new V(2, 0, 0));
    s.frameCurrent = 24;
  })()`);
  await t.key('i', 'KeyI');
  await t.key('i', 'KeyI'); // I,I → insert LocRotScale @ frame 24

  const keyCount = await t.evaluate(`(() => {
    const c = window.__app.scene.activeObject.anim.fcurves.find(c => c.channelPath === 'location.x');
    return c ? c.keys.length : 0;
  })()`);
  t.check('cube location.x has two keys (1 & 24)', keyCount === 2, `keys=${keyCount}`);

  // 3. keysShown lists the keyed channels' keys.
  await t.sleep(120);
  await t.evaluate(`window.__graph.fit()`); // reframe now that frame 24 keys exist
  await t.sleep(80);
  const keys = await t.evaluate(`window.__graph.keysShown()`);
  t.check('keysShown returns keys', Array.isArray(keys) && keys.length > 0, `n=${keys && keys.length}`);
  const locX = keys.filter((k) => k.channelPath === 'location.x').map((k) => k.frame).sort((a, b) => a - b);
  t.check('location.x keys at frames 1 and 24',
    locX.length === 2 && locX[0] === 1 && locX[1] === 24, JSON.stringify(locX));

  // 4. Drag the frame-24 location.x key (value 2, a unique screen point).
  const kgeo = await t.evaluate(`(() => {
    const r = window.__graph.canvas.getBoundingClientRect();
    const [x, y] = window.__graph.viewToPx(24, 2);
    return { left: r.left, top: r.top, x, y };
  })()`);
  const kx = kgeo.left + kgeo.x, ky = kgeo.top + kgeo.y;
  await t.mouse('mouseMoved', kx, ky);
  await t.mouse('mousePressed', kx, ky, 'left');
  await t.mouse('mouseMoved', kx, ky + 50, 'left'); // drag straight down → value drops, frame stays
  await t.mouse('mouseReleased', kx, ky + 50, 'left');
  await t.sleep(120);

  const draggedValue = await t.evaluate(`(() => {
    const c = window.__app.scene.activeObject.anim.fcurves.find(c => c.channelPath === 'location.x');
    const k = c.keys.find(k => k.frame === 24);
    return k ? k.value : null;
  })()`);
  t.check('key drag changed the fcurve value', draggedValue !== null && Math.abs(draggedValue - 2) > 0.05, `value=${draggedValue}`);

  await t.key('z', 'KeyZ', 2); // Ctrl+Z
  await t.sleep(120);
  const revertedValue = await t.evaluate(`(() => {
    const c = window.__app.scene.activeObject.anim.fcurves.find(c => c.channelPath === 'location.x');
    const k = c.keys.find(k => k.frame === 24);
    return k ? k.value : null;
  })()`);
  t.check('Ctrl+Z reverted the key value to 2', revertedValue !== null && Math.abs(revertedValue - 2) < 0.01, `value=${revertedValue}`);

  // 5. Drag a bezier handle. Select the (24,2) key first, then grab its handle.
  const sgeo = await t.evaluate(`(() => {
    const r = window.__graph.canvas.getBoundingClientRect();
    const [x, y] = window.__graph.viewToPx(24, 2);
    return { sx: r.left + x, sy: r.top + y };
  })()`);
  await t.mouse('mouseMoved', sgeo.sx, sgeo.sy);
  await t.mouse('mousePressed', sgeo.sx, sgeo.sy, 'left');
  await t.mouse('mouseReleased', sgeo.sx, sgeo.sy, 'left'); // click selects (no move)
  await t.sleep(120);

  const handles = await t.evaluate(`window.__graph.handlesShown()`);
  const lh = handles.find((h) => h.channelPath === 'location.x' && h.frame === 24 && h.side === 'l');
  t.check('a left handle is shown for the selected bezier key', !!lh, JSON.stringify(handles));

  if (lh) {
    await t.mouse('mouseMoved', lh.x, lh.y);
    await t.mouse('mousePressed', lh.x, lh.y, 'left');
    await t.mouse('mouseMoved', lh.x - 20, lh.y + 20, 'left');
    await t.mouse('mouseReleased', lh.x - 20, lh.y + 20, 'left');
    await t.sleep(120);
  }

  const afterHandle = await t.evaluate(`(() => {
    const c = window.__app.scene.activeObject.anim.fcurves.find(c => c.channelPath === 'location.x');
    const k = c.keys.find(k => k.frame === 24);
    return k ? { mode: k.handleMode || null, hasHl: !!k.hl, hasHr: !!k.hr } : null;
  })()`);
  t.check('handle drag set handleMode=free with an hl/hr offset',
    !!afterHandle && afterHandle.mode === 'free' && (afterHandle.hasHl || afterHandle.hasHr), JSON.stringify(afterHandle));

  await t.key('z', 'KeyZ', 2); // Ctrl+Z
  await t.sleep(120);
  const afterUndoHandle = await t.evaluate(`(() => {
    const c = window.__app.scene.activeObject.anim.fcurves.find(c => c.channelPath === 'location.x');
    const k = c.keys.find(k => k.frame === 24);
    return k ? { mode: k.handleMode || null } : null;
  })()`);
  t.check('Ctrl+Z reverted the handle to auto (no handleMode)',
    !!afterUndoHandle && afterUndoHandle.mode === null, JSON.stringify(afterUndoHandle));

  // 6. fit() runs and a wheel event doesn't throw.
  t.check('fit() runs without error', await t.evaluate(`(() => { window.__graph.fit(); return true; })()`));
  const wheelOk = await t.evaluate(`(() => {
    const cv = window.__graph.canvas;
    const r = cv.getBoundingClientRect();
    cv.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -120, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
    cv.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120, ctrlKey: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
    return true;
  })()`);
  t.check('wheel zoom does not throw', wheelOk === true);
});
