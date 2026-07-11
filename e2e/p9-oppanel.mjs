/**
 * P9-3 e2e — post-Add "Adjust Last Operation" redo panel + parametric Torus.
 * Shift+A → Torus, dial Major Segments through the panel, dismiss it by
 * clicking the viewport, and confirm a single Ctrl+Z removes the torus.
 * Run under the shared lock:
 *   flock /tmp/vibe-blender-e2e.lock node e2e/p9-oppanel.mjs
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  // Layout workspace so the viewport (and #viewport-wrap) is on screen.
  await t.evaluate(`document.querySelector('.wsp-tab[data-workspace="Layout"]')?.click()`);
  await t.sleep(150);

  // Clean, deterministic object-mode start.
  await t.evaluate(`(() => { const s = window.__app.scene; if (s.editMode) s.exitEditMode(); })()`);
  await t.sleep(80);

  const objCount = () => t.evaluate('window.__app.scene.objects.length');
  const before = await objCount();

  // Canvas rect → a point safely inside the viewport.
  const rect = await t.evaluate(`(() => {
    const c = document.querySelector('#viewport-wrap canvas') || document.querySelector('canvas');
    const r = c.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  })()`);
  const cx = Math.round(rect.x + rect.w / 2);
  const cy = Math.round(rect.y + rect.h / 2);

  // Park the pointer over the viewport, then Shift+A opens the Add menu.
  await t.mouse('mouseMoved', cx, cy);
  await t.sleep(40);
  await t.key('a', 'KeyA', 8); // shift+A
  t.check('Add menu appears on Shift+A', await t.until(`!!document.querySelector('.add-menu')`));

  // UR3-4: open the Mesh category flyout, then click the Torus item inside it.
  await t.evaluate(`document.querySelector('.add-menu-category[data-category="Mesh"]').click()`);
  await t.until(`[...document.querySelectorAll('.add-menu-flyout .add-menu-item')].some((b) => b.textContent.trim() === 'Torus')`);
  await t.evaluate(`(() => {
    const items = [...document.querySelectorAll('.add-menu-flyout .add-menu-item')];
    items.find((b) => b.textContent.trim() === 'Torus').click();
  })()`);
  await t.sleep(120);

  t.check('a torus object was added', (await objCount()) === before + 1);
  t.check('active object name is Torus',
    (await t.evaluate('window.__app.scene.activeObject.name')) === 'Torus');

  // Redo panel is mounted, titled "Add Torus".
  t.check('op panel appears after the add', await t.until(`!!document.querySelector('.op-panel')`));
  t.check('op panel title reads "Add Torus"',
    (await t.evaluate(`document.querySelector('.op-panel .op-panel-header').textContent.trim()`))
      .includes('Add Torus'));

  // Default torus is the historical 48×12 = 576 verts.
  t.check('default torus has 576 verts (48×12, unchanged)',
    (await t.evaluate('window.__app.scene.activeObject.mesh.verts.size')) === 576);

  // The panel exposes a majorSegments field.
  t.check('majorSegments field present',
    await t.evaluate(`!!document.querySelector('.op-panel input[data-param="majorSegments"]')`));

  const minorSeg = Number(await t.evaluate(
    `document.querySelector('.op-panel input[data-param="minorSegments"]').value`));

  // Dial majorSegments to 12 via the panel.
  await t.evaluate(`(() => {
    const inp = document.querySelector('.op-panel input[data-param="majorSegments"]');
    inp.value = '12';
    inp.dispatchEvent(new Event('input'));
  })()`);
  await t.sleep(120);

  const verts = await t.evaluate(`(() => {
    const s = window.__app.scene;
    const o = s.activeObject;
    return o.evaluatedMesh(s.modifierContext(o)).verts.size;
  })()`);
  t.check(`majorSegments 12 → ${12 * minorSeg} verts (12 × minorSegments ${minorSeg})`,
    verts === 12 * minorSeg, `got ${verts}`);

  // Regenerating in place did NOT add an undo entry: still one add total.
  t.check('no extra object created by the tweak', (await objCount()) === before + 1);

  // Clicking in the viewport dismisses the panel. Aim at empty sky (top-center)
  // — away from the object's transform gizmo at center (grabbing a handle would
  // start a Move) and away from the panel at bottom-left.
  const skyX = Math.round(rect.x + rect.w * 0.5);
  const skyY = Math.round(rect.y + rect.h * 0.12);
  await t.click(skyX, skyY);
  await t.sleep(120);
  t.check('panel gone after a viewport click',
    !(await t.evaluate(`!!document.querySelector('.op-panel')`)));

  // Single Ctrl+Z removes the torus entirely (one undo step for add+tweak).
  await t.key('z', 'KeyZ', 2); // ctrl+z
  await t.sleep(150);
  t.check('Ctrl+Z removes the torus (single undo step)', (await objCount()) === before);

  await t.screenshot('/tmp/p9-3-oppanel.png');

  // =====================================================================
  // UR3-4 — categorized flyout submenus (Mesh ▸ / Light ▸ / Camera).
  // =====================================================================
  await t.mouse('mouseMoved', cx, cy);
  await t.sleep(40);
  await t.key('a', 'KeyA', 8); // Shift+A
  t.check('UR3-4: Add menu reopens on Shift+A',
    await t.until(`!!document.querySelector('.add-menu')`));

  // Root shows 4 rows: Mesh ▸, Light ▸, Image ▸ (UR4-3), Camera.
  const rootRows = await t.evaluate(
    `[...document.querySelector('.add-menu').querySelectorAll(':scope > .add-menu-item')].map((b) => b.dataset.category || b.textContent.trim())`);
  t.check('UR3-4: root shows the category/direct rows (Mesh, Light, Image, Camera)',
    JSON.stringify(rootRows) === JSON.stringify(['Mesh', 'Light', 'Image', 'Camera']),
    JSON.stringify(rootRows));

  // Hover Mesh → flyout with ALL primitives, positioned at the row's right.
  await t.evaluate(`document.querySelector('.add-menu-category[data-category="Mesh"]').dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }))`);
  await t.until(`!!document.querySelector('.add-menu-flyout')`);
  const meshFlyout = await t.evaluate(`(() => {
    const fly = document.querySelector('.add-menu-flyout');
    const labels = [...fly.querySelectorAll('.add-menu-item')].map((b) => b.textContent.trim());
    const root = document.querySelector('.add-menu');
    const fr = fly.getBoundingClientRect(), rr = root.getBoundingClientRect();
    return { labels, rightOfRoot: fr.left >= rr.right - 1, count: labels.length };
  })()`);
  t.check('UR3-4: hover Mesh opens a flyout listing primitives',
    meshFlyout.labels.includes('Cube') && meshFlyout.labels.includes('Torus'),
    JSON.stringify(meshFlyout.labels));
  t.check('UR3-4: Mesh flyout sits at the row\'s right edge', meshFlyout.rightOfRoot);

  // Hover Light → Mesh flyout closes, Light flyout opens (one flyout at a time).
  await t.evaluate(`document.querySelector('.add-menu-category[data-category="Light"]').dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }))`);
  await t.sleep(30);
  const lightState = await t.evaluate(`(() => {
    const flys = [...document.querySelectorAll('.add-menu-flyout')];
    const labels = flys.length ? [...flys[0].querySelectorAll('.add-menu-item')].map((b) => b.textContent.trim()) : [];
    return { flyoutCount: flys.length, labels };
  })()`);
  t.check('UR3-4: hovering Light leaves exactly one flyout open', lightState.flyoutCount === 1);
  t.check('UR3-4: the open flyout is now the Light list',
    lightState.labels.includes('Point') && lightState.labels.includes('Sun') && lightState.labels.includes('Spot'),
    JSON.stringify(lightState.labels));

  // Add a Cube through the Mesh submenu → +1 object, exactly ONE undo push.
  const beforeCube = await objCount();
  const pushesBefore = await t.evaluate(`window.__app.undo.pushCount`);
  await t.evaluate(`document.querySelector('.add-menu-category[data-category="Mesh"]').click()`);
  await t.until(`[...document.querySelectorAll('.add-menu-flyout .add-menu-item')].some((b) => b.textContent.trim() === 'Cube')`);
  await t.evaluate(`[...document.querySelectorAll('.add-menu-flyout .add-menu-item')].find((b) => b.textContent.trim() === 'Cube').click()`);
  await t.sleep(120);
  t.check('UR3-4: Cube added via the submenu', (await objCount()) === beforeCube + 1);
  t.check('UR3-4: active object is the Cube',
    (await t.evaluate('window.__app.scene.activeObject.name')) === 'Cube');
  t.check('UR3-4: the add is exactly ONE undo entry',
    (await t.evaluate(`window.__app.undo.pushCount`)) === pushesBefore + 1);
  t.check('UR3-4: menu closed after the add',
    await t.evaluate(`!document.querySelector('.add-menu')`));
  // Single Ctrl+Z removes the cube (unchanged add semantics).
  await t.key('z', 'KeyZ', 2);
  await t.sleep(120);
  t.check('UR3-4: Ctrl+Z removes the cube (single undo step)',
    (await objCount()) === beforeCube);

  // Escape closes everything (root + any open flyout).
  await t.mouse('mouseMoved', cx, cy);
  await t.sleep(40);
  await t.key('a', 'KeyA', 8); // Shift+A
  await t.until(`!!document.querySelector('.add-menu')`);
  await t.evaluate(`document.querySelector('.add-menu-category[data-category="Mesh"]').dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }))`);
  await t.until(`!!document.querySelector('.add-menu-flyout')`);
  await t.key('Escape', 'Escape', 0);
  await t.sleep(80);
  t.check('UR3-4: Escape closes root and flyout',
    await t.evaluate(`!document.querySelector('.add-menu') && !document.querySelector('.add-menu-flyout')`));
});
