/**
 * Timeline pane e2e (P15-1). Switches a workspace area to the Timeline editor,
 * keys the cube at frames 1 and 24 via the I-key path (moving it between), then
 * exercises: scrub the ruler (frameCurrent changes + sampler poses the cube),
 * two diamonds drawn for the 2-key object (debug handle), ▶ playback advances
 * frameCurrent + ⏸ stops it, Spacebar toggles playing, frame input jumps+poses.
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  // Deterministic range so scrubbing to ~12 lands mid-way between 1 and 24.
  await t.evaluate(`(() => {
    const s = window.__app.scene;
    s.frameStart = 1; s.frameEnd = 24; s.frameCurrent = 1; s.playing = false;
  })()`);

  // 1. Switch an area to the Timeline editor.
  t.check("'Timeline' offered in every area dropdown",
    await t.evaluate(`[...document.querySelectorAll('.wsp-area-select option')].some(o => o.value === 'timeline')`));
  await t.evaluate(`(() => {
    const sel = [...document.querySelectorAll('.wsp-area-select')].find(s => s.value === 'properties' || s.value === 'outliner');
    sel.value = 'timeline';
    sel.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(300); // let the frame loop size + draw the canvas

  t.check('timeline canvas mounted', await t.evaluate(`!!document.querySelector('.timeline-canvas')`));
  t.check('__timeline debug handle exposed', await t.evaluate(`!!(window.__timeline && window.__timeline.keyFramesShown)`));

  // 2. Key the cube at frame 1 (origin), move it, key at frame 24.
  await t.evaluate(`(() => { window.__app.scene.frameCurrent = 1; })()`);
  // P15-2: I opens the keying menu; a second I confirms the LocRotScale default.
  await t.key('i', 'KeyI');
  await t.key('i', 'KeyI'); // confirm default → insert LocRotScale @ frame 1
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

  // 3. Two diamonds drawn for the 2-key object (union of fcurve frames).
  await t.sleep(100); // let update() recompute rows
  const diamonds = await t.evaluate(`window.__timeline.keyFramesShown()`);
  t.check('two diamonds shown for the cube',
    Array.isArray(diamonds) && diamonds.length === 2, JSON.stringify(diamonds));
  t.check('diamond frames are 1 and 24',
    diamonds.length === 2 && diamonds[0].frame === 1 && diamonds[1].frame === 24, JSON.stringify(diamonds.map(d => d.frame)));
  t.check('both diamonds filled (all LocRotScale channels keyed)',
    diamonds.length === 2 && diamonds.every(d => d.filled === true));
  t.check('one track row (single selected object)',
    (await t.evaluate(`window.__timeline.rowCount()`)) === 1);

  // 4. Scrub the ruler to ~frame 12 via synthesized pointer events.
  const geo = await t.evaluate(`(() => {
    // __timeline.canvas, NOT querySelector: the default Layout now docks a
    // Timeline pane too, so the first .timeline-canvas is not the suite's.
    const r = window.__timeline.canvas.getBoundingClientRect();
    return { left: r.left, top: r.top, x12: window.__timeline.frameToX(12) };
  })()`);
  const sx = geo.left + geo.x12;
  const sy = geo.top + 10; // over the ruler
  await t.mouse('mouseMoved', sx, sy);
  await t.mouse('mousePressed', sx, sy, 'left');
  await t.mouse('mouseReleased', sx, sy, 'left');
  await t.sleep(120);

  const frameAfterScrub = await t.evaluate(`window.__app.scene.frameCurrent`);
  t.check('scrub moved frameCurrent near 12', Math.abs(frameAfterScrub - 12) <= 1, `frame=${frameAfterScrub}`);
  const posAfterScrub = await t.evaluate(`window.__app.scene.activeObject.transform.position.x`);
  t.check('sampler posed the cube (0 < x < 2 mid-scrub)', posAfterScrub > 0.01 && posAfterScrub < 1.99, `x=${posAfterScrub}`);

  // 5. ▶ playback advances frameCurrent; ⏸ stops it.
  const beforePlay = await t.evaluate(`window.__app.scene.frameCurrent`);
  await t.evaluate(`(() => {
    const btn = [...document.querySelectorAll('.timeline-play')][0];
    btn.click();
  })()`);
  t.check('play button set scene.playing', (await t.evaluate(`window.__app.scene.playing`)) === true);
  await t.sleep(320);
  const duringPlay = await t.evaluate(`window.__app.scene.frameCurrent`);
  t.check('playback advanced frameCurrent', duringPlay !== beforePlay, `${beforePlay} -> ${duringPlay}`);
  // ⏸ (same button) stops.
  await t.evaluate(`(() => { [...document.querySelectorAll('.timeline-play')][0].click(); })()`);
  t.check('pause button cleared scene.playing', (await t.evaluate(`window.__app.scene.playing`)) === false);
  await t.sleep(120);
  const stoppedA = await t.evaluate(`window.__app.scene.frameCurrent`);
  await t.sleep(200);
  const stoppedB = await t.evaluate(`window.__app.scene.frameCurrent`);
  t.check('frameCurrent frozen after pause', stoppedA === stoppedB, `${stoppedA} == ${stoppedB}`);

  // 6. Spacebar toggles scene.playing (object mode, no modifiers).
  const playBefore = await t.evaluate(`window.__app.scene.playing`);
  await t.key(' ', 'Space');
  const playAfter = await t.evaluate(`window.__app.scene.playing`);
  t.check('Spacebar toggled scene.playing', playAfter === !playBefore, `${playBefore} -> ${playAfter}`);
  // Toggle back off so the pane is quiescent for the last check.
  await t.key(' ', 'Space');
  t.check('Spacebar toggled playing back', (await t.evaluate(`window.__app.scene.playing`)) === playBefore);

  // 7. Frame input jumps + poses.
  await t.evaluate(`(() => {
    const inp = window.__timeline.canvas.closest('.timeline').querySelector('.timeline-frame');
    inp.value = '1';
    inp.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(60);
  t.check('frame input set frameCurrent', (await t.evaluate(`window.__app.scene.frameCurrent`)) === 1);
  const posAtStart = await t.evaluate(`window.__app.scene.activeObject.transform.position.x`);
  t.check('frame input posed the cube back to frame 1 (x≈0)', Math.abs(posAtStart) < 0.01, `x=${posAtStart}`);

  // 8. Interp select now has 10 options; easing select exists + greyed with no
  //    selection (nothing is selected at this point — scrubbing cleared it).
  const interpOptCount = await t.evaluate(
    `window.__timeline.canvas.closest('.timeline').querySelectorAll('.timeline-interp option').length`);
  t.check('interp select offers all 10 modes', interpOptCount === 10, `n=${interpOptCount}`);
  t.check('easing select exists in header',
    await t.evaluate(`!!window.__timeline.canvas.closest('.timeline').querySelector('.timeline-easing')`));
  t.check('easing select greyed with no selection',
    await t.evaluate(`window.__timeline.canvas.closest('.timeline').querySelector('.timeline-easing').disabled === true`));

  // 9. Select a key, set interp 'bounce' → easing enables; set easing 'inout'
  //    → the key gains easing 'inout'; ONE Ctrl+Z reverts the easing.
  const cubeId = await t.evaluate(`window.__app.scene.activeObject.id`);
  const gEase = await t.evaluate(`(() => {
    const r = window.__timeline.canvas.getBoundingClientRect();
    const d = window.__timeline.diamondXY(${cubeId}, 1);
    return d ? { x: r.left + d.x, y: r.top + d.y } : null;
  })()`);
  t.check('object-row diamond @1 has a screen position', !!gEase);
  await t.click(gEase.x, gEase.y);
  t.check('a key is selected for the easing test',
    (await t.evaluate(`window.__timeline.selectedKeys().length`)) >= 1);

  await t.evaluate(`(() => {
    const s = window.__timeline.canvas.closest('.timeline').querySelector('.timeline-interp');
    s.value = 'bounce'; s.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(150); // let a frame run so syncHeader re-evaluates the easing enable
  const interpIsBounce = await t.evaluate(`(() => {
    const lx = window.__app.scene.activeObject.anim.fcurves.find(c => c.channelPath === 'location.x');
    return lx.keys.find(k => k.frame === 1).interp;
  })()`);
  t.check("interp select set the key to 'bounce'", interpIsBounce === 'bounce', interpIsBounce);
  t.check('easing select enables once interp is an eased family',
    await t.evaluate(`window.__timeline.canvas.closest('.timeline').querySelector('.timeline-easing').disabled === false`));

  await t.evaluate(`(() => {
    const s = window.__timeline.canvas.closest('.timeline').querySelector('.timeline-easing');
    s.value = 'inout'; s.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(120);
  const easingSet = await t.evaluate(`(() => {
    const lx = window.__app.scene.activeObject.anim.fcurves.find(c => c.channelPath === 'location.x');
    return lx.keys.find(k => k.frame === 1).easing;
  })()`);
  t.check("easing select set the key easing to 'inout'", easingSet === 'inout', String(easingSet));

  await t.key('z', 'KeyZ', 2); // Ctrl+Z
  await t.sleep(120);
  const easingReverted = await t.evaluate(`(() => {
    const lx = window.__app.scene.activeObject.anim.fcurves.find(c => c.channelPath === 'location.x');
    return lx.keys.find(k => k.frame === 1).easing;
  })()`);
  t.check('ONE Ctrl+Z reverts the easing change (back to auto/undefined)',
    easingReverted === undefined, String(easingReverted));

  // 10. Single-clock guard: the default Layout Timeline AND this suite's pane
  //     are both alive; playback must advance the clock ONCE (~fps*0.6s), not
  //     twice. Wide range so no loop wrap during the ~600ms window.
  await t.evaluate(`(() => {
    const s = window.__app.scene;
    s.playing = false; s.frameStart = 1; s.frameEnd = 500; s.frameCurrent = 1;
  })()`);
  await t.sleep(60);
  const fps = await t.evaluate(`window.__app.scene.fps`);
  const f0 = await t.evaluate(`window.__app.scene.frameCurrent`);
  await t.evaluate(`(() => { [...document.querySelectorAll('.timeline-play')][0].click(); })()`);
  await t.sleep(600);
  await t.evaluate(`(() => { window.__app.scene.playing = false; })()`);
  await t.sleep(80);
  const f1 = await t.evaluate(`window.__app.scene.frameCurrent`);
  const advanced = f1 - f0;
  const expected = fps * 0.6;
  t.check('playback advanced ~fps*0.6 frames (single clock, not doubled)',
    advanced >= expected * 0.6 && advanced <= expected * 1.4,
    `advanced=${advanced} expected≈${expected.toFixed(1)} (fps=${fps})`);

  // 11. View navigation — wheel zoom-to-mouse, MMB pan, view is independent of
  //     the header fields, '.' zoom-to-selected, and the adaptive grid.
  const PAD_LEFT = 96, PAD_RIGHT = 12; // module consts (see timeline.ts)
  await t.evaluate(`(() => {
    const s = window.__app.scene;
    s.frameStart = 1; s.frameEnd = 24; s.frameCurrent = 1; s.playing = false;
  })()`);
  // Known baseline view sized to the actual plot width (~9 px/frame) so the grid
  // is at a normal density regardless of how wide this pane happens to be.
  await t.evaluate(`(() => {
    const w = window.__timeline.canvas.getBoundingClientRect().width;
    const plotW = Math.max(1, w - ${PAD_LEFT} - ${PAD_RIGHT});
    window.__timeline.setView(0, plotW / 9);
  })()`);
  await t.sleep(80);
  const gsDefault = await t.evaluate(`window.__timeline.gridSteps()`);
  t.check('gridSteps() default major is 5 or 10',
    gsDefault.major === 5 || gsDefault.major === 10, JSON.stringify(gsDefault));
  t.check('gridSteps() default minor is 1 or 2',
    gsDefault.minor === 1 || gsDefault.minor === 2, JSON.stringify(gsDefault));

  // Zoomed out via setView(0, 2000): major climbs to ≥ 50, minor = major/5.
  await t.evaluate(`window.__timeline.setView(0, 2000)`);
  await t.sleep(60);
  const gsOut = await t.evaluate(`window.__timeline.gridSteps()`);
  t.check('gridSteps() major ≥ 50 when zoomed way out', gsOut.major >= 50, JSON.stringify(gsOut));
  t.check('gridSteps() major/minor === 5 (recursive ladder)',
    gsOut.minor > 0 && gsOut.major / gsOut.minor === 5, JSON.stringify(gsOut));

  // --- Wheel zoom-to-mouse over the canvas centre ---
  await t.evaluate(`window.__timeline.setView(0, 60)`);
  await t.sleep(60);
  const cgeo = await t.evaluate(`(() => {
    const r = window.__timeline.canvas.getBoundingClientRect();
    return { left: r.left, top: r.top, w: r.width };
  })()`);
  const centerLocalX = cgeo.w / 2;
  const frameUnder = (v) => v.start + ((centerLocalX - PAD_LEFT) / (cgeo.w - PAD_LEFT - PAD_RIGHT)) * (v.end - v.start);
  const vBeforeZoom = await t.evaluate(`window.__timeline.view()`);
  const frameBefore = frameUnder(vBeforeZoom);
  // Three notches of zoom-in at the canvas centre.
  await t.evaluate(`(() => {
    const cv = window.__timeline.canvas;
    const r = cv.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + 8;
    for (let i = 0; i < 3; i++) {
      cv.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
    }
  })()`);
  await t.sleep(60);
  const vAfterZoom = await t.evaluate(`window.__timeline.view()`);
  const frameAfter = frameUnder(vAfterZoom);
  const spanBefore = vBeforeZoom.end - vBeforeZoom.start;
  const spanAfter = vAfterZoom.end - vAfterZoom.start;
  t.check('wheel zoom-in shrinks the view span', spanAfter < spanBefore * 0.95,
    `${spanBefore.toFixed(2)} -> ${spanAfter.toFixed(2)}`);
  t.check('zoom is anchored at the mouse (frame under cursor ≈ unchanged)',
    Math.abs(frameAfter - frameBefore) <= 0.5, `${frameBefore.toFixed(3)} -> ${frameAfter.toFixed(3)}`);

  // --- MMB drag left → view start/end both increase, span unchanged ---
  const vBeforePan = await t.evaluate(`window.__timeline.view()`);
  const panGeo = await t.evaluate(`(() => {
    const r = window.__timeline.canvas.getBoundingClientRect();
    return { cx: r.left + r.width / 2, cy: r.top + 8 };
  })()`);
  await t.mouse('mouseMoved', panGeo.cx, panGeo.cy);
  await t.mouse('mousePressed', panGeo.cx, panGeo.cy, 'middle');
  await t.mouse('mouseMoved', panGeo.cx - 120, panGeo.cy, 'middle');
  await t.mouse('mouseReleased', panGeo.cx - 120, panGeo.cy, 'middle');
  await t.sleep(60);
  const vAfterPan = await t.evaluate(`window.__timeline.view()`);
  const spanPanBefore = vBeforePan.end - vBeforePan.start;
  const spanPanAfter = vAfterPan.end - vAfterPan.start;
  t.check('MMB drag-left increases view start (content moved left)',
    vAfterPan.start > vBeforePan.start, `${vBeforePan.start.toFixed(2)} -> ${vAfterPan.start.toFixed(2)}`);
  t.check('MMB drag-left increases view end',
    vAfterPan.end > vBeforePan.end, `${vBeforePan.end.toFixed(2)} -> ${vAfterPan.end.toFixed(2)}`);
  t.check('MMB pan keeps span unchanged (±1%)',
    Math.abs(spanPanAfter - spanPanBefore) <= spanPanBefore * 0.01,
    `${spanPanBefore.toFixed(3)} vs ${spanPanAfter.toFixed(3)}`);

  // --- Editing the End header field must NOT move the view ---
  const vBeforeEnd = await t.evaluate(`window.__timeline.view()`);
  await t.evaluate(`(() => {
    const inp = window.__timeline.canvas.closest('.timeline').querySelector('.timeline-end');
    inp.value = '120'; inp.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(80);
  const endApplied = await t.evaluate(`window.__app.scene.frameEnd`);
  const vAfterEnd = await t.evaluate(`window.__timeline.view()`);
  t.check('End field updated scene.frameEnd', endApplied === 120, `frameEnd=${endApplied}`);
  t.check('End field did NOT move the view',
    Math.abs(vAfterEnd.start - vBeforeEnd.start) < 1e-6 && Math.abs(vAfterEnd.end - vBeforeEnd.end) < 1e-6,
    JSON.stringify({ before: vBeforeEnd, after: vAfterEnd }));

  // --- '.' zoom-to-selected → view centres on the selected key, span shrinks ---
  // Key the cube back to a clean 1/24 pair (earlier steps left it keyed) and
  // select the frame-24 diamond.
  await t.evaluate(`(() => {
    const s = window.__app.scene; s.frameStart = 1; s.frameEnd = 24; s.frameCurrent = 1;
  })()`);
  await t.evaluate(`window.__timeline.setView(0, 60)`);
  await t.sleep(60);
  const dsel = await t.evaluate(`(() => {
    const r = window.__timeline.canvas.getBoundingClientRect();
    const d = window.__timeline.diamondXY(${await t.evaluate(`window.__app.scene.activeObject.id`)}, 24);
    return d ? { x: r.left + d.x, y: r.top + d.y } : null;
  })()`);
  t.check('a diamond @24 is on screen for the zoom-to-selected test', !!dsel);
  await t.click(dsel.x, dsel.y);
  t.check('a key is selected for zoom-to-selected',
    (await t.evaluate(`window.__timeline.selectedKeys().length`)) >= 1);
  const vBeforeDot = await t.evaluate(`window.__timeline.view()`);
  await t.mouse('mouseMoved', dsel.x, dsel.y); // ensure hovered
  await t.key('.', 'Period');
  await t.sleep(60);
  const vAfterDot = await t.evaluate(`window.__timeline.view()`);
  const centerDot = (vAfterDot.start + vAfterDot.end) / 2;
  t.check("'.' zoom-to-selected centres the view near the selected key (24)",
    Math.abs(centerDot - 24) <= 2, `center=${centerDot.toFixed(2)}`);
  t.check("'.' zoom-to-selected shrinks the span",
    (vAfterDot.end - vAfterDot.start) < (vBeforeDot.end - vBeforeDot.start),
    `${(vBeforeDot.end - vBeforeDot.start).toFixed(2)} -> ${(vAfterDot.end - vAfterDot.start).toFixed(2)}`);

  // Leave state clean for later suites.
  await t.evaluate(`(() => {
    const s = window.__app.scene;
    s.frameStart = 1; s.frameEnd = 250; s.frameCurrent = 1; s.playing = false;
    s.selectedObjects.forEach((o) => { o.anim = undefined; });
  })()`);
});
