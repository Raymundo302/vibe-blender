/**
 * P8-5 e2e — Scene format v3. Builds a lit scene (mesh + material, lights,
 * camera) through __app, proves serialize → apply round-trips kinds, materials
 * and the active camera byte-identically, checks the outliner shows kind
 * glyphs, and drives Ctrl+J with a light selected + a cube active to prove the
 * join skips the light and the light survives. Run with the dev server up:
 *   flock /tmp/vibe-blender-e2e.lock node e2e/p8-scene.mjs
 */
import { runE2e } from './harness.mjs';

// Bumped whenever sceneJson VERSION bumps — single spot for the whole suite.
const CURRENT_FORMAT_VERSION = 10; // v10: optional material.shadeless (UR4-3)

runE2e(async (t) => {
  // Layout workspace so the Outliner is on screen.
  await t.evaluate(`document.querySelector('.wsp-tab[data-workspace="Layout"]')?.click()`);
  await t.sleep(150);

  // Snapshot the pristine scene so we can restore it at the end.
  const pristine = await t.evaluate('window.__app.io.serialize()');

  // --- Build a lit scene through __app: cube + material, 2 lights, 1 camera ---
  await t.evaluate(`(() => {
    const s = window.__app.scene;
    if (s.editMode) s.exitEditMode();
    // Fresh single cube.
    while (s.objects.length > 1) s.remove(s.objects[s.objects.length - 1].id);
    const cube = s.objects[0];
    const mat = s.addMaterial('Red');
    mat.baseColor = [1, 0.1, 0.05];
    mat.metallic = 0.25;
    mat.roughness = 0.3;
    cube.materialId = mat.id;
    s.addLight('Point', 'point');
    const spot = s.addLight('Spot', 'spot');
    spot.light.spotAngle = 1.047;
    spot.light.color = [0.2, 0.4, 0.9];
    s.addCamera('Camera');
    s.selectOnly(cube.id);
  })()`);
  await t.sleep(120);

  t.check('scene has mesh + 2 lights + camera',
    (await t.evaluate('window.__app.scene.objects.map((o) => o.kind).join(",")')) ===
      'mesh,light,light,camera');
  t.check('camera auto-activated',
    (await t.evaluate('window.__app.scene.activeCamera?.name')) === 'Camera');

  // --- Round trip: serialize → apply → serialize is byte-identical ---
  const s1 = await t.evaluate('window.__app.io.serialize()');
  const parsed = JSON.parse(s1);
  t.check('serialized at the current format version', parsed.version === CURRENT_FORMAT_VERSION);
  t.check('materials serialized', Array.isArray(parsed.materials) && parsed.materials.length === 1);
  // Active camera is stored as an INDEX into objects (ids never hit the file —
  // that's what keeps round trips byte-identical after deletions leave id gaps).
  t.check('activeCamera index present', parsed.activeCamera === 3);

  await t.evaluate(`window.__app.io.apply(${JSON.stringify(s1)})`);
  await t.sleep(120);
  const s2 = await t.evaluate('window.__app.io.serialize()');
  t.check('serialize → apply → serialize is byte-identical', s1 === s2);

  const after = await t.evaluate(`(() => {
    const s = window.__app.scene;
    return {
      kinds: s.objects.map((o) => o.kind).join(','),
      matName: s.materials[0]?.name,
      cubeMat: s.objects[0].materialId === s.materials[0]?.id,
      activeCam: s.activeCamera?.name,
      activeMatches: s.activeCameraId === s.objects[3]?.id,
    };
  })()`);
  t.check('apply preserves kinds', after.kinds === 'mesh,light,light,camera');
  t.check('apply preserves the material library', after.matName === 'Red');
  t.check('apply keeps the cube → material assignment', after.cubeMat === true);
  t.check('apply preserves + remaps the active camera', after.activeCam === 'Camera' && after.activeMatches === true);

  // --- Outliner kind glyphs (▢ mesh, 💡 light, 🎥 camera) ---
  await t.sleep(120);
  const glyphs = await t.evaluate(`
    [...document.querySelectorAll('.outliner-row .outliner-kind')].map((e) => e.textContent).join('')
  `);
  t.check('outliner shows the light glyph 💡', glyphs.includes('\u{1F4A1}'));
  t.check('outliner shows the camera glyph 🎥', glyphs.includes('\u{1F3A5}'));
  t.check('outliner shows the mesh glyph ▢', glyphs.includes('▢'));

  // --- Ctrl+J: cube active + a light selected → joins meshes, light survives ---
  const before = await t.evaluate(`(() => {
    const s = window.__app.scene;
    // Add a second cube to join into the first, keep the point light around.
    const c2 = s.duplicate(s.objects[0], 'Cube.001');
    const cube = s.objects[0];
    const light = s.objects.find((o) => o.kind === 'light');
    s.selection.clear();
    s.selection.add(cube.id);
    s.selection.add(c2.id);
    s.selection.add(light.id);
    s.activeId = cube.id; // active object is the mesh
    return { count: s.objects.length, lightId: light.id };
  })()`);
  await t.sleep(80);

  await t.key('j', 'KeyJ', 2); // Ctrl+J
  await t.sleep(120);

  const joined = await t.evaluate(`(() => {
    const s = window.__app.scene;
    return {
      count: s.objects.length,
      lightSurvives: s.objects.some((o) => o.id === ${before.lightId} && o.kind === 'light'),
      status: document.getElementById('status')?.textContent,
    };
  })()`);
  t.check('Ctrl+J joined the two cubes (object count dropped by one)',
    joined.count === before.count - 1, `before ${before.count} after ${joined.count}`);
  t.check('the light survived the join', joined.lightSurvives === true);
  t.check('status reports a successful join', /join/i.test(joined.status ?? ''));

  // --- Ctrl+J guard: non-mesh active object is rejected ---
  await t.evaluate(`(() => {
    const s = window.__app.scene;
    const light = s.objects.find((o) => o.kind === 'light');
    const mesh = s.objects.find((o) => o.kind === 'mesh');
    s.selection.clear();
    s.selection.add(light.id);
    s.selection.add(mesh.id);
    s.activeId = light.id; // non-mesh active
  })()`);
  await t.sleep(80);
  await t.key('j', 'KeyJ', 2);
  await t.sleep(100);
  t.check('Ctrl+J with a non-mesh active object is refused',
    /needs a mesh active object/i.test(await t.evaluate(`document.getElementById('status')?.textContent`)));

  // Restore the pristine scene.
  await t.evaluate(`window.__app.io.apply(${JSON.stringify(pristine)})`);
  await t.sleep(80);
  t.check('app still alive after the suite', await t.evaluate('!!window.__app.scene'));
});
