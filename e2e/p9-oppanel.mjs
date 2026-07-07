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

  // Click the Torus item.
  await t.evaluate(`(() => {
    const items = [...document.querySelectorAll('.add-menu-item')];
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
});
