/**
 * Keyframe editing e2e (P15-3). Builds on the P15-1 timeline pane: keys the
 * cube at 1/12/24, then exercises select + drag-move (with a single-Ctrl+Z
 * restore), select + X delete (all channels at the frame, undoable), and the
 * auto-key toggle (on → a confirmed G-move inserts keys at frameCurrent; off →
 * it inserts none).
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
  t.check('keyedit debug handles exposed',
    await t.evaluate(`!!(window.__timeline && window.__timeline.selectedKeys && window.__timeline.diamondXY)`));

  const cubeId = await t.evaluate(`window.__app.scene.activeObject.id`);

  // Key the cube at frames 1/12/24 on all nine LocRotScale channels. Set the
  // AnimData directly (not via the I-key) so this suite is independent of the
  // keying-menu UI another P15 worker owns.
  await t.evaluate(`(() => {
    const o = window.__app.scene.activeObject;
    const paths = ['location.x','location.y','location.z','rotation.x','rotation.y','rotation.z','scale.x','scale.y','scale.z'];
    o.anim = { fcurves: paths.map(p => ({ channelPath: p, keys: [1,12,24].map(f => ({ frame: f, value: 0, interp: 'bezier' })) })) };
  })()`);
  await t.sleep(120);
  let frames = await t.evaluate(`(() => {
    const c = window.__app.scene.activeObject.anim.fcurves.find(c => c.channelPath === 'location.x');
    return c.keys.map(k => k.frame);
  })()`);
  t.check('cube keyed at 1/12/24', JSON.stringify(frames) === '[1,12,24]', JSON.stringify(frames));
  const diamonds = await t.evaluate(`window.__timeline.keyFramesShown().map(d => d.frame)`);
  t.check('three diamonds drawn', JSON.stringify(diamonds) === '[1,12,24]', JSON.stringify(diamonds));

  // --- Select the frame-12 diamond ---
  const geo = await t.evaluate(`(() => {
    const r = window.__timeline.canvas.getBoundingClientRect();
    const d = window.__timeline.diamondXY(${cubeId}, 12);
    return { left: r.left, top: r.top, x: d.x, y: d.y };
  })()`);
  const sx = geo.left + geo.x;
  const sy = geo.top + geo.y;
  await t.click(sx, sy);
  const sel = await t.evaluate(`window.__timeline.selectedKeys()`);
  t.check('clicking the diamond selects frame 12',
    sel.length === 1 && sel[0].objectId === cubeId && sel[0].frame === 12, JSON.stringify(sel));

  // --- Drag it from 12 to 16 (pointer events) ---
  const x16 = await t.evaluate(`window.__timeline.frameToX(16)`);
  const tx = geo.left + x16;
  await t.mouse('mouseMoved', sx, sy);
  await t.mouse('mousePressed', sx, sy, 'left');
  await t.mouse('mouseMoved', tx, sy, 'left');
  await t.mouse('mouseReleased', tx, sy, 'left');
  await t.sleep(150);
  frames = await t.evaluate(`(() => {
    const c = window.__app.scene.activeObject.anim.fcurves.find(c => c.channelPath === 'location.x');
    return c.keys.map(k => k.frame);
  })()`);
  t.check('drag moved the key 12 -> 16', JSON.stringify(frames) === '[1,16,24]', JSON.stringify(frames));

  // ONE Ctrl+Z restores frame 12.
  await t.key('z', 'KeyZ', 2); // ctrl
  await t.sleep(120);
  frames = await t.evaluate(`(() => {
    const c = window.__app.scene.activeObject.anim.fcurves.find(c => c.channelPath === 'location.x');
    return c.keys.map(k => k.frame);
  })()`);
  t.check('one Ctrl+Z restores frame 12', JSON.stringify(frames) === '[1,12,24]', JSON.stringify(frames));

  // --- Select the frame-24 diamond and delete it with X ---
  const g24 = await t.evaluate(`(() => {
    const r = window.__timeline.canvas.getBoundingClientRect();
    const d = window.__timeline.diamondXY(${cubeId}, 24);
    return { x: r.left + d.x, y: r.top + d.y };
  })()`);
  await t.click(g24.x, g24.y);
  const channelsAt24 = await t.evaluate(`(() => {
    return window.__app.scene.activeObject.anim.fcurves.filter(c => c.keys.some(k => k.frame === 24)).length;
  })()`);
  t.check('frame 24 has multiple channels keyed (a diamond = all channels)', channelsAt24 === 9, `n=${channelsAt24}`);
  await t.mouse('mouseMoved', g24.x, g24.y); // ensure the pane is hovered
  await t.key('x', 'KeyX');
  await t.sleep(120);
  const anyAt24 = await t.evaluate(`(() => {
    const a = window.__app.scene.activeObject.anim;
    return a.fcurves.some(c => c.keys.some(k => k.frame === 24));
  })()`);
  t.check('X deleted every channel at frame 24', anyAt24 === false);
  const objStillThere = await t.evaluate(`window.__app.scene.objects.length`);
  t.check('X did NOT delete the object (timeline claimed the key)', objStillThere === 1, `objs=${objStillThere}`);

  // Undo restores frame 24.
  await t.key('z', 'KeyZ', 2);
  await t.sleep(120);
  const back24 = await t.evaluate(`(() => {
    const c = window.__app.scene.activeObject.anim.fcurves.find(c => c.channelPath === 'location.x');
    return c.keys.some(k => k.frame === 24);
  })()`);
  t.check('Ctrl+Z restores the deleted frame-24 keys', back24 === true);

  // --- Auto-key ON: a confirmed G-move inserts keys at frameCurrent ---
  const vp = await t.evaluate(`(() => { const r = document.getElementById('viewport').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  const cx = Math.round(vp.x + vp.w * 0.5);
  const cy = Math.round(vp.y + vp.h * 0.48);

  await t.evaluate(`document.querySelector('[data-action="autokey"]').click()`);
  t.check('auto-key toggle turned on', await t.evaluate(`window.__timeline.autoKey.enabled === true`));

  await t.evaluate(`(() => { window.__app.scene.frameCurrent = 6; })()`);
  await t.mouse('mouseMoved', cx, cy);
  await t.key('g', 'KeyG');
  await t.sleep(80);
  await t.mouse('mouseMoved', cx + 90, cy);
  await t.sleep(80);
  await t.mouse('mousePressed', cx + 90, cy, 'left');
  await t.mouse('mouseReleased', cx + 90, cy, 'left');
  await t.sleep(200);
  const has6 = await t.evaluate(`(() => {
    const c = window.__app.scene.activeObject.anim.fcurves.find(c => c.channelPath === 'location.x');
    return c.keys.some(k => k.frame === 6);
  })()`);
  t.check('auto-key ON inserted a key at frameCurrent (6)', has6 === true);

  // --- Auto-key OFF: a confirmed G-move inserts nothing ---
  await t.evaluate(`document.querySelector('[data-action="autokey"]').click()`);
  t.check('auto-key toggle turned off', await t.evaluate(`window.__timeline.autoKey.enabled === false`));

  await t.evaluate(`(() => { window.__app.scene.frameCurrent = 9; })()`);
  await t.mouse('mouseMoved', cx, cy);
  await t.key('g', 'KeyG');
  await t.sleep(80);
  await t.mouse('mouseMoved', cx - 70, cy);
  await t.sleep(80);
  await t.mouse('mousePressed', cx - 70, cy, 'left');
  await t.mouse('mouseReleased', cx - 70, cy, 'left');
  await t.sleep(200);
  const has9 = await t.evaluate(`(() => {
    const c = window.__app.scene.activeObject.anim.fcurves.find(c => c.channelPath === 'location.x');
    return c.keys.some(k => k.frame === 9);
  })()`);
  t.check('auto-key OFF inserted no key at frameCurrent (9)', has9 === false);
});
