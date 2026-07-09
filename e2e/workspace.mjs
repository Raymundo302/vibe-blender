/**
 * Workspace/area system e2e (P4-1): tabs, editor switching with viewport
 * swap, fullscreen, gutter resize, persistence.
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  const q = (sel, expr) => t.evaluate(`(() => { const el = document.querySelector('${sel}'); return el ? ${expr} : null; })()`);

  // Start from a pristine default layout — a stale layout left in localStorage
  // by an earlier run would otherwise make the area counts flaky.
  await t.evaluate(`localStorage.removeItem('vibe-blender-workspaces-v2')`);
  await t.reload();

  // Layout workspace boots with 4 areas: viewport + timeline (col 1),
  // outliner + properties (col 2).
  t.check('workspace tabs render', (await t.evaluate(`document.querySelectorAll('.wsp-tab').length`)) === 2);
  t.check('Layout tab active', await q('.wsp-tab-active', `el.dataset.workspace === 'Layout'`));
  t.check('four areas in Layout', (await t.evaluate(`document.querySelectorAll('.wsp-area').length`)) === 4);
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
  const smallCanvas = await t.evaluate(`document.querySelector('#viewport-wrap canvas').getBoundingClientRect().width`);
  t.check('canvas resized into the side column', smallCanvas < 500, `${smallCanvas}px`);

  // App still renders + picks after the canvas moved (GL context survives).
  const pick = await t.evaluate(`(() => {
    const r = document.querySelector('#viewport-wrap canvas').getBoundingClientRect();
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
  const before = await t.evaluate(`document.querySelector('#viewport-wrap canvas').getBoundingClientRect().width`);
  await t.evaluate(`(() => {
    const canvasArea = document.querySelector('#viewport-wrap').closest('.wsp-area');
    canvasArea.querySelector('.wsp-area-full-btn').click();
  })()`);
  await t.sleep(200);
  const fullW = await t.evaluate(`document.querySelector('#viewport-wrap canvas').getBoundingClientRect().width`);
  t.check('fullscreen expands the canvas', fullW > before + 100, `${before} → ${fullW}`);
  await t.evaluate(`document.querySelector('.wsp-area-fullscreen .wsp-area-full-btn').click()`);
  await t.sleep(200);
  t.check('fullscreen toggles back',
    Math.abs((await t.evaluate(`document.querySelector('#viewport-wrap canvas').getBoundingClientRect().width`)) - before) < 8);

  // Workspace tab switch: Modeling has 2 areas and keeps the one canvas alive.
  await t.evaluate(`document.querySelector('.wsp-tab[data-workspace="Modeling"]').click()`);
  await t.sleep(200);
  t.check('Modeling tab activates', await q('.wsp-tab-active', `el.dataset.workspace === 'Modeling'`));
  t.check('Modeling has two areas', (await t.evaluate(`document.querySelectorAll('.wsp-area').length`)) === 2);
  t.check('canvas survived the workspace switch',
    (await t.evaluate(`document.querySelectorAll('#viewport').length`)) === 1);

  // Layout choices persist to localStorage.
  t.check('layout persisted', await t.evaluate(
    `(() => { const raw = localStorage.getItem('vibe-blender-workspaces-v2'); return !!raw && JSON.parse(raw).workspaces.length === 2; })()`));

  // Back to Layout; the app still renders and the original areas return.
  await t.evaluate(`document.querySelector('.wsp-tab[data-workspace="Layout"]').click()`);
  await t.sleep(200);
  t.check('back to Layout with four areas', (await t.evaluate(`document.querySelectorAll('.wsp-area').length`)) === 4);

  // ---------------------------------------------------------------------------
  // Split / merge (area management via the ⋮ header menu + corner drag).
  // Default Layout = col1[viewport, timeline] + col2[outliner, properties] = 4.
  // ---------------------------------------------------------------------------
  const areaCount = () => t.evaluate(`document.querySelectorAll('.wsp-area').length`);
  const colCount = () => t.evaluate(`document.querySelectorAll('.wsp-col').length`);
  const resetLayout = async () => {
    await t.evaluate(`localStorage.removeItem('vibe-blender-workspaces-v2')`);
    await t.reload();
  };
  // Open an area's ⋮ menu and click one of its rows. `findExpr` must evaluate to
  // the target .wsp-area element. The menu builds its rows synchronously on the
  // button click, so we can click the row in the same evaluate.
  const menuAction = (findExpr, action) => t.evaluate(`(() => {
    const target = ${findExpr};
    if (!target) return 'no-target';
    target.querySelector('.wsp-area-menu-btn').click();
    const row = document.querySelector('.wsp-area-menu [data-area-action="${action}"]');
    if (!row) return 'no-row';
    row.click();
    return 'ok';
  })()`);
  // Drag the corner hotspot by (dx, dy) past the ~12px resolve threshold.
  const cornerDrag = (findExpr, dx, dy) => t.evaluate(`(() => {
    const area = ${findExpr};
    if (!area) return 'no-area';
    const corner = area.querySelector('.wsp-area-corner');
    if (!corner) return 'no-corner';
    const r = corner.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const mk = (type, x, y) => new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', button: 0 });
    corner.dispatchEvent(mk('pointerdown', cx, cy));
    corner.dispatchEvent(mk('pointermove', cx + ${dx}, cy + ${dy}));
    corner.dispatchEvent(mk('pointerup', cx + ${dx}, cy + ${dy}));
    return 'ok';
  })()`);
  const OUTLINER_AREA = `[...document.querySelectorAll('.wsp-area')].find((a) => a.querySelector('.wsp-area-select').value === 'outliner')`;
  const PROPERTIES_AREA = `[...document.querySelectorAll('.wsp-area')].find((a) => a.querySelector('.wsp-area-select').value === 'properties')`;
  const VIEWPORT_AREA = `document.querySelector('#viewport-wrap').closest('.wsp-area')`;

  await resetLayout();
  t.check('reset to default Layout (4 areas)', (await areaCount()) === 4);

  // (a) Split Vertical on the (non-viewport) outliner area.
  t.check('split-v menu fired', (await menuAction(OUTLINER_AREA, 'split-v')) === 'ok');
  await t.sleep(150);
  t.check('split-v: area count +1', (await areaCount()) === 5);
  t.check('split-v: source editor duplicated (two outliners)',
    (await t.evaluate(`[...document.querySelectorAll('.wsp-area-select')].filter((s) => s.value === 'outliner').length`)) === 2);
  t.check('split-v: new area is in the same column (col2 now 3 areas)', (await t.evaluate(`(() => {
    const col = [...document.querySelectorAll('.wsp-col')].find((c) => [...c.querySelectorAll('.wsp-area-select')].some((s) => s.value === 'outliner'));
    return col ? col.querySelectorAll(':scope > .wsp-area').length : 0;
  })()`)) === 3);
  t.check('split-v: still two columns', (await colCount()) === 2);

  // (b) Split Horizontal on the properties area → a new column appears.
  t.check('split-h menu fired', (await menuAction(PROPERTIES_AREA, 'split-h')) === 'ok');
  await t.sleep(150);
  t.check('split-h: column count +1', (await colCount()) === 3);

  // (c) Split on the 3D Viewport area → the new sibling is an Outliner (the
  //     singleton is never duplicated) and the viewport still exists once.
  await resetLayout();
  t.check('viewport-split menu fired', (await menuAction(VIEWPORT_AREA, 'split-v')) === 'ok');
  await t.sleep(200);
  t.check('split viewport: new sibling defaults to outliner', await t.evaluate(`(() => {
    const col = document.querySelector('#viewport-wrap').closest('.wsp-col');
    const sels = [...col.querySelectorAll('.wsp-area-select')].map((s) => s.value);
    return sels.includes('viewport') && sels.includes('outliner');
  })()`));
  t.check('split viewport: exactly one viewport still present',
    (await t.evaluate(`document.querySelectorAll('#viewport').length`)) === 1);
  t.check('split viewport: area count +1 (5)', (await areaCount()) === 5);

  // (d) Close Area → count comes back down, the space is absorbed.
  t.check('close menu fired', (await menuAction(
    `(() => { const col = document.querySelector('#viewport-wrap').closest('.wsp-col'); return [...col.querySelectorAll('.wsp-area')].find((a) => a.querySelector('.wsp-area-select').value === 'outliner'); })()`,
    'close')) === 'ok');
  await t.sleep(150);
  t.check('close: area count back down (4)', (await areaCount()) === 4);
  t.check('close: viewport column back to two areas', (await t.evaluate(`(() => {
    const col = document.querySelector('#viewport-wrap').closest('.wsp-col');
    return col.querySelectorAll(':scope > .wsp-area').length;
  })()`)) === 2);

  // (e) Close the area hosting the viewport → allowed; the viewport parks, then
  //     picking it in another dropdown reattaches the SAME canvas.
  await resetLayout();
  t.check('close-viewport menu fired', (await menuAction(VIEWPORT_AREA, 'close')) === 'ok');
  await t.sleep(150);
  t.check('closing the viewport area is allowed (3 areas left)', (await areaCount()) === 3);
  t.check('viewport canvas parked (detached from the DOM)',
    (await t.evaluate(`document.querySelector('#viewport-wrap') === null`)));
  await t.evaluate(`(() => {
    const sel = [...document.querySelectorAll('.wsp-area-select')].find((s) => s.value === 'outliner');
    sel.value = 'viewport';
    sel.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(200);
  t.check('selecting 3D Viewport reattaches the canvas into an area',
    (await t.evaluate(`!!document.querySelector('.wsp-area-body #viewport-wrap canvas')`)));
  t.check('reattached viewport is a single instance',
    (await t.evaluate(`document.querySelectorAll('#viewport').length`)) === 1);

  // (f) Refuse to close the last remaining area. Reduce to one, then no-op.
  await resetLayout();
  await menuAction(PROPERTIES_AREA, 'close');   // col2 → [outliner]
  await t.sleep(150);
  await menuAction(OUTLINER_AREA, 'close');     // col2 emptied → removed
  await t.sleep(150);
  await menuAction(`[...document.querySelectorAll('.wsp-area')].find((a) => a.querySelector('.wsp-area-select').value === 'timeline')`, 'close');
  await t.sleep(150);
  t.check('reduced to a single area', (await areaCount()) === 1);
  t.check('last-area close is a no-op', (await menuAction(`document.querySelector('.wsp-area')`, 'close')) === 'ok');
  await t.sleep(150);
  t.check('refuses to close the last area', (await areaCount()) === 1);

  // (g) Persistence: split, reload, the extra area survives.
  await menuAction(`document.querySelector('.wsp-area')`, 'split-v');
  await t.sleep(150);
  t.check('split before reload (2 areas)', (await areaCount()) === 2);
  await t.reload();
  t.check('extra area survived the reload', (await areaCount()) === 2);

  // ---------------------------------------------------------------------------
  // Corner-drag gesture (Blender's top-right corner widget).
  // ---------------------------------------------------------------------------
  // Drag DOWN into a non-viewport area → vertical split (+1 area).
  await resetLayout();
  t.check('corner drag down fired', (await cornerDrag(OUTLINER_AREA, 0, 24)) === 'ok');
  await t.sleep(150);
  t.check('corner drag down: vertical split (+1 area)', (await areaCount()) === 5);
  // Drag LEFT into an area → horizontal split (+1 column). Still 2 cols here.
  t.check('corner drag left fired', (await cornerDrag(PROPERTIES_AREA, -24, 0)) === 'ok');
  await t.sleep(150);
  t.check('corner drag left: horizontal split (+1 column)', (await colCount()) === 3);

  // Drag UP with an area above (properties has outliner above in col2) → merge
  // consumes the upper area (−1).
  await resetLayout();
  t.check('corner drag up fired', (await cornerDrag(PROPERTIES_AREA, 0, -24)) === 'ok');
  await t.sleep(150);
  t.check('corner drag up: upper area consumed (−1)', (await areaCount()) === 3);

  // No valid neighbor → no-op. UP on the top-of-column outliner, RIGHT on the
  // rightmost column, and RIGHT into a multi-area column all leave counts alone.
  await resetLayout();
  await cornerDrag(OUTLINER_AREA, 0, -24);        // outliner is top of col2 → no area above
  await t.sleep(120);
  t.check('corner drag up at column top: no-op', (await areaCount()) === 4);
  await cornerDrag(PROPERTIES_AREA, 24, 0);       // properties in rightmost column → no column right
  await t.sleep(120);
  t.check('corner drag right at last column: no-op', (await areaCount()) === 4);
  await cornerDrag(VIEWPORT_AREA, 24, 0);         // col2 to the right has 2 areas → cannot merge
  await t.sleep(120);
  t.check('corner drag right into multi-area column: no-op', (await areaCount()) === 4);

  // Leave the default Layout intact for any subsequent runs.
  await resetLayout();
  t.check('cleanup: default Layout restored (4 areas)', (await areaCount()) === 4);

  await t.screenshot('/tmp/vibe-blender-workspaces.png');
});
