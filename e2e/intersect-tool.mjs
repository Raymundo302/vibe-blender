/**
 * Intersect tool (UR3-2): with 2+ mesh objects selected in object mode, the tool
 * embeds their mesh–mesh crossings as REAL geometry on every selected mesh, in
 * one undo step. Pure-geometry op is unit-tested (embedIntersections.test.ts);
 * this suite proves the end-to-end wiring against the LIVE app scene/undo.
 *
 * Scene: the canonical plane-through-cube. A unit cube (±1) and a 4-wide plane
 * at z=0 both selected → the plane cuts the cube's 4 vertical edges: cube verts
 * grow 8 → 12 (4 new), 4 side faces chord-split; the big plane face gains nothing
 * (interior-only crossing — documented v1 limit). Undo restores the cube exactly.
 *
 * The tool exposes itself on `window.__intersectTool` at module load (an e2e
 * handle like `window.__timeline`); we import the module to trigger that, then
 * drive it with the app's own scene + undo (UR3-1 will wire the toolbar button).
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  await t.key('Escape', 'Escape', 0); // dismiss splash
  t.check('app booted', await t.until('!!window.__app'));

  // --- Build the plane-through-cube scene + expose the tool. -----------------
  await t.evaluate(`(async () => {
    const S = window.__app.scene;
    if (S.editMode) S.exitEditMode();
    for (const o of [...S.objects]) S.remove(o.id);
    const prim = await import('/src/core/mesh/primitives.ts');
    const cube = S.add('Cube', prim.makeCube(1));   // ±1, 8 verts / 6 faces
    const plane = S.add('Plane', prim.makePlane(4)); // 4-wide quad at z=0
    S.deselectAll();
    S.selection.add(cube.id);
    S.selection.add(plane.id);
    S.activeId = cube.id;
    // Import the tool module → sets window.__intersectTool.
    await import('/src/tools/intersectTool.ts');
    window.__intersectStatus = '';
  })()`);

  t.check('scene: cube + plane, both selected, object mode', await t.until(`(() => {
    const S = window.__app.scene;
    const cube = S.objects.find(o => o.name === 'Cube');
    const plane = S.objects.find(o => o.name === 'Plane');
    return !!cube && !!plane && !S.editMode
      && S.selection.has(cube.id) && S.selection.has(plane.id);
  })()`));
  t.check('tool handle exposed', await t.until('typeof window.__intersectTool === "function"'));

  const cubeVerts = () => t.evaluate(
    `window.__app.scene.objects.find(o => o.name === 'Cube').mesh.verts.size`);
  const cubeFaces = () => t.evaluate(
    `window.__app.scene.objects.find(o => o.name === 'Cube').mesh.faces.size`);
  const planeVerts = () => t.evaluate(
    `window.__app.scene.objects.find(o => o.name === 'Plane').mesh.verts.size`);

  t.check('cube starts with 8 verts', (await cubeVerts()) === 8, `got ${await cubeVerts()}`);
  t.check('cube starts with 6 faces', (await cubeFaces()) === 6, `got ${await cubeFaces()}`);
  const pushesBefore = await t.evaluate('window.__app.undo.pushCount');

  // --- Run the tool. --------------------------------------------------------
  await t.evaluate(`(() => {
    const app = window.__app;
    window.__intersectTool(app.scene, app.undo, (s) => { window.__intersectStatus = s; });
  })()`);

  const grew = await cubeVerts();
  t.check('cube grew by 4 verts (8 → 12)', grew === 12, `got ${grew}`);
  const faces = await cubeFaces();
  t.check('cube gained 4 side-face splits (6 → 10)', faces === 10, `got ${faces}`);
  t.check('plane unchanged (interior-only crossing)', (await planeVerts()) === 4);
  const status = await t.evaluate('window.__intersectStatus');
  t.check('status reports the counts', /Intersect: 4 verts, 4 face splits across 2 objects/.test(status), status);
  t.check('one undo entry pushed',
    (await t.evaluate('window.__app.undo.pushCount')) === pushesBefore + 1);

  // --- Undo restores the cube exactly. --------------------------------------
  await t.evaluate('window.__app.undo.undo()');
  const restored = await cubeVerts();
  t.check('undo restores cube to 8 verts', restored === 8, `got ${restored}`);
  t.check('undo restores cube to 6 faces', (await cubeFaces()) === 6);

  // --- Redo re-applies. -----------------------------------------------------
  await t.evaluate('window.__app.undo.redo()');
  t.check('redo re-applies (12 verts)', (await cubeVerts()) === 12);
});
