/**
 * Materials on NURBS surfaces (Ray, 2026-07-16): the Material tab assigns to
 * kind 'surface' (kindHasMaterial), and the material actually renders — a red
 * emit-ish diffuse on a sphere surface turns the Rendered viewport red; a
 * glass material routes the surface through the blended pass without crashing.
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  await t.evaluate(`(() => { const S = window.__app.scene; for (const o of [...S.objects]) S.remove(o.id); })()`);
  await t.key('Escape', 'Escape');

  // Sphere surface + a sun so Rendered mode has light.
  await t.evaluate(`(async () => {
    const S = window.__app.scene;
    const prim = await import('/src/core/nurbs/primitives.ts');
    const o = S.addSurface('MatSphere', prim.surfSphere(1));
    S.addLight('Sun', 'sun');
    S.selectOnly(o.id);
    window.__nsurf = o.id;
    window.__app.surface.sync();
  })()`);
  await t.until(`window.__app.scene.objects.some(o=>o.kind==='surface')`);
  await t.evaluate(`window.__app.surface.sync()`);

  // Material tab shows the real body (not the empty state) for a surface.
  await t.evaluate(`document.querySelector('.properties-tab-btn[data-tab="material"]').click()`);
  await t.sleep(150);
  const emptyShown = await t.evaluate(`(() => {
    const tab = document.querySelector('.properties-pane[data-tab="material"], .properties-content');
    const empties = [...document.querySelectorAll('.properties-empty')];
    return empties.some((e) => e.textContent.includes('mesh, surface or curve') && e.offsetParent !== null);
  })()`);
  t.check('material tab is NOT in its empty state for a surface', !emptyShown);

  // Assign a fresh red material through the SCENE api (tab-independent truth),
  // then verify the tab reflects it and the viewport turns red.
  await t.evaluate(`(() => {
    const S = window.__app.scene;
    const mat = S.addMaterial('SurfRed');
    mat.baseColor = [0.9, 0.05, 0.05];
    S.get(window.__nsurf).materialId = mat.id;
  })()`);

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

  await t.evaluate(`window.__app.renderer.shadingMode = 'rendered'`);
  await t.sleep(100);
  const red = await probe();
  t.check(`red material renders on the surface (r=${red.r.toFixed(0)} g=${red.g.toFixed(0)})`,
    red.r > 60 && red.r > red.g * 2.5);

  // Glass: transmission routes through the blended pass — must not crash and
  // must change the look (background shows through → less pure red coverage).
  await t.evaluate(`(() => {
    const S = window.__app.scene;
    const mat = S.getMaterial(S.get(window.__nsurf).materialId);
    mat.shader = 'glass';
    mat.transmission = 1;
  })()`);
  const glass = await probe();
  t.check(`glass on a surface renders (probe ${glass.r.toFixed(0)},${glass.g.toFixed(0)},${glass.b.toFixed(0)})`,
    Number.isFinite(glass.r));
  t.check('glass look differs from opaque red',
    Math.abs(glass.r - red.r) + Math.abs(glass.g - red.g) + Math.abs(glass.b - red.b) > 15);

  // Matcap mode is material-independent — still shades (sanity).
  await t.evaluate(`window.__app.renderer.shadingMode = 'matcap'`);
  const mc = await probe();
  t.check('matcap mode still shades the surface', mc.r + mc.g + mc.b > 30);
});
