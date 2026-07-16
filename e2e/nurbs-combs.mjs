/**
 * Curvature combs e2e (NB-B1). Adds a Bezier Circle curve (radius 1 in XY),
 * then drives the N-panel "Curvature Comb" subsection through the REAL DOM:
 *   - comb OFF: no accent (teal) comb pixels.
 *   - Show Comb ON: a larger concentric porcupine of teal teeth + envelope
 *     appears — teal pixels jump from ~0 to many (the teeth stick OUTSIDE the
 *     curve's radius, so they're all accent-colored, not the orange curve).
 *   - Scale doubled (1 → 2): the teeth reach farther, so the teal pixel spread
 *     grows.
 * Screenshots saved to research/nurbs-combs-{off,on}.png with pixel evidence.
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  await t.until('!!window.__app');
  // Pin the CPU path (matches curves.mjs) for deterministic SwiftShader pixels.
  await t.until('!!window.__renderEngine');
  await t.evaluate("window.__renderEngine.setEngine('cpu')");

  const cv = (fx, fy) => t.evaluate(`(() => {
    const r = document.querySelector('canvas').getBoundingClientRect();
    return [Math.round(r.left + r.width*${fx}), Math.round(r.top + r.height*${fy})];
  })()`);

  // Count accent (teal) comb pixels over the WHOLE canvas: the comb teeth +
  // envelope render in teal (blue >> red), distinct from the orange selected
  // curve (red > blue), the neutral grey grid (r≈g≈b), and the dark background.
  // Every tooth sticks OUTSIDE the circle's radius, so a non-zero teal count =
  // comb geometry drawn beyond the curve.
  const tealCount = () => t.evaluate(`(() => {
    const app = window.__app, gl = app.renderer.ctx.gl, c = gl.canvas;
    app.renderer.render(app.scene, app.camera);
    const buf = new Uint8Array(c.width * c.height * 4);
    gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let n = 0;
    for (let i = 0; i < buf.length; i += 4) {
      const r = buf[i], g = buf[i+1], b = buf[i+2];
      // Teal accent: high G *and* high B over low R. The (g-r)>55 gate rejects
      // the bluish Z-axis line / gizmo arrow (blue but only moderately green).
      if (b > 90 && g > 90 && (b - r) > 40 && (g - r) > 55) n++;
    }
    return n;
  })()`);

  // Clean slate: drop the default cube, dismiss the splash.
  await t.evaluate(`(() => { const S = window.__app.scene; for (const o of [...S.objects]) S.remove(o.id); })()`);
  await t.key('Escape', 'Escape');

  // --- Add a Bezier Circle via the real Shift+A ▸ Curve ▸ Circle menu --------
  const [mx, my] = await cv(0.5, 0.5);
  await t.mouse('mouseMoved', mx, my);
  await t.key('A', 'KeyA', 8); // shift
  await t.sleep(60);
  await t.evaluate(`(() => {
    document.querySelector('.add-menu-category[data-category="Curve"]').click();
    const item = [...document.querySelectorAll('.add-menu-flyout .add-menu-item')].find(b => b.textContent === 'Circle');
    item.click();
  })()`);
  await t.sleep(80);
  t.check('curve added and active', (await t.evaluate('window.__app.scene.activeObject && window.__app.scene.activeObject.kind')) === 'curve');

  // --- Comb OFF baseline -----------------------------------------------------
  const off = await tealCount();
  await t.screenshot('research/nurbs-combs-off.png');
  t.check('comb OFF: no teal comb pixels', off < 30, `teal=${off}`);

  // --- Open the N-panel and toggle Show Comb ON ------------------------------
  await t.key('n', 'KeyN');
  await t.sleep(80);
  t.check('Curvature Comb "Show Comb" checkbox present',
    (await t.evaluate(`!!document.querySelector('input[data-action="curve-comb-on"]')`)));
  t.check('Scale field defaults to 1',
    (await t.evaluate(`document.querySelector('input[data-field="curve-comb-scale"]').value`)) === '1');
  t.check('Samples field defaults to 64',
    (await t.evaluate(`document.querySelector('input[data-field="curve-comb-samples"]').value`)) === '64');

  await t.evaluate(`(() => {
    const el = document.querySelector('input[data-action="curve-comb-on"]');
    el.checked = true;
    el.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(60);
  const on = await tealCount();
  await t.screenshot('research/nurbs-combs-on.png');
  t.check('comb ON draws teal comb pixels (a larger concentric ring)', on > off + 200, `off=${off} on=${on}`);
  t.check('comb pref persisted on', (await t.evaluate('window.__app.scene.activeObject.id !== undefined')));

  // --- Scale doubled → the teeth reach farther, teal spread grows ------------
  await t.evaluate(`(() => {
    const el = document.querySelector('input[data-field="curve-comb-scale"]');
    el.value = '2';
    el.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(60);
  const on2 = await tealCount();
  t.check('scale doubled → teal pixel spread grows', on2 > on, `on(scale1)=${on} on(scale2)=${on2}`);

  console.log(`PIXELS  off=${off}  on(scale1)=${on}  on(scale2)=${on2}`);
});
