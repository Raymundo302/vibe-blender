/**
 * P10-1 e2e — Collections in the outliner. Creates a collection via the outliner
 * "New Collection" button, drives the object-mode M popup to move 2 selected
 * objects into it, checks they nest under the header, toggles the collection eye
 * off (members drop out of effectiveVisible), walks a Ctrl+Z chain back to the
 * pristine state, then deletes a collection and proves its members return to the
 * scene root. Run with the dev server up:
 *   flock /tmp/vibe-blender-e2e.lock node e2e/p10-collections.mjs
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

  // Reset to exactly two root cubes, both selected.
  await t.evaluate(`(() => {
    const s = window.__app.scene;
    if (s.editMode) s.exitEditMode();
    window.__app.undo.clear();
    for (const c of [...s.collections]) s.removeCollection(c.id);
    while (s.objects.length > 1) s.remove(s.objects[s.objects.length - 1].id);
    const a = s.objects[0]; a.name = 'CubeA';
    const b = s.duplicate(a, 'CubeB');
    s.selection.clear(); s.selection.add(a.id); s.selection.add(b.id);
    s.activeId = b.id;
  })()`);
  await t.sleep(120);

  const ids = await t.evaluate(`window.__app.scene.objects.map((o) => o.id)`);

  // --- Create a collection via the outliner button ---
  await t.evaluate(`document.querySelector('.outliner-newcol').click()`);
  await t.sleep(120);
  t.check('New Collection button created one collection',
    (await t.evaluate('window.__app.scene.collections.length')) === 1);
  t.check('outliner shows a collection header',
    (await t.evaluate(`document.querySelectorAll('.outliner-collection-header').length`)) === 1);
  const colName = await t.evaluate('window.__app.scene.collections[0].name');
  const colId = await t.evaluate('window.__app.scene.collections[0].id');

  // --- M popup moves the two selected objects into the collection ---
  await t.mouse('mouseMoved', rect.x, rect.y); // seed the pointer inside the viewport
  await t.key('m', 'KeyM', 0);
  await t.sleep(120);
  t.check('M opens the Move-to-Collection popup',
    (await t.evaluate(`!!document.querySelector('.col-menu')`)) === true);

  // Click the collection's own item in the popup.
  await t.evaluate(`(() => {
    const item = [...document.querySelectorAll('.col-menu-item')]
      .find((b) => b.textContent === ${JSON.stringify(colName)});
    item.click();
  })()`);
  await t.sleep(120);

  t.check('both objects now belong to the collection',
    (await t.evaluate(`window.__app.scene.objects.filter((o) => o.collectionId === ${colId}).length`)) === 2);
  t.check('popup closed after choosing',
    (await t.evaluate(`!!document.querySelector('.col-menu')`)) === false);

  // --- Outliner nests them under the header ---
  await t.sleep(80);
  t.check('two member rows nested (indented) under the collection',
    (await t.evaluate(`document.querySelectorAll('.outliner-row.outliner-indent').length`)) === 2);

  // --- Collection eye off → members drop out of effectiveVisible ---
  await t.evaluate(`document.querySelector('.outliner-collection-header .outliner-eye').click()`);
  await t.sleep(100);
  t.check('collection eye off hides members from effectiveVisible',
    (await t.evaluate(`(() => {
      const s = window.__app.scene;
      return s.objects.filter((o) => o.collectionId === ${colId})
        .every((o) => s.effectiveVisible(o) === false);
    })()`)) === true);

  // --- Ctrl+Z chain: visibility → move → create, back to pristine ---
  await t.key('z', 'KeyZ', 2); // undo visibility
  await t.sleep(80);
  t.check('undo restores collection visibility',
    (await t.evaluate(`window.__app.scene.collections[0].visible`)) === true &&
    (await t.evaluate(`(() => { const s = window.__app.scene;
      return s.objects.filter((o) => o.collectionId === ${colId}).every((o) => s.effectiveVisible(o)); })()`)) === true);

  await t.key('z', 'KeyZ', 2); // undo move
  await t.sleep(80);
  t.check('undo returns both objects to the scene root',
    (await t.evaluate(`window.__app.scene.objects.filter((o) => o.collectionId === null).length`)) === 2);

  await t.key('z', 'KeyZ', 2); // undo create
  await t.sleep(80);
  t.check('undo removes the collection entirely',
    (await t.evaluate('window.__app.scene.collections.length')) === 0);

  // --- Delete a collection returns its rows to the scene root ---
  await t.evaluate(`(() => {
    const s = window.__app.scene, u = window.__app.undo;
    u.clear();
    const col = s.addCollection('Trash');
    for (const id of ${JSON.stringify(ids)}) { const o = s.get(id); if (o) o.collectionId = col.id; }
  })()`);
  await t.sleep(120);
  t.check('setup: members live in the collection before delete',
    (await t.evaluate(`window.__app.scene.objects.filter((o) => o.collectionId !== null).length`)) === 2);

  await t.evaluate(`document.querySelector('.outliner-collection-header .outliner-del').click()`);
  await t.sleep(120);
  t.check('deleting the collection drops members to the root',
    (await t.evaluate(`window.__app.scene.collections.length`)) === 0 &&
    (await t.evaluate(`window.__app.scene.objects.filter((o) => o.collectionId === null).length`)) === 2);
  t.check('deleted collection rows render at the root (no indent)',
    (await t.evaluate(`document.querySelectorAll('.outliner-row.outliner-indent').length`)) === 0);

  // Undo the delete restores membership.
  await t.key('z', 'KeyZ', 2);
  await t.sleep(80);
  t.check('undo of delete restores the collection and its members',
    (await t.evaluate(`window.__app.scene.collections.length`)) === 1 &&
    (await t.evaluate(`window.__app.scene.objects.filter((o) => o.collectionId !== null).length`)) === 2);
});
