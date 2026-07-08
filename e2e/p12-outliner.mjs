/**
 * P12-3 e2e — Outliner parent hierarchy + drag-to-parent.
 *
 * Boots, builds an A→B→C parent chain via scene.setParentKeepTransform, and
 * asserts the outliner nests B under A and C under B, that collapsing A's twisty
 * hides B and C, that dragging a root object D onto A parents it (undone by one
 * Ctrl+Z), that dropping C onto a collection header clears its parent, and that
 * a child row's rename/eye/delete controls still work.
 *
 *   flock /tmp/vibe-blender-e2e.lock node e2e/p12-outliner.mjs
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  // Layout workspace so the Outliner is on screen; dismiss the splash.
  await t.evaluate(`document.querySelector('.wsp-tab[data-workspace="Layout"]')?.click()`);
  await t.sleep(150);
  const rect = await t.evaluate(
    `(() => { const r = document.querySelector('canvas').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
  );
  await t.click(rect.x, rect.y); // dismiss splash

  // Reset to exactly four root objects A, B, C, D (no collections).
  await t.evaluate(`(() => {
    const s = window.__app.scene;
    if (s.editMode) s.exitEditMode();
    window.__app.undo.clear();
    for (const c of [...s.collections]) s.removeCollection(c.id);
    while (s.objects.length > 1) s.remove(s.objects[s.objects.length - 1].id);
    const a = s.objects[0]; a.name = 'ObjA';
    const b = s.duplicate(a, 'ObjB');
    const c = s.duplicate(a, 'ObjC');
    const d = s.duplicate(a, 'ObjD');
    s.selectOnly(a.id);
    window.__ids = { a: a.id, b: b.id, c: c.id, d: d.id };
  })()`);
  await t.sleep(150);
  const ids = await t.evaluate('window.__ids');

  // --- Build the A→B→C chain via the public core entry point ---
  await t.evaluate(`(() => {
    const s = window.__app.scene;
    s.setParentKeepTransform(s.get(${ids.b}), s.get(${ids.a}));
    s.setParentKeepTransform(s.get(${ids.c}), s.get(${ids.b}));
  })()`);
  await t.sleep(150);

  // Helper: pixel center of an object's row, or null if not rendered.
  const rowCenter = async (id) => t.evaluate(`(() => {
    const el = document.querySelector('.outliner-row[data-obj-id="${id}"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, pad: el.style.paddingLeft };
  })()`);

  const padOf = (c) => (c ? parseFloat(c.pad) : NaN);
  const aRow = await rowCenter(ids.a);
  const bRow = await rowCenter(ids.b);
  const cRow = await rowCenter(ids.c);
  t.check('B nests one level under A', padOf(bRow) > padOf(aRow));
  t.check('C nests deeper than B', padOf(cRow) > padOf(bRow));
  t.check('A shows an expanded twisty',
    (await t.evaluate(`document.querySelector('.outliner-row[data-obj-id="${ids.a}"] .outliner-twisty').textContent`)) === '▾');

  // --- Collapse A's twisty hides B and C rows ---
  await t.evaluate(`document.querySelector('.outliner-row[data-obj-id="${ids.a}"] .outliner-twisty').click()`);
  await t.sleep(120);
  t.check('collapsing A hides B',
    (await rowCenter(ids.b)) === null);
  t.check('collapsing A hides C',
    (await rowCenter(ids.c)) === null);
  t.check('A twisty now shows collapsed glyph',
    (await t.evaluate(`document.querySelector('.outliner-row[data-obj-id="${ids.a}"] .outliner-twisty').textContent`)) === '▸');

  // Re-expand for the drag test.
  await t.evaluate(`document.querySelector('.outliner-row[data-obj-id="${ids.a}"] .outliner-twisty').click()`);
  await t.sleep(120);

  // --- Drag root object D onto A → D parents to A ---
  const dRow = await rowCenter(ids.d);
  const aRow2 = await rowCenter(ids.a);
  await t.evaluate(`window.__app.undo.clear()`);
  await t.mouse('mousePressed', dRow.x, dRow.y, 'left');
  await t.mouse('mouseMoved', dRow.x + 6, dRow.y + 6, 'left');
  await t.mouse('mouseMoved', aRow2.x, aRow2.y, 'left');
  await t.mouse('mouseMoved', aRow2.x, aRow2.y, 'left');
  await t.mouse('mouseReleased', aRow2.x, aRow2.y, 'left');
  await t.sleep(150);
  t.check('drag D onto A sets D.parentId === A.id',
    (await t.evaluate(`window.__app.scene.get(${ids.d}).parentId`)) === ids.a);

  // One Ctrl+Z clears it.
  await t.key('z', 'KeyZ', 2);
  await t.sleep(120);
  t.check('one Ctrl+Z clears D\'s parent',
    (await t.evaluate(`window.__app.scene.get(${ids.d}).parentId`)) === null);

  // --- Drop C onto a collection header clears C's parent ---
  await t.evaluate(`(() => {
    const s = window.__app.scene;
    window.__app.undo.clear();
    s.addCollection('Coll');
  })()`);
  await t.sleep(150);
  t.check('setup: C still parented to B before header drop',
    (await t.evaluate(`window.__app.scene.get(${ids.c}).parentId`)) === ids.b);

  const cRow2 = await rowCenter(ids.c);
  const header = await t.evaluate(`(() => {
    const el = document.querySelector('.outliner-collection-header');
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  await t.mouse('mousePressed', cRow2.x, cRow2.y, 'left');
  await t.mouse('mouseMoved', cRow2.x + 6, cRow2.y - 6, 'left');
  await t.mouse('mouseMoved', header.x, header.y, 'left');
  await t.mouse('mouseMoved', header.x, header.y, 'left');
  await t.mouse('mouseReleased', header.x, header.y, 'left');
  await t.sleep(150);
  t.check('dropping C onto a collection header clears its parent',
    (await t.evaluate(`window.__app.scene.get(${ids.c}).parentId`)) === null);

  // --- Existing row controls still work on a child row (B, still under A) ---
  t.check('setup: B still child of A',
    (await t.evaluate(`window.__app.scene.get(${ids.b}).parentId`)) === ids.a);

  // Eye toggle on B's row.
  const before = await t.evaluate(`window.__app.scene.get(${ids.b}).visible`);
  await t.evaluate(`document.querySelector('.outliner-row[data-obj-id="${ids.b}"] .outliner-eye').click()`);
  await t.sleep(100);
  t.check('eye toggle flips a child row\'s visibility',
    (await t.evaluate(`window.__app.scene.get(${ids.b}).visible`)) === !before);
  await t.evaluate(`document.querySelector('.outliner-row[data-obj-id="${ids.b}"] .outliner-eye').click()`);
  await t.sleep(100);

  // Rename via double-click on B's name.
  await t.evaluate(`(() => {
    const nm = document.querySelector('.outliner-row[data-obj-id="${ids.b}"] .outliner-name');
    nm.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  })()`);
  await t.sleep(100);
  await t.evaluate(`(() => {
    const inp = document.querySelector('.outliner-row[data-obj-id="${ids.b}"] .outliner-name-input');
    inp.value = 'ObjBRenamed';
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  await t.sleep(120);
  t.check('rename works on a child row',
    (await t.evaluate(`window.__app.scene.get(${ids.b}).name`)) === 'ObjBRenamed');

  // Re-parent C back under B so B is both a child row (of A) AND a parent (of
  // C): deleting it exercises the child-row delete button and the "deleting a
  // parent keeps its children" reparent (core moves C up to A).
  await t.evaluate(`window.__app.scene.setParentKeepTransform(
    window.__app.scene.get(${ids.c}), window.__app.scene.get(${ids.b}))`);
  await t.sleep(120);
  await t.evaluate(`document.querySelector('.outliner-row[data-obj-id="${ids.b}"] .outliner-del').click()`);
  await t.sleep(120);
  t.check('delete button on a child row removes object B',
    (await t.evaluate(`window.__app.scene.get(${ids.b}) == null`)) === true);
  t.check('deleting parent B keeps its child C in the list',
    (await t.evaluate(`document.querySelector('.outliner-row[data-obj-id="${ids.c}"]') != null`)) === true);
  t.check('core reparents C up to A after B is deleted',
    (await t.evaluate(`window.__app.scene.get(${ids.c}).parentId`)) === ids.a);
});
