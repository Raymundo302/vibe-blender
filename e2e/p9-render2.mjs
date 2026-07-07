/**
 * P9-4 e2e — path tracer soft shadows, subsurface scattering, depth of field.
 * Builds a donut (torus) on a floor + a point light, drives the Material tab to
 * give the donut an SSS material, then proves via pixel comparison that:
 *   - a soft-shadow render (light radius > 0) fills the shadow edge (the darkest
 *     lit pixels get brighter) vs a hard control,
 *   - an SSS render (subsurface weight 1) brightens the donut's dim/terminator
 *     pixels vs weight 0,
 *   - opening the render-window aperture blurs the off-focus scene (lower
 *     spatial contrast / variance on the silhouette).
 * Esc still terminates the worker cleanly.
 *
 * Run with the dev server up:
 *   flock /tmp/vibe-blender-e2e.lock node e2e/p9-render2.mjs
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  // Runtime.evaluate with awaitPromise so we can `await import(...)` the
  // primitives module in the page to build the torus + floor.
  const evalAsync = async (expression) => {
    const { result, exceptionDetails } = await t.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (exceptionDetails) throw new Error(`page threw: ${exceptionDetails.text}`);
    return result.value;
  };

  // --- Setup: a donut on a floor + a point light up-and-to-the-side ---
  await t.evaluate(`document.querySelector('.wsp-tab[data-workspace="Layout"]')?.click()`);
  await t.sleep(150);
  const nObjs = await evalAsync(`(async () => {
    const s = window.__app.scene;
    if (s.editMode) s.exitEditMode();
    for (const o of [...s.objects]) s.remove(o.id);
    for (const mm of [...s.materials]) s.removeMaterial(mm.id);
    const m = await import('/src/core/mesh/primitives.ts');
    // Floor: a big plane just under the donut to catch its shadow.
    const floor = s.add('Floor', m.makePlane(9));
    floor.transform = floor.transform.withPosition(new floor.transform.position.constructor(0, -0.3, 0));
    // Donut.
    const torus = s.add('Donut', m.makeTorus());
    s.selectOnly(torus.id);
    // Bright point light above-and-to-the-side so the donut casts a floor shadow.
    const light = s.addLight('Light', 'point');
    light.light.power = 9000;
    light.light.radius = 0;
    light.transform = light.transform.withPosition(new light.transform.position.constructor(2.5, 5, 1.5));
    window.__p9 = { torusId: torus.id, lightId: light.id };
    return s.objects.length;
  })()`);
  t.check('scene has floor + donut + light', nObjs === 3);

  // --- SSS material via the Material tab UI (New + subsurface slider) ---
  t.check('Material tab button exists',
    await t.until(`!!document.querySelector('.properties-tab-btn[data-tab="material"]')`, 5000));
  await t.evaluate(`document.querySelector('.properties-tab-btn[data-tab="material"]').click()`);
  await t.sleep(140);
  await t.evaluate(`document.querySelector('.material-tab-new-btn').click()`);
  await t.sleep(160);
  t.check('New material assigned to the donut',
    (await t.evaluate('window.__app.scene.activeObject.materialId')) !== null);
  const matId = await t.evaluate('window.__app.scene.activeObject.materialId');

  // Warm skin-ish base color via the UI so the SSS glow is tinted.
  await t.evaluate(`(() => {
    const inp = document.querySelector('.material-tab-basecolor');
    inp.value = '#e8b48c';
    inp.dispatchEvent(new Event('input'));
    inp.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(100);

  // Drive the subsurface WEIGHT slider through the UI (proves the tab wiring).
  const setSubsurface = async (w) => {
    await t.evaluate(`(() => {
      const inp = document.querySelector('.material-tab-subsurface');
      inp.value = '${w}';
      inp.dispatchEvent(new Event('input'));
      inp.dispatchEvent(new Event('change'));
    })()`);
    await t.sleep(80);
  };
  await setSubsurface(0.9);
  t.check('subsurface weight committed via the Material tab',
    Math.abs((await t.evaluate(`window.__app.scene.getMaterial(${matId}).subsurfaceWeight`)) - 0.9) < 1e-6);
  await t.evaluate(`(() => {
    const inp = document.querySelector('.material-tab-subsurface-radius');
    inp.value = '0.3';
    inp.dispatchEvent(new Event('input'));
    inp.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(80);
  t.check('SSS radius committed via the Material tab',
    Math.abs((await t.evaluate(`window.__app.scene.getMaterial(${matId}).subsurfaceRadius`)) - 0.3) < 1e-6);

  // --- Readback: luminance stats over the central image crop ---
  // mean = whole crop; darkMean = darkest quartile of lit-ish pixels (the
  // shadow edge + terminator — the regions soft shadows and SSS lift); variance
  // = spatial contrast (a blurred image has less).
  const stats = () => t.evaluate(`(() => {
    const cv = window.__renderEngine.canvas();
    const ctx = cv.getContext('2d');
    const w = cv.width, h = cv.height;
    const x0 = Math.floor(w * 0.30), x1 = Math.floor(w * 0.70);
    const y0 = Math.floor(h * 0.30), y1 = Math.floor(h * 0.70);
    const d = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
    const lums = [];
    for (let i = 0; i < d.length; i += 4) lums.push(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]);
    const mean = lums.reduce((s, v) => s + v, 0) / lums.length;
    let variance = 0;
    for (const v of lums) variance += (v - mean) * (v - mean);
    variance /= lums.length;
    const lit = lums.filter((v) => v > 6).sort((a, b) => a - b);
    const q = lit.slice(0, Math.max(1, Math.floor(lit.length * 0.25)));
    const darkMean = q.length ? q.reduce((s, v) => s + v, 0) / q.length : 0;
    return { mean, darkMean, variance, litCount: lit.length };
  })()`);

  // Render, wait for `minSample` accumulated passes, read stats, close.
  const renderRead = async (label, minSample) => {
    await t.evaluate('window.__renderEngine.start()');
    const ok = await t.until(`window.__renderEngine.sample() >= ${minSample}`, 90000);
    t.check(`${label}: render reaches >= ${minSample} samples`, ok);
    const r = await stats();
    await t.evaluate('window.__renderEngine.close()');
    await t.sleep(120);
    return r;
  };

  // --- Control render: hard shadow (radius 0), no SSS (weight 0) ---
  await evalAsync(`(() => { window.__app.scene.get(window.__p9.lightId).light.radius = 0; })()`);
  await setSubsurface(0);
  const control = await renderRead('control (hard, no SSS)', 12);
  t.check('control render produced lit pixels', control.litCount > 200,
    `litCount=${control.litCount}`);

  // --- Soft-shadow render: light radius > 0, still no SSS ---
  await evalAsync(`(() => { window.__app.scene.get(window.__p9.lightId).light.radius = 0.6; })()`);
  const soft = await renderRead('soft shadow (radius 0.6)', 12);
  t.check('soft shadow lifts the shadow-edge (darkest lit) pixels',
    soft.darkMean > control.darkMean * 1.05,
    `darkMean ${control.darkMean.toFixed(2)} -> ${soft.darkMean.toFixed(2)}`);

  // --- SSS render: radius back to 0, subsurface weight 1 ---
  await evalAsync(`(() => { window.__app.scene.get(window.__p9.lightId).light.radius = 0; })()`);
  await setSubsurface(1);
  const sss = await renderRead('subsurface (weight 1)', 12);
  t.check('SSS brightens the donut terminator (grazing glow) vs weight 0',
    sss.darkMean > control.darkMean * 1.05,
    `darkMean ${control.darkMean.toFixed(2)} -> ${sss.darkMean.toFixed(2)}`);

  await t.screenshot('/tmp/p9-render2-sss.png');

  // --- Depth of field: pinhole vs open aperture (needs low noise → 40 samples) ---
  await setSubsurface(0);
  await t.evaluate(`window.__app.scene.get(window.__p9.lightId).light.radius = 0`);
  await t.evaluate('window.__renderEngine.setAperture(0)');
  const sharp = await renderRead('pinhole', 40);
  // Focus plane far past the donut + a wide aperture → strong defocus blur.
  await t.evaluate('window.__renderEngine.setFocusDistance(60)');
  await t.evaluate('window.__renderEngine.setAperture(1.2)');
  const blurred = await renderRead('open aperture', 40);
  t.check('open aperture blurs the off-focus scene (lower spatial variance)',
    blurred.variance < sharp.variance * 0.9,
    `variance ${sharp.variance.toFixed(1)} -> ${blurred.variance.toFixed(1)}`);

  await t.screenshot('/tmp/p9-render2-dof.png');

  // --- Esc terminates the worker cleanly ---
  await t.evaluate('window.__renderEngine.setAperture(0)');
  await t.evaluate('window.__renderEngine.setFocusDistance(null)');
  await t.evaluate('window.__renderEngine.start()');
  await t.until('window.__renderEngine.sample() >= 2', 30000);
  await t.key('Escape', 'Escape', 0);
  await t.sleep(150);
  t.check('Esc closes the render window', (await t.evaluate('window.__renderEngine.isOpen()')) === false);
  const s1 = await t.evaluate('window.__renderEngine.sample()');
  await t.sleep(700);
  const s2 = await t.evaluate('window.__renderEngine.sample()');
  t.check('worker stopped after Esc: sample count frozen', s1 === s2, `${s1} -> ${s2}`);

  // --- Cleanup: restore a plain default scene ---
  await t.evaluate(`(() => {
    const s = window.__app.scene;
    for (const o of [...s.objects]) s.remove(o.id);
    for (const m of [...s.materials]) s.removeMaterial(m.id);
  })()`);
  await t.evaluate('window.__app.autosave.clear()');
});
