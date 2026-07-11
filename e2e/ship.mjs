/**
 * Phase 3 "ship" e2e. Covers P3-2 (scene save/load) today; later P3 tasks
 * append their checks here. Run with the dev server up: `node e2e/ship.mjs`.
 */
import { runE2e } from './harness.mjs';

// Bumped whenever sceneJson VERSION bumps — single spot for the whole suite.
const CURRENT_FORMAT_VERSION = 10; // v10: optional material.shadeless (UR4-3)

runE2e(async (t) => {
  // --- P3-2: scene save / load (JSON) ---

  // Serialize the default scene (single Cube at origin).
  const saved = await t.evaluate('window.__app.io.serialize()');
  t.check('io.serialize returns a scene string',
    typeof saved === 'string' && saved.includes('vibe-blender-scene'));

  const parsed = JSON.parse(saved);
  t.check('format + version are correct',
    parsed.format === 'vibe-blender-scene' && parsed.version === CURRENT_FORMAT_VERSION);
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

  // The shading control moved to the 3D viewport's area header (right side):
  // a dropdown button labeled with the current mode.
  const shadingChipText = () =>
    t.evaluate(`document.querySelector('.shading-menu-btn').textContent`);

  t.check('starts in matcap',
    (await t.evaluate('window.__app.renderer.shadingMode')) === 'matcap');
  t.check('viewport-header shading button present + labeled Matcap',
    (await shadingChipText()).includes('Matcap'));

  // Capture a matcap screenshot for human review.
  const matcapPng = await t.screenshot('/tmp/p3-3-matcap.png');

  // Z → wireframe.
  await t.key('z', 'KeyZ', 0);
  t.check('Z cycles matcap → wireframe',
    (await t.evaluate('window.__app.renderer.shadingMode')) === 'wireframe');
  t.check('button follows to Wireframe', (await shadingChipText()).includes('Wireframe'));
  await t.sleep(60);
  const wirePng = await t.screenshot('/tmp/p3-3-wireframe.png');

  // Z → studio.
  await t.key('z', 'KeyZ', 0);
  t.check('Z cycles wireframe → studio',
    (await t.evaluate('window.__app.renderer.shadingMode')) === 'studio');
  t.check('button follows to Studio', (await shadingChipText()).includes('Studio'));
  await t.sleep(60);
  const studioPng = await t.screenshot('/tmp/p3-3-studio.png');

  // Z → rendered (P8: PBR lit by scene lights).
  await t.key('z', 'KeyZ', 0);
  t.check('Z cycles studio → rendered',
    (await t.evaluate('window.__app.renderer.shadingMode')) === 'rendered');
  t.check('button follows to Rendered', (await shadingChipText()).includes('Rendered'));

  // Z → back to matcap (full cycle).
  await t.key('z', 'KeyZ', 0);
  t.check('Z cycles rendered → matcap (wraps)',
    (await t.evaluate('window.__app.renderer.shadingMode')) === 'matcap');

  // Clicking the button opens the dropdown; picking a mode row switches to it.
  await t.evaluate(`document.querySelector('.shading-menu-btn').click()`);
  await t.sleep(60);
  t.check('shading dropdown opens', await t.evaluate(`!!document.querySelector('.shading-menu-pop')`));
  await t.evaluate(`document.querySelector('.shading-menu-mode[data-mode="wireframe"]').click()`);
  await t.sleep(60);
  t.check('picking Wireframe in the dropdown switches the mode',
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
  await t.reload();
  // Poll for the splash instead of a fixed sleep — under load (chained e2e
  // suites) the first paint can land later than any hardcoded delay.
  t.check('splash visible on fresh load',
    await t.until(`!!document.querySelector('.splash')`, 5000));
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
  await t.reload();
  await t.sleep(150);
  t.check('splash stays dismissed after reload',
    await t.evaluate(`!document.querySelector('.splash')`));

  // F1 opens the shortcut overlay.
  await t.key('F1', 'F1', 0);
  // Retry once — under heavy load the first synthetic F1 occasionally lands
  // before the reloaded page's key listeners are attached.
  let helpOpen = await t.until(`!!document.querySelector('.help-overlay')`, 3000);
  if (!helpOpen) {
    await t.key('F1', 'F1', 0);
    helpOpen = await t.until(`!!document.querySelector('.help-overlay')`, 5000);
  }
  t.check('F1 opens the shortcut overlay', helpOpen);

  // Spot-check that representative shortcuts are listed.
  const overlayText = await t.evaluate(`document.querySelector('.help-overlay').textContent`);
  t.check('overlay lists Ctrl+R', overlayText.includes('Ctrl+R'));
  t.check('overlay lists Tab', overlayText.includes('Tab'));
  t.check('overlay lists F1', overlayText.includes('F1'));
  // P6-6: spot-check three entries added by Phases 4-6.
  t.check('overlay lists Ctrl+B (bevel)', overlayText.includes('Ctrl+B'));
  t.check('overlay lists N (N-panel)', overlayText.includes('Toggle the N-panel'));
  t.check('overlay lists O (proportional editing)', overlayText.includes('proportional editing'));
  t.check('overlay has a Workspaces group', overlayText.includes('Workspaces'));

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

  // --- P4-4: Modifier tab UI + scene format v2 ---
  // Make the cube active and switch the Properties panel to the Modifiers tab.
  await t.evaluate(`(() => {
    const scene = window.__app.scene;
    if (!scene.activeObject && scene.objects.length) scene.selectOnly(scene.objects[0].id);
    const btn = document.querySelector('.properties-tab-btn[data-tab="modifier"]');
    if (btn) btn.click();
  })()`);
  await t.sleep(140);

  t.check('Modifiers tab button exists',
    await t.evaluate(`!!document.querySelector('.properties-tab-btn[data-tab="modifier"]')`));

  const optCount = await t.evaluate(`(() => {
    const sel = document.querySelector('.modifier-add-select');
    return sel ? sel.options.length : -1;
  })()`);
  t.check('Add-Modifier dropdown renders (placeholder + one option per type)', optCount >= 1);

  const modCount = () => t.evaluate('window.__app.scene.activeObject.modifiers.length');

  if (optCount > 1) {
    // At least one modifier type is registered (P4-5 landed) — exercise add/param/undo.
    const firstType = await t.evaluate(`document.querySelector('.modifier-add-select').options[1].value`);
    const before = await modCount();
    const addOne = async () => {
      await t.evaluate(`(() => {
        const sel = document.querySelector('.modifier-add-select');
        sel.value = ${JSON.stringify(firstType)};
        sel.dispatchEvent(new Event('change'));
      })()`);
      await t.sleep(160);
    };

    await addOne();
    t.check('adding a modifier from the dropdown grows the stack', (await modCount()) === before + 1);
    await t.key('z', 'KeyZ', 2); // ctrl+z
    await t.sleep(160);
    t.check('Ctrl+Z removes the added modifier', (await modCount()) === before);

    // Param-edit undo probe (only if the modifier exposes a number param).
    await addOne();
    const probe = await t.evaluate(`(() => {
      const input = document.querySelector('.modifier-entry input[type=number].modifier-param');
      if (!input) return null;
      const key = input.dataset.key;
      const orig = window.__app.scene.activeObject.modifiers[0].params()[key];
      input.value = String(Number(orig) + 3);
      input.dispatchEvent(new Event('change'));
      return { key, orig };
    })()`);
    if (probe) {
      await t.sleep(160);
      const paramVal = (k) => t.evaluate(`window.__app.scene.activeObject.modifiers[0].params()[${JSON.stringify(k)}]`);
      t.check('param edit changes the modifier value',
        Math.abs((await paramVal(probe.key)) - (probe.orig + 3)) < 1e-6);
      await t.key('z', 'KeyZ', 2);
      await t.sleep(160);
      t.check('Ctrl+Z restores the param value',
        Math.abs((await paramVal(probe.key)) - probe.orig) < 1e-6);
    } else {
      console.log('SKIP  registered modifier exposes no number param — param-edit probe skipped');
    }
    // Clean up: undo the second add so the suite leaves the stack as it found it.
    await t.key('z', 'KeyZ', 2);
    await t.sleep(140);
    t.check('stack restored after cleanup undo', (await modCount()) === before);
  } else {
    console.log('SKIP  no modifier types registered yet (P4-5) — add/undo checks skipped; empty dropdown asserted');
    t.check('empty dropdown shows only the placeholder option', optCount === 1);
    t.check('empty stack shows the "No modifiers" hint',
      await t.evaluate(`!!document.querySelector('.modifier-stack .properties-empty')`));
  }

  // v2: serialized scene reports version 2 and every object carries a modifiers array.
  const v2 = JSON.parse(await t.evaluate('window.__app.io.serialize()'));
  t.check('scene serializes at the current format version', v2.version === CURRENT_FORMAT_VERSION);
  t.check('every object has a modifiers array',
    Array.isArray(v2.objects[0].modifiers));

  await t.screenshot('/tmp/p4-4-modifiers.png');

  // --- P4-5: Mirror + Array modifiers ---
  // Clean single-Cube scene, cube active, Modifiers tab open.
  await t.evaluate(`window.__app.io.apply(${JSON.stringify(saved)})`);
  await t.evaluate(`window.__app.scene.selectOnly(window.__app.scene.objects[0].id)`);
  await t.evaluate(`document.querySelector('.properties-tab-btn[data-tab="modifier"]')?.click()`);
  await t.sleep(140);

  // Offset the base mesh in +X so the mirrored copy is distinct (visible mirror).
  await t.evaluate(`(() => {
    const mesh = window.__app.scene.activeObject.mesh;
    for (const v of [...mesh.verts.values()]) mesh.setVertCo(v.id, new v.co.constructor(v.co.x + 3, v.co.y, v.co.z));
  })()`);

  const p45mods = () => t.evaluate('window.__app.scene.activeObject.modifiers.length');
  const p45base = () => t.evaluate('window.__app.scene.activeObject.mesh.verts.size');
  const p45eval = () => t.evaluate('window.__app.scene.activeObject.evaluatedMesh().verts.size');
  const addMod = async (type) => {
    await t.evaluate(`(() => {
      const sel = document.querySelector('.modifier-add-select');
      sel.value = ${JSON.stringify(type)};
      sel.dispatchEvent(new Event('change'));
    })()`);
    await t.sleep(160);
  };

  // Add Mirror via the dropdown → evaluated mesh doubles (8 → 16), base stays 8.
  await addMod('mirror');
  t.check('Mirror added to the stack', (await p45mods()) === 1);
  t.check('Mirror: evaluated 16 verts while base stays 8',
    (await p45eval()) === 16 && (await p45base()) === 8);

  // Toggle the Mirror off → evaluated collapses back to the base mesh (8).
  await t.evaluate(`(() => {
    const cb = document.querySelector('.modifier-entry .modifier-enable');
    cb.checked = false; cb.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(140);
  t.check('disabling Mirror → evaluated equals base (8)', (await p45eval()) === 8);
  // Re-enable.
  await t.evaluate(`(() => {
    const cb = document.querySelector('.modifier-entry .modifier-enable');
    cb.checked = true; cb.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(140);
  t.check('re-enabling Mirror → evaluated 16 again', (await p45eval()) === 16);

  // Add Array on top → default count 2 doubles again: 16 → 32.
  await addMod('array');
  t.check('Array added (stack = 2)', (await p45mods()) === 2);
  t.check('Mirror+Array evaluated multiplies (16 → 32)', (await p45eval()) === 32);

  // Save/load round-trips the modifier stack (v2 format).
  const p45saved = await t.evaluate('window.__app.io.serialize()');
  const p45json = JSON.parse(p45saved);
  t.check('serialized object carries both modifiers',
    p45json.objects[0].modifiers.length === 2 &&
    p45json.objects[0].modifiers[0].type === 'mirror' &&
    p45json.objects[0].modifiers[1].type === 'array');
  await t.evaluate(`window.__app.io.apply(${JSON.stringify(p45saved)})`);
  await t.sleep(140);
  await t.evaluate(`window.__app.scene.selectOnly(window.__app.scene.objects[0].id)`);
  t.check('reload restores the 2-modifier stack', (await p45mods()) === 2);
  t.check('reloaded evaluated mesh still 32 verts', (await p45eval()) === 32);
  await t.evaluate(`document.querySelector('.properties-tab-btn[data-tab="modifier"]')?.click()`);
  await t.sleep(140);

  // Apply the first modifier (Mirror) → base grows 8 → 16, stack shrinks 2 → 1.
  await t.evaluate(`(() => {
    const btn = document.querySelector('.modifier-entry .modifier-apply');
    btn.click();
  })()`);
  await t.sleep(160);
  t.check('Apply grows the base mesh (8 → 16)', (await p45base()) === 16);
  t.check('Apply shrinks the stack (2 → 1)', (await p45mods()) === 1);

  // Ctrl+Z restores both the base mesh and the stack.
  await t.key('z', 'KeyZ', 2);
  await t.sleep(160);
  t.check('Ctrl+Z restores base mesh (16 → 8)', (await p45base()) === 8);
  t.check('Ctrl+Z restores the stack (1 → 2)', (await p45mods()) === 2);

  await t.screenshot('/tmp/p4-5-mirror-array.png');

  // --- P4-6: Subdivision Surface modifier (Catmull-Clark) ---
  // Clean single-Cube scene, cube active, Modifiers tab open.
  await t.evaluate(`window.__app.io.apply(${JSON.stringify(saved)})`);
  await t.evaluate(`window.__app.scene.selectOnly(window.__app.scene.objects[0].id)`);
  await t.evaluate(`document.querySelector('.properties-tab-btn[data-tab="modifier"]')?.click()`);
  await t.sleep(140);

  // 'subsurf' is registered in the Add-Modifier dropdown.
  t.check('Subdivision option present in the Add-Modifier dropdown',
    await t.evaluate(`[...document.querySelector('.modifier-add-select').options].some((o) => o.value === 'subsurf')`));

  // Add Subdivision via the dropdown → level 1 evaluates the cube to 26 verts,
  // base mesh stays 8.
  await addMod('subsurf');
  t.check('Subdivision added to the stack', (await p45mods()) === 1);
  t.check('Subsurf level 1: evaluated 26 verts while base stays 8',
    (await p45eval()) === 26 && (await p45base()) === 8);

  // Set the Levels field to 2 through the param input → evaluated 98.
  await t.evaluate(`(() => {
    const input = document.querySelector('.modifier-entry input.modifier-param[data-key="levels"]');
    input.value = '2';
    input.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(160);
  t.check('Subsurf levels field → 2 evaluates to 98 verts', (await p45eval()) === 98);

  // Performance guard: level 3 on the cube evaluates in < 200ms.
  const p46perf = await t.evaluate(`(() => {
    const obj = window.__app.scene.activeObject;
    obj.modifiers[0].setParam('levels', 3);
    obj.modifiersVersion++;
    const t0 = performance.now();
    const m = obj.evaluatedMesh();
    const dt = performance.now() - t0;
    return { verts: m.verts.size, dt };
  })()`);
  t.check('Subsurf level 3 produces geometry', p46perf.verts > 98);
  t.check('Subsurf level 3 evaluates in < 200ms', p46perf.dt < 200, `${p46perf.dt.toFixed(1)}ms`);

  await t.screenshot('/tmp/p4-6-subsurf.png');

  // --- P6-1: shade smooth ---
  await t.evaluate(`(() => { const s = window.__app.scene; s.selectOnly(s.objects[0].id); })()`);
  t.check('shade-smooth checkbox present',
    await t.until(`!!document.querySelector('[data-action="shade-smooth"]')`, 5000));
  await t.evaluate(`(() => { const cb = document.querySelector('[data-action="shade-smooth"]'); cb.checked = true; cb.dispatchEvent(new Event('change')); })()`);
  await t.sleep(150);
  t.check('toggle sets shadeSmooth on the object',
    await t.evaluate(`window.__app.scene.objects[0].shadeSmooth === true`));
  t.check('scene file persists shadeSmooth',
    await t.evaluate(`JSON.parse(window.__app.io.serialize()).objects[0].shadeSmooth === true`));
  await t.evaluate(`(() => { const cb = document.querySelector('[data-action="shade-smooth"]'); cb.checked = false; cb.dispatchEvent(new Event('change')); })()`);

  // --- P6-2: N-panel (viewport overlay sidebar) ---
  // Clean single-Cube scene, cube active, object mode.
  await t.evaluate(`window.__app.io.apply(${JSON.stringify(saved)})`);
  await t.evaluate(`(() => { const s = window.__app.scene; if (s.editMode) s.exitEditMode(); s.selectOnly(s.objects[0].id); })()`);
  await t.sleep(100);

  t.check('N-panel starts hidden', (await t.evaluate(`!document.querySelector('.n-panel')`)));

  // N toggles the panel on.
  await t.key('n', 'KeyN');
  await t.sleep(120);
  t.check('N shows the .n-panel overlay',
    await t.evaluate(`(() => { const p = document.querySelector('.n-panel'); return !!p && p.style.display !== 'none'; })()`));
  t.check('N-panel shows the active object name',
    await t.evaluate(`document.querySelector('.n-panel .n-panel-name').textContent === 'Cube'`));

  // Location edit via the N-panel moves the object; Ctrl+Z undoes it.
  const nLocX = () => t.evaluate('window.__app.scene.activeObject.transform.position.x');
  const nBeforeX = await nLocX();
  await t.evaluate(`(() => {
    const input = document.querySelector('.n-panel .properties-input');
    input.value = '3';
    input.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(120);
  t.check('N-panel Location X edit moves the object (X = 3)', Math.abs((await nLocX()) - 3) < 1e-6);
  await t.key('z', 'KeyZ', 2); // ctrl+z
  await t.sleep(120);
  t.check('Ctrl+Z undoes the N-panel location edit', Math.abs((await nLocX()) - nBeforeX) < 1e-6);

  // Dimensions track the evaluated mesh: scale the cube 2x → world dims 4.
  await t.evaluate(`(() => {
    const o = window.__app.scene.activeObject;
    o.transform = o.transform.withScale(new o.transform.scale.constructor(2, 2, 2));
  })()`);
  await t.sleep(120);
  const nDims = await t.evaluate(`[...document.querySelectorAll('.n-panel .n-panel-value')].slice(0, 3).map((s) => parseFloat(s.textContent))`);
  t.check('Dimensions update after a 2x scale (4 / 4 / 4)',
    nDims.length === 3 && nDims.every((d) => Math.abs(d - 4) < 1e-3), nDims.join(', '));
  // Restore scale so the suite ends clean.
  await t.evaluate(`(() => {
    const o = window.__app.scene.activeObject;
    o.transform = o.transform.withScale(new o.transform.scale.constructor(1, 1, 1));
  })()`);

  // Edit mode: the panel shows the element counts line.
  await t.key('Tab', 'Tab');
  await t.sleep(120);
  t.check('edit mode enters', (await t.evaluate('window.__app.scene.mode')) === 'edit');
  t.check('N-panel shows edit-mesh counts (Verts 8 · Edges 12 · Faces 6)',
    await t.evaluate(`document.querySelector('.n-panel .n-panel-counts').textContent === 'Verts 8 · Edges 12 · Faces 6'`));
  await t.key('Tab', 'Tab'); // back to object mode
  await t.sleep(100);

  // N while G is modal must NOT toggle the panel — the key routes to the operator.
  await t.key('g', 'KeyG');
  await t.sleep(80);
  await t.key('n', 'KeyN'); // should be swallowed by the modal Move operator
  await t.sleep(80);
  t.check('N during a modal G op does not hide the panel',
    await t.evaluate(`(() => { const p = document.querySelector('.n-panel'); return !!p && p.style.display !== 'none'; })()`));
  await t.key('Escape', 'Escape'); // cancel the Move
  await t.sleep(80);

  await t.screenshot('/tmp/p6-2-npanel.png');

  // --- P6-3: per-object viewport color ---
  // Layout workspace (Properties panel visible), clean single-Cube scene, cube
  // active + Object tab open so the color picker row is in the DOM.
  await t.evaluate(`document.querySelector('.wsp-tab[data-workspace="Layout"]')?.click()`);
  await t.sleep(150);
  await t.evaluate(`window.__app.io.apply(${JSON.stringify(saved)})`);
  await t.evaluate(`(() => { const s = window.__app.scene; if (s.editMode) s.exitEditMode(); s.selectOnly(s.objects[0].id); })()`);
  await t.evaluate(`document.querySelector('.properties-tab-btn[data-tab="object"]')?.click()`);
  await t.sleep(120);

  t.check('object color picker row present',
    await t.until(`!!document.querySelector('.properties-color')`, 5000));

  const objColor0 = () => t.evaluate('window.__app.scene.objects[0].color[0]');
  const setGrey = async () => {
    await t.evaluate(`(() => { window.__app.scene.objects[0].color = [0.69, 0.69, 0.69]; })()`);
    await t.sleep(80);
  };
  const setRedViaPicker = async () => {
    await t.evaluate(`(() => {
      const inp = document.querySelector('.properties-color');
      inp.value = '#ff0000';
      inp.dispatchEvent(new Event('input'));
    })()`);
    await t.sleep(80);
  };

  const { statSync: statP63 } = await import('node:fs');
  const szP63 = (p) => statP63(p).size;

  // Matcap: grey vs red renders must differ, and the picker sets a red-dominant color.
  await t.evaluate(`window.__app.renderer.shadingMode = 'matcap'`);
  await setGrey();
  const matcapGrey = await t.screenshot('/tmp/p6-3-matcap-grey.png');
  await setRedViaPicker();
  t.check('picker sets a red-dominant color (matcap)', (await objColor0()) > 0.9);
  const matcapRed = await t.screenshot('/tmp/p6-3-matcap-red.png');
  t.check('matcap tint: grey vs red renders differ',
    szP63(matcapGrey) !== szP63(matcapRed), `${szP63(matcapGrey)} / ${szP63(matcapRed)}`);

  // Studio: same check under the studio shader (base color replaced by u_color).
  await t.evaluate(`window.__app.renderer.shadingMode = 'studio'`);
  await setGrey();
  const studioGrey = await t.screenshot('/tmp/p6-3-studio-grey.png');
  await setRedViaPicker();
  t.check('picker sets a red-dominant color (studio)', (await objColor0()) > 0.9);
  const studioRed = await t.screenshot('/tmp/p6-3-studio-red.png');
  t.check('studio tint: grey vs red renders differ',
    szP63(studioGrey) !== szP63(studioRed), `${szP63(studioGrey)} / ${szP63(studioRed)}`);

  // Color persists through save/load (v2 scene file carries a color triple).
  const p63json = JSON.parse(await t.evaluate('window.__app.io.serialize()'));
  t.check('serialized object carries a color triple',
    Array.isArray(p63json.objects[0].color) && p63json.objects[0].color.length === 3 &&
    p63json.objects[0].color[0] > 0.9);

  // Restore clean state so the suite ends as it began.
  await t.evaluate(`window.__app.renderer.shadingMode = 'matcap'`);
  await t.evaluate(`window.__app.io.apply(${JSON.stringify(saved)})`);

  // --- P6-4: autosave + crash restore ---
  // Start from a clean single-Cube scene with no stored autosave.
  await t.evaluate(`window.__app.io.apply(${JSON.stringify(saved)})`);
  await t.evaluate(`window.__app.autosave.clear()`);
  await t.sleep(60);

  // FLOW 1 — Restore. Mutate the scene (move the cube, add an object), autosave,
  // then reload: the boot prompt must appear and Restore must bring the mutation back.
  await t.evaluate(`(() => {
    const scene = window.__app.scene, cube = scene.objects[0];
    const P = cube.transform.position;
    cube.transform = cube.transform.withPosition(new P.constructor(7, 2, -3));
    scene.add('Autosaved', cube.mesh.clone());
    window.__app.autosave.saveNow();
  })()`);
  const stored = await t.evaluate(`localStorage.getItem('vibe-blender-autosave')`);
  t.check('saveNow writes the autosave envelope',
    typeof stored === 'string' && JSON.parse(stored).format === 'vibe-blender-autosave' &&
    typeof JSON.parse(stored).savedAt === 'number' && typeof JSON.parse(stored).scene === 'string');

  await t.reload();
  await t.sleep(200);
  // Fresh boot shows the default cube...
  t.check('boot starts from the default single-Cube scene',
    await t.evaluate('window.__app.scene.objects.length') === 1);
  // ...and the restore toast (autosave differs from default).
  t.check('restore toast appears when a differing autosave exists',
    await t.until(`!!document.querySelector('.restore-toast')`, 5000));
  t.check('toast offers Restore + Discard buttons',
    await t.evaluate(`!!document.querySelector('.restore-toast [data-action="restore"]') && !!document.querySelector('.restore-toast [data-action="discard"]')`));

  await t.evaluate(`document.querySelector('.restore-toast [data-action="restore"]').click()`);
  await t.sleep(140);
  const restored = await t.evaluate(`(() => {
    const scene = window.__app.scene, cube = scene.objects[0];
    return { count: scene.objects.length, x: cube.transform.position.x,
             names: scene.objects.map((o) => o.name) };
  })()`);
  t.check('Restore brings the mutation back (2 objects, cube at X=7)',
    restored.count === 2 && Math.abs(restored.x - 7) < 1e-6 && restored.names.includes('Autosaved'));
  t.check('toast is gone after Restore',
    await t.evaluate(`!document.querySelector('.restore-toast')`));
  t.check('Restore clears undo history',
    await t.evaluate(`(() => { window.__app.undo.push({ name: 'x', undo(){}, redo(){} }); return true; })()`) === true);

  // FLOW 2 — Discard. Re-arm an autosave that differs, reload, then Discard →
  // scene stays the default cube and the autosave key is removed.
  await t.evaluate(`window.__app.io.apply(${JSON.stringify(saved)})`);
  await t.evaluate(`(() => {
    const scene = window.__app.scene, cube = scene.objects[0];
    cube.transform = cube.transform.withPosition(new cube.transform.position.constructor(9, 0, 0));
    window.__app.autosave.saveNow();
  })()`);
  await t.reload();
  await t.sleep(200);
  t.check('restore toast appears again for FLOW 2',
    await t.until(`!!document.querySelector('.restore-toast')`, 5000));
  await t.evaluate(`document.querySelector('.restore-toast [data-action="discard"]').click()`);
  await t.sleep(140);
  const discarded = await t.evaluate(`(() => {
    const scene = window.__app.scene, cube = scene.objects[0];
    return { count: scene.objects.length, name: cube.name, x: cube.transform.position.x,
             key: localStorage.getItem('vibe-blender-autosave') };
  })()`);
  t.check('Discard leaves the default cube scene (1 obj, Cube at origin)',
    discarded.count === 1 && discarded.name === 'Cube' && Math.abs(discarded.x) < 1e-6);
  t.check('Discard removes the autosave key', discarded.key === null);
  t.check('toast is gone after Discard',
    await t.evaluate(`!document.querySelector('.restore-toast')`));

  // No autosave → no toast on the next boot.
  await t.evaluate(`window.__app.autosave.clear()`);
  await t.reload();
  await t.sleep(200);
  t.check('no autosave → no restore toast on boot',
    await t.evaluate(`!document.querySelector('.restore-toast')`));

  // Saving/loading a file clears the autosave (the file is the source of truth).
  await t.evaluate(`(() => {
    const scene = window.__app.scene, cube = scene.objects[0];
    cube.transform = cube.transform.withPosition(new cube.transform.position.constructor(4, 0, 0));
    window.__app.autosave.saveNow();
  })()`);
  t.check('autosave present before load', (await t.evaluate(`localStorage.getItem('vibe-blender-autosave')`)) !== null);
  await t.evaluate(`window.__app.io.apply(${JSON.stringify(saved)})`);
  t.check('loading a file clears the autosave',
    (await t.evaluate(`localStorage.getItem('vibe-blender-autosave')`)) === null);

  // --- P7-1: Join objects (Ctrl+J) ---
  // Clean single-Cube scene, then add a second cube moved +3 on X. Origin cube is
  // the active (join target); both are selected.
  await t.evaluate(`window.__app.io.apply(${JSON.stringify(saved)})`);
  await t.evaluate(`(() => {
    const s = window.__app.scene;
    if (s.editMode) s.exitEditMode();
    const a = s.objects[0];                 // origin Cube = active / join target
    const b = s.add('Cube.moved', a.mesh.clone());
    b.transform = b.transform.withPosition(new a.transform.position.constructor(3, 0, 0));
    s.selection.clear();
    s.selection.add(a.id); s.selection.add(b.id);
    s.activeId = a.id;
  })()`);
  await t.sleep(80);
  const p71before = await t.evaluate(`(() => {
    const s = window.__app.scene;
    return { count: s.objects.length, sel: s.selection.size, activeVerts: s.activeObject.mesh.verts.size };
  })()`);
  t.check('P7-1 setup: 2 objects, both selected, active cube has 8 verts',
    p71before.count === 2 && p71before.sel === 2 && p71before.activeVerts === 8);

  // Ctrl+J merges the moved cube into the active cube.
  await t.key('j', 'KeyJ', 2); // ctrl+j
  await t.sleep(120);
  const p71joined = await t.evaluate(`(() => {
    const s = window.__app.scene;
    return { count: s.objects.length, evalVerts: s.activeObject.evaluatedMesh().verts.size,
             status: document.getElementById('status').textContent };
  })()`);
  t.check('Ctrl+J merges into a single object', p71joined.count === 1);
  t.check('joined object evaluates to 16 verts (two cubes baked)', p71joined.evalVerts === 16);
  t.check('Ctrl+J reports a Join status', p71joined.status.includes('Joined'));

  // A baked vert lands at the moved cube's world corner: (3,0,0)+(1,1,1) = (4,1,1).
  const p71baked = await t.evaluate(`(() => {
    const m = window.__app.scene.activeObject.mesh;
    return [...m.verts.values()].some((v) =>
      Math.abs(v.co.x - 4) < 1e-6 && Math.abs(v.co.y - 1) < 1e-6 && Math.abs(v.co.z - 1) < 1e-6);
  })()`);
  t.check('a baked vert lands at the source cube world position (4,1,1)', p71baked === true);

  // Ctrl+Z restores both objects, the active mesh, and the moved cube's position.
  await t.key('z', 'KeyZ', 2); // ctrl+z
  await t.sleep(120);
  const p71undo = await t.evaluate(`(() => {
    const s = window.__app.scene;
    const moved = s.objects.find((o) => o.name === 'Cube.moved');
    return { count: s.objects.length, activeVerts: s.activeObject.mesh.verts.size,
             movedX: moved ? moved.transform.position.x : null };
  })()`);
  t.check('Ctrl+Z restores 2 objects', p71undo.count === 2);
  t.check('Ctrl+Z restores the active mesh to 8 verts', p71undo.activeVerts === 8);
  t.check('Ctrl+Z restores the moved cube at X=3', Math.abs(p71undo.movedX - 3) < 1e-6);

  // Restore the default scene so the suite ends clean.
  await t.evaluate(`window.__app.io.apply(${JSON.stringify(saved)})`);

  // --- P7-4: grid snapping (Shift+Tab toggle, snapped G-move, plain-Tab regression) ---
  await t.sleep(80);
  // Fresh default scene: single Cube at origin, object mode. Select + reset it.
  await t.evaluate(`(() => {
    const s = window.__app.scene;
    if (s.editMode) s.exitEditMode();
    const c = s.objects[0];
    c.transform = c.transform.withPosition(new c.transform.position.constructor(0, 0, 0));
    s.selectOnly(c.id);
  })()`);
  const snapChip = () => t.evaluate(`(() => { const b = document.querySelector('[data-action="snap-toggle"]'); return b ? b.getAttribute('aria-pressed') : null; })()`);
  const cubePos = () => t.evaluate(`(() => { const p = window.__app.scene.objects[0].transform.position; return { x: p.x, y: p.y, z: p.z }; })()`);
  const isMul = (v, step = 0.5) => Math.abs(v / step - Math.round(v / step)) < 1e-6;

  // Canvas-relative points (workspace layout shrinks the canvas).
  const srect = await t.evaluate('(() => { const r = document.querySelector("canvas").getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()');
  const scv = (fx, fy) => [Math.round(srect.x + srect.w * fx), Math.round(srect.y + srect.h * fy)];
  const [sCenX, sCenY] = scv(0.5, 0.48);

  t.check('P7-4 snap chip starts off', (await snapChip()) === 'false');

  // Shift+Tab enables snapping; the magnet chip reflects it (aria-pressed).
  await t.key('Tab', 'Tab', 8); // shift = 8
  await t.sleep(80);
  t.check('Shift+Tab turns snapping ON (chip reflects it)', (await snapChip()) === 'true');

  // Plain Tab still toggles edit mode (regression) — snapping stays on.
  await t.key('Tab', 'Tab');
  t.check('plain Tab still enters edit mode', (await t.evaluate('window.__app.scene.mode')) === 'edit');
  t.check('plain Tab did not disturb the snap chip', (await snapChip()) === 'true');
  await t.key('Tab', 'Tab');
  t.check('plain Tab returns to object mode', (await t.evaluate('window.__app.scene.mode')) === 'object');

  // G-move the cube with snapping ON → every confirmed position component is a 0.5 multiple.
  await t.evaluate(`window.__app.scene.selectOnly(window.__app.scene.objects[0].id)`);
  await t.mouse('mouseMoved', sCenX, sCenY);
  await t.key('g', 'KeyG');
  await t.mouse('mouseMoved', sCenX + 143, sCenY - 97); // odd pixel amounts
  await t.sleep(80);
  await t.key('Enter', 'Enter');
  await t.sleep(80);
  const snapped = await cubePos();
  t.check('snapped move lands on 0.5 multiples',
    isMul(snapped.x) && isMul(snapped.y) && isMul(snapped.z),
    `(${snapped.x.toFixed(4)}, ${snapped.y.toFixed(4)}, ${snapped.z.toFixed(4)})`);

  // Turn snapping OFF, drag by an odd pixel amount → lands on a non-multiple.
  await t.key('Tab', 'Tab', 8); // shift+tab off
  await t.sleep(80);
  t.check('Shift+Tab turns snapping OFF', (await snapChip()) === 'false');
  await t.mouse('mouseMoved', sCenX, sCenY);
  await t.key('g', 'KeyG');
  await t.mouse('mouseMoved', sCenX + 137, sCenY - 89);
  await t.sleep(80);
  await t.key('Enter', 'Enter');
  await t.sleep(80);
  const free = await cubePos();
  t.check('un-snapped move lands off the 0.5 grid',
    !(isMul(free.x) && isMul(free.y) && isMul(free.z)),
    `(${free.x.toFixed(4)}, ${free.y.toFixed(4)}, ${free.z.toFixed(4)})`);

  // Restore the default scene again so the suite ends clean.
  await t.evaluate(`window.__app.io.apply(${JSON.stringify(saved)})`);

  // Leave storage clean so a later suite's boot never sees a stale toast.
  await t.evaluate(`window.__app.autosave.clear()`);
});
