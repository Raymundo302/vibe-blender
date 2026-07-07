/**
 * UV Editor e2e (P11-2). Seeds UVs directly on the active mesh (deterministic —
 * does NOT depend on P11-1's unwrap landing), switches a workspace area to the
 * 'UV Editor', and exercises: checker draws, island select, G modal transform
 * (mutates mesh.uvs + ONE undo entry), Ctrl+Z restore. Also confirms the frozen
 * workspace suite's world isn't disturbed (2 tabs, canvas scoped).
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  // 1. Seed two disjoint UV islands on the active object's BASE mesh.
  const fids = await t.evaluate(`(() => {
    const s = window.__app.scene;
    const obj = s.activeObject;
    const fids = [...obj.mesh.faces.keys()];
    obj.mesh.setFaceUVs(fids[0], [[0.1,0.1],[0.9,0.1],[0.9,0.9],[0.1,0.9]]); // big island, contains (0.5,0.5)
    obj.mesh.setFaceUVs(fids[1], [[0.92,0.92],[0.98,0.92],[0.98,0.98],[0.92,0.98]]); // tiny disjoint island
    return fids.slice(0, 2);
  })()`);
  t.check('seeded two faces with UVs', Array.isArray(fids) && fids.length === 2);

  // 2. Adding the UV editor factory must NOT disturb the frozen workspace world.
  t.check('still exactly two workspace tabs',
    (await t.evaluate(`document.querySelectorAll('.wsp-tab').length`)) === 2);
  t.check("'UV Editor' offered in every area dropdown",
    await t.evaluate(`[...document.querySelectorAll('.wsp-area-select option')].some(o => o.value === 'uv')`));

  // 3. Switch the Properties area to the UV Editor.
  await t.evaluate(`(() => {
    const sel = [...document.querySelectorAll('.wsp-area-select')].find(s => s.value === 'properties');
    sel.value = 'uv';
    sel.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(300); // let the frame loop size + draw the canvas

  t.check('UV editor canvas mounted', await t.evaluate(`!!document.querySelector('.uv-editor-canvas')`));
  t.check('island detection finds 2 islands',
    (await t.evaluate(`document.querySelector('.uv-editor').__uvEditor.islandCount()`)) === 2);

  // 4. Checker background is visible: sample the middle row for ≥2 distinct grays.
  const tones = await t.evaluate(`(() => {
    const api = document.querySelector('.uv-editor').__uvEditor;
    const rect = api.canvas.getBoundingClientRect();
    const cy = rect.height / 2;
    const set = new Set();
    for (let x = 5; x < rect.width - 5; x += 4) set.add(api.pixelAt(x, cy)[0]);
    return [...set].filter((v) => v >= 45);
  })()`);
  t.check('procedural checker visible (>=2 gray tones)', tones.length >= 2, JSON.stringify(tones));

  // 5. Click the big island at the canvas center → it gets selected.
  const rect = await t.evaluate(`(() => {
    const r = document.querySelector('.uv-editor-canvas').getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  })()`);
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  await t.click(cx, cy);
  const selected = await t.evaluate(`document.querySelector('.uv-editor').__uvEditor.selectedFaces()`);
  t.check('clicking an island selects it', selected.length === 1 && selected[0] === fids[0], JSON.stringify(selected));

  // Highlight is drawn in the theme accent — probe the fill at center for a
  // warm (r > b) pixel (accent #fe730f), proving the selection overlay renders.
  const centerPx = await t.evaluate(`document.querySelector('.uv-editor').__uvEditor.pixelAt(${rect.width / 2}, ${rect.height / 2})`);
  t.check('selected island tinted with accent (warm pixel)', centerPx[0] > centerPx[2] + 15, JSON.stringify(centerPx));

  // 6. G modal transform: grab, move, click to confirm → uvs change, ONE undo.
  const before = await t.evaluate(`JSON.stringify(window.__app.scene.activeObject.mesh.uvs.get(${fids[0]}))`);
  await t.mouse('mouseMoved', cx, cy); // re-hover so pointerUV baseline is the center
  await t.key('g', 'KeyG');
  await t.mouse('mouseMoved', cx + 45, cy - 25); // drag the island
  await t.sleep(60);
  await t.click(cx + 45, cy - 25); // LMB confirms
  await t.sleep(60);

  const after = await t.evaluate(`JSON.stringify(window.__app.scene.activeObject.mesh.uvs.get(${fids[0]}))`);
  t.check('G transform mutated mesh.uvs', after !== before, `${before} -> ${after}`);
  t.check('transform gesture ended',
    (await t.evaluate(`document.querySelector('.uv-editor').__uvEditor.transforming()`)) === null);
  const otherUnchanged = await t.evaluate(`JSON.stringify(window.__app.scene.activeObject.mesh.uvs.get(${fids[1]})) === '[[0.92,0.92],[0.98,0.92],[0.98,0.98],[0.92,0.98]]'`);
  t.check('the other island was not moved', otherUnchanged);

  // 7. Ctrl+Z restores; a second Ctrl+Z is a no-op → exactly ONE undo entry.
  await t.key('z', 'KeyZ', 2); // ctrl
  await t.sleep(60);
  const restored = await t.evaluate(`JSON.stringify(window.__app.scene.activeObject.mesh.uvs.get(${fids[0]}))`);
  t.check('Ctrl+Z restores the pre-transform UVs', restored === before, `${restored}`);

  await t.key('z', 'KeyZ', 2);
  await t.sleep(60);
  const stillRestored = await t.evaluate(`JSON.stringify(window.__app.scene.activeObject.mesh.uvs.get(${fids[0]}))`);
  t.check('exactly one undo entry (second Ctrl+Z is a no-op)', stillRestored === before);

  // 8. A selects all islands' faces, Alt+A clears (editor is focused/hovered).
  await t.mouse('mouseMoved', cx, cy);
  await t.key('a', 'KeyA');
  await t.sleep(40);
  const all = await t.evaluate(`document.querySelector('.uv-editor').__uvEditor.selectedFaces().length`);
  t.check('A selects all UV faces', all === 2, `${all}`);
  await t.key('a', 'KeyA', 1); // alt
  await t.sleep(40);
  const cleared = await t.evaluate(`document.querySelector('.uv-editor').__uvEditor.selectedFaces().length`);
  t.check('Alt+A clears the selection', cleared === 0, `${cleared}`);
});
