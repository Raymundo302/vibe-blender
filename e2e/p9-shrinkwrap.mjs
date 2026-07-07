/**
 * P9-2 e2e — Shrinkwrap modifier. Builds two objects via __app, adds a
 * Shrinkwrap through the Modifiers tab UI, picks the target in the object
 * dropdown, asserts the host's evaluated verts moved onto the target, then
 * proves the target reference survives a save→load round-trip (byte-equal
 * double serialize, and the reloaded modifier resolves to the same-named
 * object). Run with the dev server up:
 *   flock /tmp/vibe-blender-e2e.lock node e2e/p9-shrinkwrap.mjs
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  // Evaluate an expression that resolves a Promise (dynamic import) — the
  // shared harness evaluate() doesn't await promises.
  const evalAsync = async (expr) => {
    const { result, exceptionDetails } = await t.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    });
    if (exceptionDetails) throw new Error(`page threw: ${exceptionDetails.text}`);
    return result.value;
  };

  const saved = await t.evaluate('window.__app.io.serialize()');
  await t.evaluate(`document.querySelector('.wsp-tab[data-workspace="Layout"]')?.click()`);
  await t.sleep(150);

  // --- Build the scene: a target cube at origin + a host plane hovering above. ---
  const built = await evalAsync(`(async () => {
    const app = window.__app, S = app.scene;
    while (S.objects.length) S.remove(S.objects[0].id); // blank scene
    const prim = await import('/src/core/mesh/primitives.ts');
    const V = (await import('/src/core/math/vec3.ts')).Vec3;
    const target = S.add('Donut', prim.makeCube());
    // Host plane raised to y=3, narrower than the cube top so every vert snaps
    // onto the +Y face.
    const host = S.add('Icing', prim.makePlane(1));
    host.transform = host.transform.withPosition(new V(0, 3, 0));
    S.selectOnly(host.id);
    return { hostId: host.id, targetId: target.id };
  })()`);
  await t.sleep(150);
  const hostId = built.hostId;
  const targetId = built.targetId;

  // --- Add Shrinkwrap through the Modifiers tab UI. ---
  t.check('Modifiers tab button exists',
    await t.until(`!!document.querySelector('.properties-tab-btn[data-tab="modifier"]')`, 5000));
  await t.evaluate(`document.querySelector('.properties-tab-btn[data-tab="modifier"]').click()`);
  await t.sleep(140);

  t.check('Shrinkwrap is offered in the Add Modifier dropdown',
    await t.evaluate(`(() => {
      const sel = document.querySelector('.modifier-add-select');
      return !!sel && [...sel.options].some((o) => o.value === 'shrinkwrap');
    })()`));

  await t.evaluate(`(() => {
    const sel = document.querySelector('.modifier-add-select');
    sel.value = 'shrinkwrap';
    sel.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(160);
  t.check('Shrinkwrap added to the host stack',
    (await t.evaluate(`window.__app.scene.get(${hostId}).modifiers.length`)) === 1 &&
    (await t.evaluate(`window.__app.scene.get(${hostId}).modifiers[0].type`)) === 'shrinkwrap');

  // --- Pick the target in the object dropdown (kind:'object' param). ---
  await t.evaluate(`(() => {
    const sel = document.querySelector('.modifier-param[data-key="target"]');
    sel.value = String(${targetId});
    sel.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(150);
  t.check('target param committed to the cube id',
    (await t.evaluate(`window.__app.scene.get(${hostId}).modifiers[0].params().target`)) === targetId);

  // --- Evaluated verts moved onto the cube top face (world y ≈ 1). ---
  const maxDy = await t.evaluate(`(() => {
    const app = window.__app, S = app.scene;
    const host = S.get(${hostId});
    const mesh = host.evaluatedMesh(S.modifierContext(host));
    const M = host.transform.matrix();
    let maxDy = 0;
    for (const v of mesh.verts.values()) {
      const w = M.transformPoint(v.co);
      maxDy = Math.max(maxDy, Math.abs(w.y - 1));
    }
    return maxDy;
  })()`);
  t.check('all host verts snapped to the cube top (world y ≈ 1)', maxDy < 1e-3, `maxDy=${maxDy}`);

  // --- Save→load round-trip: byte-equal double serialize + target resolves. ---
  const s1 = await t.evaluate('window.__app.io.serialize()');
  await t.evaluate(`window.__app.io.apply(${JSON.stringify(s1)})`);
  await t.sleep(150);
  const s2 = await t.evaluate('window.__app.io.serialize()');
  t.check('serialize is byte-stable across a save→load round-trip', s1 === s2,
    `${s1.length} vs ${s2.length}`);

  const resolved = await t.evaluate(`(() => {
    const app = window.__app, S = app.scene;
    const host = S.objects.find((o) => o.name === 'Icing');
    if (!host || !host.modifiers[0]) return null;
    const tid = host.modifiers[0].params().target;
    const tgt = S.get(tid);
    return tgt ? tgt.name : null;
  })()`);
  t.check('reloaded Shrinkwrap target resolves to the same-named object',
    resolved === 'Donut', `resolved=${resolved}`);

  // Restore the starting scene so the suite ends as it began.
  await t.evaluate(`window.__app.io.apply(${JSON.stringify(saved)})`);
  await t.evaluate(`window.__app.autosave.clear()`);
});
