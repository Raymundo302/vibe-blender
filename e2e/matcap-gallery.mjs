/**
 * Matcap gallery e2e (2026-07-16): the shading dropdown's thumbnail grid in
 * Matcap mode. Checks — the grid lists every registry entry, clicking Gold
 * turns the default cube WARM (center-pixel r−b margin vs the neutral Studio
 * baseline), the pref persists in shadePrefs + localStorage, the active thumb
 * is highlighted, and clicking Studio restores the neutral look.
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  await t.key('Escape', 'Escape'); // dismiss splash

  // Center-pixel probe: render one frame, average a small strip on the cube.
  const probe = () => t.evaluate(`(() => {
    const app = window.__app, gl = app.renderer.ctx.gl, c = gl.canvas;
    app.renderer.render(app.scene, app.camera);
    const w = c.width, h = c.height;
    const buf = new Uint8Array(24 * 24 * 4);
    gl.readPixels((w/2|0) - 12, (h/2|0) - 12, 24, 24, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < buf.length; i += 4) { r += buf[i]; g += buf[i+1]; b += buf[i+2]; }
    const n = buf.length / 4;
    return { r: r/n, g: g/n, b: b/n };
  })()`);

  t.check('default matcap pref is studio',
    (await t.evaluate('window.__app.shadePrefs.matcap')) === 'studio');
  const base = await probe();
  t.check(`studio baseline is neutral (r-b=${(base.r - base.b).toFixed(1)})`,
    Math.abs(base.r - base.b) < 12 && base.r > 40);

  // Open the shading dropdown (matcap is the default mode → gallery visible).
  await t.evaluate(`document.querySelector('.shading-menu-btn').click()`);
  await t.sleep(120);
  const thumbCount = await t.evaluate(`document.querySelectorAll('.shading-matcap-thumb').length`);
  t.check(`gallery lists all matcaps (${thumbCount})`, thumbCount === 13);
  t.check('gallery is visible in matcap mode',
    await t.evaluate(`document.querySelector('.shading-matcap-sub').style.display !== 'none'`));
  t.check('studio thumb is active',
    await t.evaluate(`document.querySelector('.shading-matcap-thumb[data-matcap="studio"]').classList.contains('shading-matcap-active')`));

  // Click Gold → texture loads async; poll the probe until the cube warms up.
  await t.evaluate(`document.querySelector('.shading-matcap-thumb[data-matcap="gold"]').click()`);
  t.check('pref switched to gold',
    (await t.evaluate('window.__app.shadePrefs.matcap')) === 'gold');
  let gold = null;
  for (let i = 0; i < 40; i++) {
    gold = await probe();
    if (gold.r - gold.b > 40) break;
    await t.sleep(100);
  }
  t.check(`gold matcap renders warm (r=${gold.r.toFixed(0)} b=${gold.b.toFixed(0)})`,
    gold.r - gold.b > 40);
  t.check('gold thumb is active now',
    await t.evaluate(`document.querySelector('.shading-matcap-thumb[data-matcap="gold"]').classList.contains('shading-matcap-active')`));

  // Persisted to localStorage (survives reload — check the stored blob).
  const stored = await t.evaluate(`(JSON.parse(localStorage.getItem('vibe-shading-v7') ?? '{}').matcap) ?? null`);
  t.check(`pref persisted to storage (${stored})`, stored === 'gold');

  // Switching to wireframe hides the gallery; back to matcap shows it.
  await t.evaluate(`document.querySelector('.shading-menu-mode[data-mode="wireframe"]').click()`);
  t.check('gallery hidden in wireframe mode',
    await t.evaluate(`document.querySelector('.shading-matcap-sub').style.display === 'none'`));
  await t.evaluate(`document.querySelector('.shading-menu-mode[data-mode="matcap"]').click()`);
  t.check('gallery back in matcap mode',
    await t.evaluate(`document.querySelector('.shading-matcap-sub').style.display !== 'none'`));

  // Back to Studio → neutral again (uses the cached texture, no reload wait).
  await t.evaluate(`document.querySelector('.shading-matcap-thumb[data-matcap="studio"]').click()`);
  await t.sleep(60);
  const back = await probe();
  t.check(`studio restores the neutral look (r-b=${(back.r - back.b).toFixed(1)})`,
    Math.abs(back.r - back.b) < 12);

  // Screenshot for Ray: gold matcap + open gallery.
  await t.evaluate(`document.querySelector('.shading-matcap-thumb[data-matcap="gold"]').click()`);
  for (let i = 0; i < 40; i++) {
    const p = await probe();
    if (p.r - p.b > 40) break;
    await t.sleep(100);
  }
  await t.screenshot('research/matcap-gallery.png');
});
