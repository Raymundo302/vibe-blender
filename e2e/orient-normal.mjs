/*
 * Transform orientation in EDIT mode — Global vs Normal axis locks. On the
 * cube's +X face (averaged vertex normal ≈ +X): Global "G Z" moves along world
 * Z, while Normal "G Z" moves along the face NORMAL (world X). Proves the edit
 * G/R/S operators build their axis basis from scene.transformOrientation.
 *
 *   flock /tmp/vibe-blender-e2e.lock node e2e/orient-normal.mjs
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  await t.until('!!window.__app');

  async function moveZOnPlusXFace(orientation) {
    await t.reload();
    await t.until('!!window.__app');
    const info = await t.evaluate(`(() => {
      const s = window.__app.scene;
      const cube = s.objects.find(o => o.kind === 'mesh');
      s.selectOnly(cube.id);
      s.enterEditMode(cube.id);
      const e = s.editMode, obj = s.editObject;
      e.elementMode = 'vert';
      e.verts.clear();
      for (const [id, v] of obj.mesh.verts) if (v.co.x > 0.5) e.verts.add(id);
      e.touch();
      s.transformOrientation = ${JSON.stringify(orientation)};
      window.__selIds = [...e.selectedVertIds(obj.mesh)];
      const r = document.querySelector('canvas').getBoundingClientRect();
      return { ccx: r.left + r.width / 2, ccy: r.top + r.height / 2, count: window.__selIds.length };
    })()`);
    const centroid = () => t.evaluate(`(() => {
      const s = window.__app.scene, obj = s.editObject, m = s.worldMatrix(obj);
      let x=0,y=0,z=0; for (const id of window.__selIds) { const p = m.transformPoint(obj.mesh.verts.get(id).co); x+=p.x;y+=p.y;z+=p.z; }
      const n = window.__selIds.length; return { x:x/n, y:y/n, z:z/n };
    })()`);
    const before = await centroid();
    await t.key('g', 'KeyG');
    await t.key('z', 'KeyZ');
    await t.mouse('mouseMoved', info.ccx + 120, info.ccy - 80);
    await t.sleep(60);
    await t.mouse('mouseMoved', info.ccx + 40, info.ccy - 120);
    await t.sleep(80);
    await t.key('Enter', 'Enter');
    await t.sleep(60);
    const after = await centroid();
    return { dx: after.x - before.x, dy: after.y - before.y, dz: after.z - before.z, count: info.count };
  }
  const dom = (d) => { const ax = Math.abs(d.dx), ay = Math.abs(d.dy), az = Math.abs(d.dz); return ax >= ay && ax >= az ? 'x' : (ay >= az ? 'y' : 'z'); };

  const g = await moveZOnPlusXFace('global');
  t.check('selected the +X face (4 verts)', g.count === 4);
  t.check('Global G,Z moves the +X face along world Z', dom(g) === 'z' && Math.abs(g.dz) > 0.05,
    `d=(${g.dx.toFixed(2)},${g.dy.toFixed(2)},${g.dz.toFixed(2)})`);

  const n = await moveZOnPlusXFace('normal');
  t.check('Normal G,Z moves the +X face along its normal (world X)', dom(n) === 'x' && Math.abs(n.dx) > 0.05,
    `d=(${n.dx.toFixed(2)},${n.dy.toFixed(2)},${n.dz.toFixed(2)})`);
});
