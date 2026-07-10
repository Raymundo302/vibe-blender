/**
 * Displace modifier e2e. Adds a Displace modifier to a cube through the
 * Properties → Modifiers tab UI, then exercises it end to end:
 *   1. add Displace via the Add-Modifier dropdown → evaluated verts differ from
 *      the base mesh (default = normal-direction noise).
 *   2. set the Strength field to 0 → evaluated positions equal the base again.
 *   3. Strength back up, Texture = None, Midlevel = 0 → every vert offset
 *      outward along its normal by exactly Strength (uniform inflate).
 *   4. serialize → apply round trip: the modifier + its params survive and the
 *      evaluated mesh is reproduced.
 *
 * Run with the dev server up (unique debug port to avoid hijacking peers):
 *   E2E_PORT=9402 node e2e/displace.mjs
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  const evalAsync = async (expr) => {
    const { result, exceptionDetails } = await t.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    });
    if (exceptionDetails) throw new Error(`page threw: ${exceptionDetails.text}`);
    return result.value;
  };

  await t.evaluate(`document.querySelector('.wsp-tab[data-workspace="Layout"]')?.click()`);
  await t.sleep(150);

  // Blank scene + a single cube.
  const built = await evalAsync(`(async () => {
    const S = window.__app.scene;
    if (S.editMode) S.exitEditMode();
    while (S.objects.length) S.remove(S.objects[0].id);
    const prim = await import('/src/core/mesh/primitives.ts');
    const cube = S.add('Blob', prim.makeCube(1));
    S.selectOnly(cube.id);
    const base = {};
    for (const v of cube.mesh.verts.values()) base[v.id] = [v.co.x, v.co.y, v.co.z];
    return { id: cube.id, base };
  })()`);
  const cubeId = built.id;
  const base = built.base;
  await t.sleep(120);
  t.check('cube base has 8 verts', Object.keys(base).length === 8);

  // Helper: evaluated positions as { id: [x,y,z] }.
  const evalPos = () => t.evaluate(`(() => {
    const m = window.__app.scene.get(${cubeId}).evaluatedMesh();
    const o = {};
    for (const v of m.verts.values()) o[v.id] = [v.co.x, v.co.y, v.co.z];
    return o;
  })()`);
  const maxDelta = (a, b) => {
    let d = 0;
    for (const id of Object.keys(a)) {
      const p = a[id], q = b[id];
      const dx = p[0] - q[0], dy = p[1] - q[1], dz = p[2] - q[2];
      d = Math.max(d, Math.sqrt(dx * dx + dy * dy + dz * dz));
    }
    return d;
  };

  // Open the Modifiers tab.
  t.check('Modifiers tab button exists',
    await t.until(`!!document.querySelector('.properties-tab-btn[data-tab="modifier"]')`, 5000));
  await t.evaluate(`document.querySelector('.properties-tab-btn[data-tab="modifier"]').click()`);
  await t.sleep(140);

  t.check('Displace is offered in the Add Modifier dropdown',
    await t.evaluate(`(() => {
      const sel = document.querySelector('.modifier-add-select');
      return !!sel && [...sel.options].some((o) => o.value === 'displace');
    })()`));

  await t.evaluate(`(() => {
    const sel = document.querySelector('.modifier-add-select');
    sel.value = 'displace';
    sel.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(160);
  t.check('Displace added to the stack',
    (await t.evaluate(`window.__app.scene.get(${cubeId}).modifiers.length`)) === 1 &&
    (await t.evaluate(`window.__app.scene.get(${cubeId}).modifiers[0].type`)) === 'displace');

  // 1. Default (noise) displaces the verts away from the base.
  const noised = await evalPos();
  t.check('displace (default noise) moves the evaluated verts off the base',
    maxDelta(noised, base) > 0.01, `maxDelta=${maxDelta(noised, base)}`);

  // The Texture field renders as a select offering Noise + None.
  t.check('Texture field is a select with noise/none options',
    await t.evaluate(`(() => {
      const sel = document.querySelector('.modifier-param[data-key="texture"]');
      return !!sel && sel.tagName === 'SELECT' &&
        [...sel.options].map((o) => o.value).sort().join(',') === 'noise,none';
    })()`));

  // 2. Strength 0 → evaluated equals base.
  await t.evaluate(`(() => {
    const inp = document.querySelector('.modifier-param[data-key="strength"]');
    inp.value = '0';
    inp.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(140);
  const zeroed = await evalPos();
  t.check('Strength 0 → evaluated positions equal the base',
    maxDelta(zeroed, base) < 1e-6, `maxDelta=${maxDelta(zeroed, base)}`);

  // 3. Texture None + Midlevel 0 + Strength 0.5 → uniform outward offset.
  await t.evaluate(`(() => {
    const set = (key, val) => {
      const el = document.querySelector('.modifier-param[data-key="' + key + '"]');
      el.value = val;
      el.dispatchEvent(new Event('change'));
    };
    set('texture', 'none');
    set('midlevel', '0');
    set('strength', '0.5');
  })()`);
  await t.sleep(160);
  const inflated = await evalPos();
  const offsets = Object.keys(base).map((id) => {
    const p = inflated[id], q = base[id];
    const dx = p[0] - q[0], dy = p[1] - q[1], dz = p[2] - q[2];
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const outward = Math.sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2]) >
      Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2]);
    return { dist, outward };
  });
  t.check('Texture None midlevel 0 → every vert moved outward',
    offsets.every((o) => o.outward));
  t.check('uniform offset — every vert moved by exactly Strength (0.5)',
    offsets.every((o) => Math.abs(o.dist - 0.5) < 1e-4),
    `dists=${offsets.map((o) => o.dist.toFixed(4)).join(',')}`);

  // 4. Save/load round trip: modifier + params survive, evaluated reproduced.
  const saved = await t.evaluate('window.__app.io.serialize()');
  await t.evaluate(`window.__app.io.apply(${JSON.stringify(saved)})`);
  await t.sleep(160);
  const reloadedId = await t.evaluate(`window.__app.scene.objects[0].id`);
  t.check('after load the object still has one Displace modifier',
    (await t.evaluate(`window.__app.scene.get(${reloadedId}).modifiers.length`)) === 1 &&
    (await t.evaluate(`window.__app.scene.get(${reloadedId}).modifiers[0].type`)) === 'displace');
  t.check('loaded modifier params round-tripped',
    await t.evaluate(`(() => {
      const p = window.__app.scene.get(${reloadedId}).modifiers[0].params();
      return p.texture === 'none' && p.midlevel === 0 && p.strength === 0.5;
    })()`));
  const reloadedPos = await t.evaluate(`(() => {
    const m = window.__app.scene.get(${reloadedId}).evaluatedMesh();
    const o = {};
    for (const v of m.verts.values()) o[v.id] = [v.co.x, v.co.y, v.co.z];
    return o;
  })()`);
  t.check('evaluated mesh reproduced across save/load',
    maxDelta(reloadedPos, inflated) < 1e-6, `maxDelta=${maxDelta(reloadedPos, inflated)}`);

  await t.screenshot('/tmp/displace-e2e.png');
});
