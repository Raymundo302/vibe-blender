/**
 * Grid z-fight fade (punch item). The ground grid (gridPass) sits on the z=0
 * plane; coplanar mesh faces there (e.g. the donut's Table) used to z-fight it
 * into high-frequency "dash" artifacts. The fix pushes the grid a FRACTIONAL
 * depth step AWAY from the eye (gridPass VERT, GRID_ZBIAS, opposite sign to
 * wirePass's pull) so exactly-coplanar faces win the depth fight cleanly and the
 * grid is hidden under them.
 *
 * Probe: a large plane at z=0 with the grid on, matcap shading (flat uniform
 * plane color — the plane normal is constant, so matcap is position-independent).
 * We sample a horizontal screen strip that stays WITHIN the plane's projection.
 *
 * PRIMARY (backend-robust) check — "grid behind geometry must hide": compare the
 * strip's mean luminance with the grid ON vs OFF. Post-fix the plane fully
 * occludes the coplanar grid, so ON == OFF. Pre-fix the grid wins the coplanar
 * depth fight and blends through, dragging the mean well below the clean plane.
 * Measured on SwiftShader (default backend): grid-OFF plane ≈ 196; grid-ON is
 * ≈ 196 fixed / ≈ 129 unfixed (a 67-luma gap = the grid bleeding through).
 *
 * SECONDARY (dash detector): count adjacent-sample luminance jumps + strip
 * stddev. On the real GPU (E2E_GPU=1) the pre-fix z-fight produces the classic
 * high-frequency "dash" alternation this catches; on SwiftShader the depth test
 * resolves deterministically (uniform bleed-through, few jumps) so this check is
 * quiet there — the ON-vs-OFF mean gap above is what fails pre-fix on SwiftShader.
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  await t.key('Escape', 'Escape', 0); // dismiss splash
  t.check('app booted', await t.until('!!window.__app'));

  // --- Scene: a single large plane at z=0, coplanar with the grid. ----------
  await t.evaluate(`(async () => {
    const S = window.__app.scene;
    const prim = await import('/src/core/mesh/primitives.ts');
    // Clear the default cube so nothing occludes / shadows the strip.
    for (const o of [...S.objects]) S.remove(o.id);
    S.add('Floor', prim.makePlane(40)); // 40 units across, sits exactly at z=0
    S.deselectAll(); // no gizmo/outline near the sampled pixels
    window.__app.renderer.shadingMode = 'matcap';
    const ov = (await import('/src/render/overlayPrefs.ts')).overlays;
    ov.grid = true;
    window.__gridOverlays = ov; // stash for synchronous e2e reads below
  })()`);
  t.check('probe scene: floor at z=0 landed',
    await t.until(`window.__app.scene.objects.length === 1 && window.__app.scene.objects[0].name === 'Floor'`));
  t.check('grid overlay handle stashed + on',
    await t.until(`!!window.__gridOverlays && window.__gridOverlays.grid === true`));

  // Look down at the floor at a moderate tilt so a horizontal screen strip
  // crosses many 1-unit grid lines while staying on the plane.
  await t.evaluate(`(() => {
    const cam = window.__app.camera;
    const V = window.__app.scene.objects[0]; // just to force module presence
    cam.yaw = 0.0; cam.pitch = 0.9; cam.distance = 14;
    cam.target = cam.target.constructor.ZERO;
  })()`);
  await t.sleep(120);

  // Sample a horizontal strip of device pixels centered on the canvas, spanning
  // the middle 50% of the width (stays within the 40-unit plane's projection).
  // Returns { jumps, std, mean, n }: `jumps` = adjacent samples differing by
  // more than THRESH luminance (the dash signature), `std` = strip stddev.
  const stripStats = () => t.evaluate(`(() => {
    const app = window.__app, gl = app.renderer.ctx.gl, c = gl.canvas;
    app.renderer.render(app.scene, app.camera);
    const y0 = Math.round(c.height * 0.5);
    const x0 = Math.round(c.width * 0.25);
    const w = Math.round(c.width * 0.5);
    const buf = new Uint8Array(w * 4);
    gl.readPixels(x0, y0, w, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const lum = [];
    for (let i = 0; i < w; i++) lum.push(0.2126*buf[i*4] + 0.7152*buf[i*4+1] + 0.0722*buf[i*4+2]);
    const THRESH = 12;
    let jumps = 0;
    for (let i = 1; i < lum.length; i++) if (Math.abs(lum[i] - lum[i-1]) > THRESH) jumps++;
    const n = lum.length;
    const mean = lum.reduce((a, b) => a + b, 0) / n;
    const std = Math.sqrt(lum.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n);
    return { jumps, std, mean, n };
  })()`);

  // Grid ON over the coplanar plane.
  const on = await stripStats();
  console.log(`grid ON  strip stats: ${JSON.stringify(on)}`);
  // Grid OFF: the clean plane color (the reference the fix must match).
  await t.evaluate(`window.__gridOverlays.grid = false`);
  await t.sleep(60);
  const off = await stripStats();
  console.log(`grid OFF strip stats: ${JSON.stringify(off)}`);
  await t.evaluate(`window.__gridOverlays.grid = true`); // restore

  t.check('probe sampled a real strip', on.n > 100, JSON.stringify(on));
  t.check('the strip sits on the lit plane (not empty background)', off.mean > 20, JSON.stringify(off));

  // PRIMARY: with the fix, the coplanar plane HIDES the grid → the grid-ON strip
  // matches the grid-OFF plane. Pre-fix the grid bleeds through and the mean
  // diverges hard (SwiftShader: ~67 luma). Robust on BOTH backends.
  const meanGap = Math.abs(on.mean - off.mean);
  t.check('coplanar grid is hidden under the plane (ON mean ≈ OFF mean)',
    meanGap < 12, `gap=${meanGap.toFixed(1)} on=${on.mean.toFixed(1)} off=${off.mean.toFixed(1)}`);

  // SECONDARY: the dash detector. Quiet on SwiftShader; catches the real-GPU
  // z-fight alternation. Post-fix the strip is uniform on every backend.
  t.check('no z-fight dashes on the coplanar plane (few luminance jumps)',
    on.jumps <= 4, JSON.stringify(on));
  t.check('grid-ON strip is near-uniform (low stddev)', on.std < 8, JSON.stringify(on));
});
