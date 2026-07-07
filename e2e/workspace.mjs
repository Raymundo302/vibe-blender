/**
 * Workspace/area system e2e (P4-1): tabs, editor switching with viewport
 * swap, fullscreen, gutter resize, persistence.
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  const q = (sel, expr) => t.evaluate(`(() => { const el = document.querySelector('${sel}'); return el ? ${expr} : null; })()`);

  // Layout workspace boots with 3 areas: viewport + outliner + properties.
  t.check('workspace tabs render', (await t.evaluate(`document.querySelectorAll('.wsp-tab').length`)) === 2);
  t.check('Layout tab active', await q('.wsp-tab-active', `el.dataset.workspace === 'Layout'`));
  t.check('three areas in Layout', (await t.evaluate(`document.querySelectorAll('.wsp-area').length`)) === 3);
  t.check('canvas lives inside an area',
    await t.evaluate(`!!document.querySelector('.wsp-area-body #viewport-wrap canvas')`));

  // Editor switching with singleton swap: tell the outliner area to become the
  // viewport → the old viewport area must take 'outliner' (swap, not duplicate).
  await t.evaluate(`(() => {
    const selects = [...document.querySelectorAll('.wsp-area-select')];
    const outlinerSel = selects.find((s) => s.value === 'outliner');
    outlinerSel.value = 'viewport';
    outlinerSel.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(150);
  t.check('viewport swapped into the outliner area (still exactly one canvas)',
    (await t.evaluate(`document.querySelectorAll('#viewport').length`)) === 1);
  t.check('displaced area took the outliner',
    (await t.evaluate(`[...document.querySelectorAll('.wsp-area-select')].filter((s) => s.value === 'outliner').length`)) === 1);
  const smallCanvas = await t.evaluate(`document.querySelector('canvas').getBoundingClientRect().width`);
  t.check('canvas resized into the side column', smallCanvas < 500, `${smallCanvas}px`);

  // App still renders + picks after the canvas moved (GL context survives).
  const pick = await t.evaluate(`(() => {
    const r = document.querySelector('canvas').getBoundingClientRect();
    return window.__app.renderer.pick(window.__app.scene, window.__app.camera, r.width / 2, r.height * 0.48);
  })()`);
  // The gizmo sits at the cube's origin, so center picks may hit either — both
  // prove the GL context and pick FBOs survived the reparent.
  t.check('picking still works after reparenting the canvas',
    pick !== null && (pick.kind === 'object' || pick.kind === 'gizmo'), JSON.stringify(pick));

  // Swap back for the rest of the checks.
  await t.evaluate(`(() => {
    const selects = [...document.querySelectorAll('.wsp-area-select')];
    const target = selects.find((s) => s.value === 'outliner');
    target.value = 'viewport';
    target.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(150);

  // Fullscreen: the viewport area's ⛶ makes the canvas span the workspace root.
  const before = await t.evaluate(`document.querySelector('canvas').getBoundingClientRect().width`);
  await t.evaluate(`(() => {
    const canvasArea = document.querySelector('#viewport-wrap').closest('.wsp-area');
    canvasArea.querySelector('.wsp-area-full-btn').click();
  })()`);
  await t.sleep(200);
  const fullW = await t.evaluate(`document.querySelector('canvas').getBoundingClientRect().width`);
  t.check('fullscreen expands the canvas', fullW > before + 100, `${before} → ${fullW}`);
  await t.evaluate(`document.querySelector('.wsp-area-fullscreen .wsp-area-full-btn').click()`);
  await t.sleep(200);
  t.check('fullscreen toggles back',
    Math.abs((await t.evaluate(`document.querySelector('canvas').getBoundingClientRect().width`)) - before) < 8);

  // Workspace tab switch: Modeling has 2 areas and keeps the one canvas alive.
  await t.evaluate(`document.querySelector('.wsp-tab[data-workspace="Modeling"]').click()`);
  await t.sleep(200);
  t.check('Modeling tab activates', await q('.wsp-tab-active', `el.dataset.workspace === 'Modeling'`));
  t.check('Modeling has two areas', (await t.evaluate(`document.querySelectorAll('.wsp-area').length`)) === 2);
  t.check('canvas survived the workspace switch',
    (await t.evaluate(`document.querySelectorAll('#viewport').length`)) === 1);

  // Layout choices persist to localStorage.
  t.check('layout persisted', await t.evaluate(
    `(() => { const raw = localStorage.getItem('vibe-blender-workspaces-v1'); return !!raw && JSON.parse(raw).workspaces.length === 2; })()`));

  // Back to Layout; the app still renders and the original areas return.
  await t.evaluate(`document.querySelector('.wsp-tab[data-workspace="Layout"]').click()`);
  await t.sleep(200);
  t.check('back to Layout with three areas', (await t.evaluate(`document.querySelectorAll('.wsp-area').length`)) === 3);

  await t.screenshot('/tmp/vibe-blender-workspaces.png');
});
