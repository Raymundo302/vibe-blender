/**
 * Dope-sheet-lite e2e (P16-3). Builds on the P15 timeline pane: keys the cube
 * at 1/24 on all nine LocRotScale channels, then exercises the P16-3
 * extensions:
 *   - expand the object row → 9 channel sub-rows drawn (channelRows() handle);
 *   - select a sub-row diamond + delete → only THAT channel's key gone (the
 *     others still have two keys), then undo restores it;
 *   - select keys + pick Linear → the fcurve interp changes and ONE Ctrl+Z
 *     reverts every changed key.
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  await t.evaluate(`(() => {
    const s = window.__app.scene;
    s.frameStart = 1; s.frameEnd = 24; s.frameCurrent = 1; s.playing = false;
  })()`);

  // Switch an area to the Timeline editor.
  await t.evaluate(`(() => {
    const sel = [...document.querySelectorAll('.wsp-area-select')].find(s => s.value === 'properties' || s.value === 'outliner');
    sel.value = 'timeline';
    sel.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(300);
  t.check('timeline canvas mounted', await t.evaluate(`!!document.querySelector('.timeline-canvas')`));
  t.check('channelRows debug handle exposed',
    await t.evaluate(`!!(window.__timeline && window.__timeline.channelRows && window.__timeline.toggleExpand)`));
  t.check('interp picker present in header',
    await t.evaluate(`!!document.querySelector('.timeline-interp')`));

  const cubeId = await t.evaluate(`window.__app.scene.activeObject.id`);

  // Key the cube at frames 1/24 on all nine LocRotScale channels (interp bezier).
  await t.evaluate(`(() => {
    const o = window.__app.scene.activeObject;
    const paths = ['location.x','location.y','location.z','rotation.x','rotation.y','rotation.z','scale.x','scale.y','scale.z'];
    o.anim = { fcurves: paths.map(p => ({ channelPath: p, keys: [1,24].map(f => ({ frame: f, value: 0, interp: 'bezier' })) })) };
  })()`);
  await t.sleep(120);
  const diamonds = await t.evaluate(`window.__timeline.keyFramesShown().map(d => d.frame)`);
  t.check('two object-row diamonds at 1/24', JSON.stringify(diamonds) === '[1,24]', JSON.stringify(diamonds));

  // --- Interp picker disabled while nothing is selected ---
  t.check('interp picker disabled with no selection',
    await t.evaluate(`document.querySelector('.timeline-interp').disabled === true`));

  // --- Expand the object row → 9 channel sub-rows ---
  await t.evaluate(`window.__timeline.toggleExpand(${cubeId})`);
  await t.sleep(120);
  const chRows = await t.evaluate(`window.__timeline.channelRows()`);
  t.check('expanded row draws 9 channel sub-rows', Array.isArray(chRows) && chRows.length === 9, `n=${chRows.length}`);
  t.check('each sub-row has its two diamonds',
    chRows.every(r => JSON.stringify(r.frames) === '[1,24]'), JSON.stringify(chRows.map(r => r.frames.length)));

  // --- Select the location.x sub-row diamond at frame 24 and delete it ---
  const g = await t.evaluate(`(() => {
    const r = document.querySelector('.timeline-canvas').getBoundingClientRect();
    const d = window.__timeline.diamondXY(${cubeId}, 24, 'location.x');
    return d ? { x: r.left + d.x, y: r.top + d.y } : null;
  })()`);
  t.check('sub-row diamond has a screen position', !!g);
  await t.click(g.x, g.y);
  const sel = await t.evaluate(`window.__timeline.selectedKeys()`);
  t.check('sub-row click selects one channel key',
    sel.length === 1 && sel[0].objectId === cubeId && sel[0].frame === 24 && sel[0].channelPath === 'location.x',
    JSON.stringify(sel));
  t.check('interp picker enabled once a key is selected',
    await t.evaluate(`document.querySelector('.timeline-interp').disabled === false`));

  await t.mouse('mouseMoved', g.x, g.y); // ensure the pane is hovered
  await t.key('x', 'KeyX');
  await t.sleep(120);
  const afterDelete = await t.evaluate(`(() => {
    const cs = window.__app.scene.activeObject.anim.fcurves;
    const lx = cs.find(c => c.channelPath === 'location.x');
    const ly = cs.find(c => c.channelPath === 'location.y');
    return { lxHas24: !!lx && lx.keys.some(k => k.frame === 24), lyLen: ly ? ly.keys.length : 0 };
  })()`);
  t.check('deleting the sub-row key removed ONLY location.x @24', afterDelete.lxHas24 === false);
  t.check('other channels untouched (location.y still 2 keys)', afterDelete.lyLen === 2, `ly=${afterDelete.lyLen}`);

  // Undo restores location.x @24 (and nothing else changed).
  await t.key('z', 'KeyZ', 2); // ctrl
  await t.sleep(120);
  const back = await t.evaluate(`(() => {
    const lx = window.__app.scene.activeObject.anim.fcurves.find(c => c.channelPath === 'location.x');
    return lx.keys.some(k => k.frame === 24);
  })()`);
  t.check('undo restores the deleted sub-row key', back === true);

  // --- Select keys, set Linear → interp changes, ONE Ctrl+Z reverts ---
  // Select the location.x sub-row diamond at frame 1.
  const g1 = await t.evaluate(`(() => {
    const r = document.querySelector('.timeline-canvas').getBoundingClientRect();
    const d = window.__timeline.diamondXY(${cubeId}, 1, 'location.x');
    return { x: r.left + d.x, y: r.top + d.y };
  })()`);
  await t.click(g1.x, g1.y);
  t.check('one key selected before interp change',
    (await t.evaluate(`window.__timeline.selectedKeys().length`)) === 1);

  const interpBefore = await t.evaluate(`(() => {
    const lx = window.__app.scene.activeObject.anim.fcurves.find(c => c.channelPath === 'location.x');
    return lx.keys.find(k => k.frame === 1).interp;
  })()`);
  t.check('key starts as bezier', interpBefore === 'bezier', interpBefore);

  await t.evaluate(`(() => {
    const s = document.querySelector('.timeline-interp');
    s.value = 'linear';
    s.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(120);
  const interpAfter = await t.evaluate(`(() => {
    const lx = window.__app.scene.activeObject.anim.fcurves.find(c => c.channelPath === 'location.x');
    return lx.keys.find(k => k.frame === 1).interp;
  })()`);
  t.check('picking Linear changed the fcurve interp', interpAfter === 'linear', interpAfter);

  await t.key('z', 'KeyZ', 2); // ctrl
  await t.sleep(120);
  const interpReverted = await t.evaluate(`(() => {
    const lx = window.__app.scene.activeObject.anim.fcurves.find(c => c.channelPath === 'location.x');
    return lx.keys.find(k => k.frame === 1).interp;
  })()`);
  t.check('ONE Ctrl+Z reverts the interp change', interpReverted === 'bezier', interpReverted);

  // --- Object-row interp change hits ALL channels at the frame ---
  // Collapse, select the object-row diamond at frame 1, set Constant.
  await t.evaluate(`window.__timeline.toggleExpand(${cubeId})`);
  await t.sleep(100);
  const go = await t.evaluate(`(() => {
    const r = document.querySelector('.timeline-canvas').getBoundingClientRect();
    const d = window.__timeline.diamondXY(${cubeId}, 1);
    return { x: r.left + d.x, y: r.top + d.y };
  })()`);
  await t.click(go.x, go.y);
  const oSel = await t.evaluate(`window.__timeline.selectedKeys()`);
  t.check('object-row diamond selects with no channelPath',
    oSel.length === 1 && oSel[0].channelPath === undefined, JSON.stringify(oSel));
  await t.evaluate(`(() => {
    const s = document.querySelector('.timeline-interp');
    s.value = 'constant';
    s.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(120);
  const allConstant = await t.evaluate(`(() => {
    return window.__app.scene.activeObject.anim.fcurves.every(c => {
      const k = c.keys.find(k => k.frame === 1);
      return k && k.interp === 'constant';
    });
  })()`);
  t.check('object-row Constant set interp on all 9 channels @1', allConstant === true);
  await t.key('z', 'KeyZ', 2);
  await t.sleep(120);
  const noneConstant = await t.evaluate(`(() => {
    return window.__app.scene.activeObject.anim.fcurves.every(c => {
      const k = c.keys.find(k => k.frame === 1);
      return k && k.interp === 'bezier';
    });
  })()`);
  t.check('ONE Ctrl+Z reverts the object-row interp change on all channels', noneConstant === true);
});
