/**
 * P9-1 e2e — Solidify modifier + Merge by Distance menu path.
 *
 * Part A: builds a plane via __app, adds Solidify through the Modifiers tab UI,
 * asserts the evaluated mesh gains verts (two shells + rim) and that undo
 * removes the modifier.
 * Part B: builds a mesh with doubled seam verts, enters edit mode, selects all
 * verts, opens the X delete menu, clicks "Merge by Distance", and asserts the
 * doubles collapse (8 → 6) with Blender's "Removed N vertices" status; undo
 * restores them.
 *
 * Run with the dev server up (under flock):
 *   flock /tmp/vibe-blender-e2e.lock node e2e/p9-solidify.mjs
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  // evaluate() doesn't await promises; this variant does (for dynamic imports).
  const evalAsync = async (expr) => {
    const { result, exceptionDetails } = await t.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    });
    if (exceptionDetails) throw new Error(`page threw: ${exceptionDetails.text}`);
    return result.value;
  };

  await t.evaluate(`document.querySelector('.wsp-tab[data-workspace="Layout"]')?.click()`);
  await t.sleep(150);

  // ----- Part A: Solidify via the Modifiers tab UI ---------------------------
  const built = await evalAsync(`(async () => {
    const S = window.__app.scene;
    if (S.editMode) S.exitEditMode();
    while (S.objects.length) S.remove(S.objects[0].id); // blank scene
    const prim = await import('/src/core/mesh/primitives.ts');
    const plane = S.add('Icing', prim.makePlane(2));
    S.selectOnly(plane.id);
    return { id: plane.id, baseVerts: plane.mesh.verts.size };
  })()`);
  await t.sleep(140);
  const planeId = built.id;
  t.check('plane base has 4 verts', built.baseVerts === 4);

  t.check('Modifiers tab button exists',
    await t.until(`!!document.querySelector('.properties-tab-btn[data-tab="modifier"]')`, 5000));
  await t.evaluate(`document.querySelector('.properties-tab-btn[data-tab="modifier"]').click()`);
  await t.sleep(140);

  t.check('Solidify is offered in the Add Modifier dropdown',
    await t.evaluate(`(() => {
      const sel = document.querySelector('.modifier-add-select');
      return !!sel && [...sel.options].some((o) => o.value === 'solidify');
    })()`));

  await t.evaluate(`(() => {
    const sel = document.querySelector('.modifier-add-select');
    sel.value = 'solidify';
    sel.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(160);
  t.check('Solidify added to the stack',
    (await t.evaluate(`window.__app.scene.get(${planeId}).modifiers.length`)) === 1 &&
    (await t.evaluate(`window.__app.scene.get(${planeId}).modifiers[0].type`)) === 'solidify');

  const evalVerts = () => t.evaluate(`window.__app.scene.get(${planeId}).evaluatedMesh().verts.size`);
  const evalFaces = () => t.evaluate(`window.__app.scene.get(${planeId}).evaluatedMesh().faces.size`);
  t.check('solidify thickens the plane: 4 base verts → 8 evaluated verts',
    (await evalVerts()) === 8, `evalVerts=${await evalVerts()}`);
  t.check('evaluated mesh gained rim faces (1 → 6: 2 shells + 4 rim)',
    (await evalFaces()) === 6, `evalFaces=${await evalFaces()}`);

  // Undo removes the modifier → evaluated mesh falls back to the 4-vert base.
  await t.key('z', 'KeyZ', 2); // ctrl+z
  await t.sleep(140);
  t.check('Ctrl+Z removes the Solidify modifier',
    (await t.evaluate(`window.__app.scene.get(${planeId}).modifiers.length`)) === 0);
  t.check('evaluated mesh is back to the 4-vert base',
    (await evalVerts()) === 4, `evalVerts=${await evalVerts()}`);

  // ----- Part B: Merge by Distance menu path ---------------------------------
  const dbl = await evalAsync(`(async () => {
    const S = window.__app.scene;
    if (S.editMode) S.exitEditMode();
    while (S.objects.length) S.remove(S.objects[0].id);
    const EM = (await import('/src/core/mesh/EditableMesh.ts')).EditableMesh;
    // Two quads whose shared seam verts are duplicated (verts 1≡4, 2≡7).
    const mesh = EM.fromData(
      [[0,0,0],[1,0,0],[1,0,1],[0,0,1],[1,0,0],[2,0,0],[2,0,1],[1,0,1]],
      [[0,1,2,3],[4,5,6,7]],
    );
    const obj = S.add('Doubles', mesh);
    S.selectOnly(obj.id);
    return { id: obj.id, verts: obj.mesh.verts.size };
  })()`);
  await t.sleep(140);
  t.check('doubled mesh starts with 8 verts', dbl.verts === 8);

  // Enter edit mode and select every vert.
  await t.key('Tab', 'Tab');
  await t.sleep(120);
  t.check('entered edit mode on the doubled mesh',
    (await t.evaluate('window.__app.scene.editMode ? window.__app.scene.editMode.elementMode : null')) === 'vert');
  await t.evaluate(`(() => {
    const e = window.__app.scene.editMode;
    const m = window.__app.scene.editObject.mesh;
    for (const id of m.verts.keys()) e.verts.add(id);
    e.touch();
  })()`);
  t.check('all 8 verts selected', (await t.evaluate('window.__app.scene.editMode.verts.size')) === 8);

  // X opens the delete menu; it offers Merge by Distance.
  await t.key('x', 'KeyX');
  await t.sleep(80);
  t.check('X opens the delete menu', await t.evaluate(`!!document.querySelector('.add-menu')`));
  t.check('menu offers a "Merge by Distance" item',
    await t.evaluate(`[...document.querySelectorAll('.add-menu-item')].some((b) => b.textContent === 'Merge by Distance')`));

  await t.evaluate(`(() => {
    [...document.querySelectorAll('.add-menu-item')].find((b) => b.textContent === 'Merge by Distance').click();
  })()`);
  await t.sleep(100);
  t.check('Merge by Distance collapses the 2 doubles (8 → 6 verts)',
    (await t.evaluate('window.__app.scene.editObject.mesh.verts.size')) === 6);
  t.check('status reads Blender-style "Removed 2 vertices"',
    (await t.evaluate(`document.getElementById('status').textContent`)) === 'Removed 2 vertices');
  t.check('delete menu closed after choosing',
    await t.evaluate(`!document.querySelector('.add-menu')`));

  // Undo restores the doubled verts.
  await t.key('z', 'KeyZ', 2); // ctrl+z
  await t.sleep(140);
  t.check('Ctrl+Z restores the 8 verts',
    (await t.evaluate('window.__app.scene.editObject.mesh.verts.size')) === 8);

  await t.screenshot('/tmp/p9-1-solidify.png');
});
