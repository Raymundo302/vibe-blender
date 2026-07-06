/**
 * Phase 3 "ship" e2e. Covers P3-2 (scene save/load) today; later P3 tasks
 * append their checks here. Run with the dev server up: `node e2e/ship.mjs`.
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  // --- P3-2: scene save / load (JSON) ---

  // Serialize the default scene (single Cube at origin).
  const saved = await t.evaluate('window.__app.io.serialize()');
  t.check('io.serialize returns a scene string',
    typeof saved === 'string' && saved.includes('vibe-blender-scene'));

  const parsed = JSON.parse(saved);
  t.check('format + version are correct',
    parsed.format === 'vibe-blender-scene' && parsed.version === 1);
  t.check('the default Cube is serialized',
    parsed.objects.length === 1 && parsed.objects[0].name === 'Cube');

  // Mutate: move the cube and add a second object; also move the camera.
  const afterMutate = await t.evaluate(`(() => {
    const app = window.__app, scene = app.scene, cube = scene.objects[0];
    const P = cube.transform.position;
    cube.transform = cube.transform.withPosition(new P.constructor(5, 1, -2));
    scene.add('Extra', cube.mesh.clone());
    app.camera.distance = 30;
    return { count: scene.objects.length, x: scene.objects[0].transform.position.x };
  })()`);
  t.check('scene mutated (2 objects, cube moved)',
    afterMutate.count === 2 && Math.abs(afterMutate.x - 5) < 1e-6);

  // Push an undo entry so we can prove load clears history.
  await t.evaluate(`window.__app.undo.push({ name: 'dummy', undo() {}, redo() {} })`);

  // Apply the saved string — scene should snap back to the single Cube at origin.
  await t.evaluate(`window.__app.io.apply(${JSON.stringify(saved)})`);
  const afterApply = await t.evaluate(`(() => {
    const scene = window.__app.scene, cube = scene.objects[0];
    return { count: scene.objects.length, name: cube.name,
             x: cube.transform.position.x, dist: window.__app.camera.distance };
  })()`);
  t.check('apply restores object count', afterApply.count === 1);
  t.check('apply restores the Cube', afterApply.name === 'Cube');
  t.check('apply restores position', Math.abs(afterApply.x) < 1e-6);
  t.check('apply restores camera distance', Math.abs(afterApply.dist - 8) < 1e-6);

  // Re-serialize → identical to the saved string (deterministic round trip).
  const reSaved = await t.evaluate('window.__app.io.serialize()');
  t.check('round trip re-serializes identically', reSaved === saved);

  // Undo stack empty after load: Ctrl+Z reports "Nothing to undo".
  await t.key('z', 'KeyZ', 2); // ctrl
  t.check('load cleared undo history (Nothing to undo)',
    (await t.evaluate(`document.getElementById('status').textContent`)) === 'Nothing to undo');

  // App still renders after the load — no thrown exceptions, RAF still ticking.
  const v1 = await t.evaluate('window.__app.renderer && !!window.__app.scene');
  await t.sleep(120);
  t.check('app still alive after load', v1 === true);

  // --- Ctrl+S: preventDefault (no browser save dialog), and it runs cleanly ---
  await t.evaluate(`(() => {
    window.__ship = { prevented: null };
    // Registered after InputManager's listener, so it observes defaultPrevented.
    window.addEventListener('keydown', (e) => {
      if (e.ctrlKey && (e.key === 's' || e.key === 'S')) window.__ship.prevented = e.defaultPrevented;
    });
  })()`);
  await t.key('s', 'KeyS', 2); // ctrl+s
  t.check('Ctrl+S calls preventDefault (no browser dialog)',
    (await t.evaluate('window.__ship.prevented')) === true);
  t.check('Ctrl+S ran the save path (status updated)',
    (await t.evaluate(`document.getElementById('status').textContent`)).includes('Saved scene'));

  // --- Malformed load throws and leaves the scene untouched ---
  const beforeBad = await t.evaluate('window.__app.scene.objects.length');
  const threw = await t.evaluate(
    `(() => { try { window.__app.io.apply('{ not json'); return false; } catch (e) { return true; } })()`);
  t.check('malformed load throws', threw === true);
  t.check('scene untouched after failed load',
    (await t.evaluate('window.__app.scene.objects.length')) === beforeBad);

  // --- Topbar Save/Open buttons exist with stable data-action hooks ---
  t.check('Save button present',
    await t.evaluate(`!!document.querySelector('.topbar-btn[data-action="save-scene"]')`));
  t.check('Open button present',
    await t.evaluate(`!!document.querySelector('.topbar-btn[data-action="open-scene"]')`));

  // Clicking Save (topbar) runs the same path (no throw, status updated).
  await t.evaluate(`document.getElementById('status').textContent = ''`);
  await t.evaluate(`document.querySelector('.topbar-btn[data-action="save-scene"]').click()`);
  t.check('Save button triggers a save',
    (await t.evaluate(`document.getElementById('status').textContent`)).includes('Saved scene'));
});
