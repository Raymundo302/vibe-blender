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

  // --- P3-1: OBJ export / import ---

  // Reload a clean single-Cube scene so the following checks start from a known state.
  await t.evaluate(`window.__app.io.apply(${JSON.stringify(saved)})`);

  const objText = await t.evaluate('window.__app.io.exportObj()');
  t.check('io.exportObj returns a string with "o Cube"',
    typeof objText === 'string' && objText.includes('o Cube') && objText.startsWith('# Vibe Blender'));
  t.check('exportObj emits 8 v lines for the cube',
    objText.split('\n').filter((l) => l.startsWith('v ')).length === 8);

  // Export/Import buttons exist with stable data-action hooks.
  t.check('Export OBJ button present',
    await t.evaluate(`!!document.querySelector('.topbar-btn[data-action="export-obj"]')`));
  t.check('Import OBJ button present',
    await t.evaluate(`!!document.querySelector('.topbar-btn[data-action="import-obj"]')`));

  // Import a small OBJ string through the same code path the file input uses.
  const beforeImport = await t.evaluate('window.__app.scene.objects.length');
  const imported = await t.evaluate(`(() => {
    window.__app.io.importObj('o Tri\\nv 0 0 0\\nv 1 0 0\\nv 0 1 0\\nf 1 2 3\\n');
    const scene = window.__app.scene, obj = scene.objects.at(-1);
    return { count: scene.objects.length, name: obj.name,
             selected: scene.selection.has(obj.id), active: scene.activeId === obj.id };
  })()`);
  t.check('import added one object', imported.count === beforeImport + 1);
  t.check('imported object named from o line', imported.name === 'Tri');
  t.check('imported object is selected + active', imported.selected && imported.active);

  // Ctrl+Z removes the import; Ctrl+Shift+Z restores it.
  await t.key('z', 'KeyZ', 2); // ctrl
  t.check('Ctrl+Z removes the imported object',
    (await t.evaluate('window.__app.scene.objects.length')) === beforeImport);
  await t.key('z', 'KeyZ', 2 | 8); // ctrl+shift
  const afterRedo = await t.evaluate(`(() => {
    const scene = window.__app.scene, obj = scene.objects.at(-1);
    return { count: scene.objects.length, name: obj.name, selected: scene.selection.has(obj.id) };
  })()`);
  t.check('Ctrl+Shift+Z restores the imported object',
    afterRedo.count === beforeImport + 1 && afterRedo.name === 'Tri' && afterRedo.selected);

  // Malformed OBJ import throws and leaves the scene untouched.
  const beforeBadObj = await t.evaluate('window.__app.scene.objects.length');
  const threwObj = await t.evaluate(
    `(() => { try { window.__app.io.importObj('garbage not an obj'); return false; } catch (e) { return true; } })()`);
  t.check('malformed OBJ import throws', threwObj === true);
  t.check('scene untouched after failed OBJ import',
    (await t.evaluate('window.__app.scene.objects.length')) === beforeBadObj);

  // --- P3-3: shading modes (matcap / wireframe / studio) ---

  // Reload a clean single-Cube scene and reset shading so this section is deterministic.
  await t.evaluate(`window.__app.io.apply(${JSON.stringify(saved)})`);
  await t.evaluate(`window.__app.renderer.shadingMode = 'matcap'`);
  await t.sleep(60);

  const shadingChipText = () =>
    t.evaluate(`document.querySelector('.topbar-btn[data-action="shading-mode"]').textContent`);

  t.check('starts in matcap',
    (await t.evaluate('window.__app.renderer.shadingMode')) === 'matcap');
  t.check('shading chip present + labeled Matcap',
    (await shadingChipText()) === 'Matcap');

  // Capture a matcap screenshot for human review.
  const matcapPng = await t.screenshot('/tmp/p3-3-matcap.png');

  // Z → wireframe.
  await t.key('z', 'KeyZ', 0);
  t.check('Z cycles matcap → wireframe',
    (await t.evaluate('window.__app.renderer.shadingMode')) === 'wireframe');
  t.check('chip follows to Wireframe', (await shadingChipText()) === 'Wireframe');
  await t.sleep(60);
  const wirePng = await t.screenshot('/tmp/p3-3-wireframe.png');

  // Z → studio.
  await t.key('z', 'KeyZ', 0);
  t.check('Z cycles wireframe → studio',
    (await t.evaluate('window.__app.renderer.shadingMode')) === 'studio');
  t.check('chip follows to Studio', (await shadingChipText()) === 'Studio');
  await t.sleep(60);
  const studioPng = await t.screenshot('/tmp/p3-3-studio.png');

  // Z → back to matcap (full cycle).
  await t.key('z', 'KeyZ', 0);
  t.check('Z cycles studio → matcap (wraps)',
    (await t.evaluate('window.__app.renderer.shadingMode')) === 'matcap');

  // Clicking the chip cycles too.
  await t.evaluate(`document.querySelector('.topbar-btn[data-action="shading-mode"]').click()`);
  await t.sleep(60);
  t.check('clicking the chip cycles to wireframe',
    (await t.evaluate('window.__app.renderer.shadingMode')) === 'wireframe');

  // The three renders must actually differ — compare saved PNG byte lengths as a
  // cheap proxy (all three are also saved to /tmp for human review).
  const { statSync } = await import('node:fs');
  const sz = (p) => statSync(p).size;
  const mSz = sz(matcapPng), wSz = sz(wirePng), sSz = sz(studioPng);
  t.check('matcap / wireframe / studio renders differ',
    mSz !== wSz && wSz !== sSz && mSz !== sSz, `${mSz} / ${wSz} / ${sSz}`);

  // --- Edit mode still fully works while in wireframe shading ---
  await t.evaluate(`window.__app.renderer.shadingMode = 'wireframe'`);
  await t.sleep(60);
  // Tab into edit mode on the active Cube.
  await t.key('Tab', 'Tab', 0);
  t.check('Tab enters edit mode under wireframe shading',
    (await t.evaluate('!!window.__app.scene.editMode')) === true);
  // A: select all verts.
  await t.key('a', 'KeyA', 0);
  const selCount = await t.evaluate(
    'window.__app.scene.editMode.selectedVertIds(window.__app.scene.editObject.mesh).size');
  t.check('A selects all verts in wireframe edit mode', selCount === 8);
  // G then confirm — a modal move must run without throwing.
  await t.key('g', 'KeyG', 0);
  await t.mouse('mouseMoved', 700, 380);
  await t.mouse('mouseMoved', 740, 400);
  await t.click(740, 400); // click confirms the modal move
  t.check('G move confirms in wireframe edit mode (still editing, still alive)',
    (await t.evaluate('!!window.__app.scene.editMode && !!window.__app.renderer')) === true);
  // Tab back to object mode and restore matcap so the suite ends clean.
  await t.key('Tab', 'Tab', 0);
  await t.evaluate(`window.__app.renderer.shadingMode = 'matcap'`);

  // --- P3-4: first-visit splash + shortcut overlay ---

  // Force a clean first-visit state, then reload so the splash renders fresh.
  // (The shared e2e profile persists localStorage, so we clear it explicitly.)
  await t.evaluate(`localStorage.removeItem('vibe-blender-splash-seen')`);
  await t.send('Page.reload', {});
  await t.until('!!window.__app');
  await t.sleep(150);
  t.check('splash visible on fresh load',
    await t.evaluate(`!!document.querySelector('.splash')`));
  t.check('splash-seen flag not set before dismiss',
    (await t.evaluate(`localStorage.getItem('vibe-blender-splash-seen')`)) === null);

  // Pressing a key dismisses the splash and records it in localStorage. Escape is
  // a no-op key in object mode (no active op), so nothing else changes.
  await t.key('Escape', 'Escape', 0);
  await t.sleep(80);
  t.check('a key press dismisses the splash',
    await t.evaluate(`!document.querySelector('.splash')`));
  t.check('dismiss sets the localStorage flag',
    (await t.evaluate(`localStorage.getItem('vibe-blender-splash-seen')`)) === '1');

  // Reload — the remembered flag keeps the splash from reappearing.
  await t.send('Page.reload', {});
  await t.until('!!window.__app');
  await t.sleep(150);
  t.check('splash stays dismissed after reload',
    await t.evaluate(`!document.querySelector('.splash')`));

  // F1 opens the shortcut overlay.
  await t.key('F1', 'F1', 0);
  await t.sleep(80);
  t.check('F1 opens the shortcut overlay',
    await t.evaluate(`!!document.querySelector('.help-overlay')`));

  // Spot-check that representative shortcuts are listed.
  const overlayText = await t.evaluate(`document.querySelector('.help-overlay').textContent`);
  t.check('overlay lists Ctrl+R', overlayText.includes('Ctrl+R'));
  t.check('overlay lists Tab', overlayText.includes('Tab'));
  t.check('overlay lists F1', overlayText.includes('F1'));

  // While the overlay is open, keyboard must not leak: G does NOT start a move.
  const cubeX = () => t.evaluate('window.__app.scene.objects[0].transform.position.x');
  const beforeG = await cubeX();
  await t.key('g', 'KeyG', 0);
  await t.mouse('mouseMoved', 760, 380);
  await t.sleep(80);
  t.check('overlay still open after G', await t.evaluate(`!!document.querySelector('.help-overlay')`));
  t.check('G does not start a move while overlay open', (await cubeX()) === beforeG);

  // Escape closes the overlay (and, per the guard, closes it before anything else).
  await t.key('Escape', 'Escape', 0);
  await t.sleep(80);
  t.check('Escape closes the overlay',
    await t.evaluate(`!document.querySelector('.help-overlay')`));

  // The topbar "?" button toggles the same overlay.
  t.check('help ("?") button present',
    await t.evaluate(`!!document.querySelector('.topbar-btn[data-action="help"]')`));
  await t.evaluate(`document.querySelector('.topbar-btn[data-action="help"]').click()`);
  await t.sleep(60);
  t.check('"?" button opens the overlay',
    await t.evaluate(`!!document.querySelector('.help-overlay')`));
  await t.key('F1', 'F1', 0);
  await t.sleep(60);
  t.check('F1 toggles the overlay closed again',
    await t.evaluate(`!document.querySelector('.help-overlay')`));

  // --- P4-3: tabbed Properties editor (vertical tab strip + Object tab) ---

  // Force the Layout workspace (outliner + properties both visible) and a clean
  // single-Cube scene with that Cube selected/active.
  await t.evaluate(`document.querySelector('.wsp-tab[data-workspace="Layout"]')?.click()`);
  await t.sleep(150);
  await t.evaluate(`window.__app.io.apply(${JSON.stringify(saved)})`);
  await t.evaluate(`window.__app.scene.selectOnly(window.__app.scene.objects[0].id)`);
  await t.sleep(120);

  // Tab strip renders with the Object tab, active by default, tooltip 'Object'.
  t.check('properties tab strip renders the Object tab button',
    await t.evaluate(`!!document.querySelector('.properties-tabstrip .properties-tab-btn[data-tab="object"]')`));
  t.check('Object tab is active by default',
    await t.evaluate(`document.querySelector('.properties-tab-btn[data-tab="object"]').classList.contains('properties-tab-active')`));
  t.check('Object tab tooltip reads "Object"',
    (await t.evaluate(`document.querySelector('.properties-tab-btn[data-tab="object"]').title`)) === 'Object');

  // Rename via the name input → updates the object, the outliner, and the topbar.
  await t.evaluate(`(() => {
    const inp = document.querySelector('.properties-name-input');
    inp.value = 'Renamed';
    inp.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(140);
  t.check('name input rename updates the active object',
    (await t.evaluate('window.__app.scene.activeObject.name')) === 'Renamed');
  t.check('rename reflected in the outliner',
    await t.evaluate(`[...document.querySelectorAll('.outliner-name')].some((n) => n.textContent === 'Renamed')`));
  t.check('rename reflected in the topbar status',
    (await t.evaluate(`document.querySelector('.topbar-status').textContent`)).includes('Renamed'));

  // Rename pushes RenameObjectCommand → Ctrl+Z reverts it.
  await t.key('z', 'KeyZ', 2); // ctrl+z
  await t.sleep(80);
  t.check('Ctrl+Z reverts the rename',
    (await t.evaluate('window.__app.scene.activeObject.name')) === 'Cube');

  // Visibility checkbox hides the object in the viewport (center pick → null).
  const pickCenter = () => t.evaluate(`(() => {
    const r = document.querySelector('canvas').getBoundingClientRect();
    return window.__app.renderer.pick(window.__app.scene, window.__app.camera, r.width / 2, r.height / 2);
  })()`);
  t.check('center pick hits something while the object is visible',
    (await pickCenter()) !== null);
  await t.evaluate(`(() => {
    const cb = document.querySelector('.properties-visible');
    cb.checked = false;
    cb.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(100);
  t.check('unchecking Visible hides the object', (await t.evaluate('window.__app.scene.activeObject.visible')) === false);
  t.check('hidden object: center pick returns null', (await pickCenter()) === null);
  // Restore visibility so the suite ends clean.
  await t.evaluate(`(() => {
    const cb = document.querySelector('.properties-visible');
    cb.checked = true;
    cb.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(80);
  t.check('re-checking Visible shows the object again',
    (await t.evaluate('window.__app.scene.activeObject.visible')) === true);

  // Transform edit still works and undoes: set Location X, then Ctrl+Z.
  const locX = () => t.evaluate('window.__app.scene.activeObject.transform.position.x');
  const beforeX = await locX();
  await t.evaluate(`(() => {
    const locGroup = document.querySelectorAll('.properties-group')[0];
    const xInput = locGroup.querySelectorAll('.properties-input')[0];
    xInput.value = '4';
    xInput.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(100);
  t.check('transform edit applies (Location X = 4)', Math.abs((await locX()) - 4) < 1e-6);
  await t.key('z', 'KeyZ', 2); // ctrl+z
  await t.sleep(80);
  t.check('Ctrl+Z undoes the transform edit', Math.abs((await locX()) - beforeX) < 1e-6);

  await t.screenshot('/tmp/p4-3-properties.png');
});
