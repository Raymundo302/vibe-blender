/**
 * NURBS surface edit mode e2e (NB-A2). Covers: adding a surface object, Tab
 * entering SURFACE edit (control net, not mesh edit), the net overlay drawing
 * pixels (dots + hull lines), click-select + selectPoint, a scripted G-move
 * displacing a control point AND the tessellated mesh, one-undo restoring both
 * payload and mesh, and Tab exiting.
 *
 * Follows e2e/curves.mjs harness patterns + the E2E_PORT convention.
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  // Default render engine is GPU; this is a CPU-path suite — pin CPU.
  await t.until('!!window.__renderEngine');
  await t.evaluate("window.__renderEngine.setEngine('cpu')");
  const rect = await t.evaluate('(() => { const r = document.querySelector("canvas").getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()');

  const editing = () => t.evaluate('window.__app.surface.editing()');
  const pointCount = () => t.evaluate('window.__app.surface.pointCount()');
  const selection = () => t.evaluate('window.__app.surface.selection()');
  const co = (i) => t.evaluate(`(() => {
    const S = window.__app.scene, o = S.surfaceEditObject || S.objects.find(x=>x.kind==='surface');
    return o ? o.surface.points[${i}].co.slice() : null;
  })()`);

  // Flat [x,y,z,...] of the surface's tessellated mesh verts (deterministic
  // order/count for a fixed tess, so index-by-index deltas measure the change).
  const meshVerts = () => t.evaluate(`(() => {
    const S = window.__app.scene, o = S.surfaceEditObject || S.objects.find(x=>x.kind==='surface');
    const out = []; for (const v of o.mesh.verts.values()) out.push(v.co.x, v.co.y, v.co.z);
    return out;
  })()`);
  const maxDelta = (a, b) => {
    let m = 0; const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
    return m;
  };

  // Project a world point (surface spawns at identity, so local == world) to
  // page (CSS) coords for a real click/drag.
  const projectPage = (wx, wy, wz) => t.evaluate(`(() => {
    const app = window.__app;
    const r = document.querySelector('canvas').getBoundingClientRect();
    const vp = app.renderer.currentViewProj(app.scene, app.camera).m;
    const cx = vp[0]*${wx} + vp[4]*${wy} + vp[8]*${wz} + vp[12];
    const cy = vp[1]*${wx} + vp[5]*${wy} + vp[9]*${wz} + vp[13];
    const cw = vp[3]*${wx} + vp[7]*${wy} + vp[11]*${wz} + vp[15];
    return { x: r.left + (cx/cw*0.5+0.5) * r.width, y: r.top + (1-(cy/cw*0.5+0.5)) * r.height };
  })()`);

  // Count strongly-ORANGE pixels over the whole canvas — the selected control
  // dots. The matcap surface + grey hull lines are neutral (R≈G≈B), so an
  // R>>B, R>G test isolates the selection dots from everything else.
  const orangePixels = () => t.evaluate(`(() => {
    const app = window.__app, gl = app.renderer.ctx.gl, c = gl.canvas;
    app.renderer.render(app.scene, app.camera);
    const buf = new Uint8Array(c.width * c.height * 4);
    gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let n = 0;
    for (let i = 0; i < buf.length; i += 4) {
      if (buf[i] > 150 && (buf[i] - buf[i+2]) > 45 && (buf[i] - buf[i+1]) > 8) n++;
    }
    return n;
  })()`);

  // Clean slate: drop the default cube so the surface stands alone.
  await t.evaluate(`(() => { const S = window.__app.scene; for (const o of [...S.objects]) S.remove(o.id); })()`);
  await t.key('Escape', 'Escape'); // dismiss splash

  // --- Add a surface object, tessellate it -----------------------------------
  await t.evaluate(`(async () => {
    const S = window.__app.scene;
    const od = await import('/src/core/scene/objectData.ts');
    const s = S.addSurface('Surface', od.defaultSurfaceData());
    S.selectOnly(s.id);
    window.__app.surface.sync();
  })()`);
  // The add is an async IIFE (dynamic import) — wait until the surface exists.
  await t.until(`window.__app.scene.objects.some(o=>o.kind==='surface')`);
  await t.evaluate('window.__app.surface.sync()');
  t.check('surface object added', (await t.evaluate(`window.__app.scene.objects.filter(o=>o.kind==='surface').length`)) === 1);
  t.check('surface tessellated a mesh', (await meshVerts()).length > 0);

  // --- Tab enters SURFACE edit (not mesh edit) -------------------------------
  await t.key('Tab', 'Tab');
  t.check('Tab enters surface edit', (await editing()) === true);
  t.check('no mesh edit mode', (await t.evaluate('window.__app.scene.editMode === null')));
  t.check('surface has a 4x4 control net', (await pointCount()) === 16);

  // --- The net overlay draws pixels ------------------------------------------
  // Select a spread of points so orange dots appear across the net.
  await t.evaluate('window.__app.surface.selectPoint(0)');
  await t.evaluate('window.__app.surface.selectPoint(5)');
  await t.evaluate('window.__app.surface.selectPoint(15)');
  const dotsPx = await orangePixels();
  t.check('selected net dots draw orange pixels', dotsPx > 12, `orangePx=${dotsPx}`);

  // Eyes-on: the surface in edit mode showing dots + hull lines.
  await t.key('a', 'KeyA'); // select all → every dot orange
  await t.sleep(40);
  await t.evaluate('window.__app.renderer.render(window.__app.scene, window.__app.camera)');
  await t.screenshot('research/nurbs-net.png');
  const allDotsPx = await orangePixels();
  t.check('net overlay is clearly visible (dots present)', allDotsPx > 40, `orangePx=${allDotsPx}`);

  // --- Click select picks a net point ----------------------------------------
  await t.evaluate('window.__app.scene.surfaceEdit.clearSelection()');
  const p5page = await projectPage(...(await co(5)));
  await t.click(p5page.x, p5page.y);
  t.check('click selects the nearest net point', (await selection()).includes(5), `sel=${JSON.stringify(await selection())}`);

  // --- Scripted G-move displaces point 5 + the mesh --------------------------
  await t.evaluate('window.__app.scene.surfaceEdit.clearSelection()');
  await t.evaluate('window.__app.surface.selectPoint(5)');
  const co5Before = await co(5);
  const vertsBefore = await meshVerts();
  const anchor = await projectPage(...co5Before);
  await t.mouse('mouseMoved', anchor.x, anchor.y); // seat the cursor
  await t.sleep(30);
  await t.key('g', 'KeyG');
  await t.sleep(40);
  t.check('G starts a surface Move', (await t.evaluate('window.__app.input.activeOperatorName')) === 'Move');
  await t.mouse('mouseMoved', anchor.x, anchor.y - 90); // drag up
  await t.sleep(40);
  await t.mouse('mouseMoved', anchor.x, anchor.y - 90);
  await t.sleep(40);
  await t.mouse('mousePressed', anchor.x, anchor.y - 90, 'left');
  await t.mouse('mouseReleased', anchor.x, anchor.y - 90, 'left');
  await t.sleep(80);
  const co5After = await co(5);
  t.check('G moved control point 5', JSON.stringify(co5After) !== JSON.stringify(co5Before));

  // Mesh re-tessellates from the moved payload.
  await t.evaluate('window.__app.surface.sync()');
  const vertsAfter = await meshVerts();
  const dMesh = maxDelta(vertsBefore, vertsAfter);
  t.check('tessellated mesh changed after the move', dMesh > 1e-3, `maxVertDelta=${dMesh.toFixed(4)}`);

  // --- One undo restores BOTH payload and mesh -------------------------------
  await t.key('z', 'KeyZ', 2); // ctrl+z
  await t.sleep(80);
  const co5Undo = await co(5);
  t.check('undo restores the control point', JSON.stringify(co5Undo) === JSON.stringify(co5Before));
  await t.evaluate('window.__app.surface.sync()');
  const vertsUndo = await meshVerts();
  t.check('undo restores the tessellated mesh', maxDelta(vertsBefore, vertsUndo) < 1e-4,
    `maxVertDelta=${maxDelta(vertsBefore, vertsUndo).toFixed(6)}`);

  // --- Tab exits surface edit ------------------------------------------------
  await t.key('Tab', 'Tab');
  t.check('Tab exits surface edit', (await editing()) === false);

  // --- Regression: Tab on a cube is still MESH edit --------------------------
  await t.evaluate(`(async () => {
    const S = window.__app.scene;
    for (const o of [...S.objects]) S.remove(o.id);
    const prim = await import('/src/core/mesh/primitives.ts');
    const cube = S.add('Cube', prim.makeCube());
    S.selectOnly(cube.id);
  })()`);
  t.check('cube ready', await t.until(`window.__app.scene.objects.some(o => o.name === 'Cube')`));
  await t.key('Tab', 'Tab');
  t.check('Tab on a cube enters MESH edit (not surface edit)',
    (await t.evaluate('window.__app.scene.mode')) === 'edit' && (await editing()) === false);
  await t.key('Tab', 'Tab');
});
