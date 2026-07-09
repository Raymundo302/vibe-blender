/**
 * P9-4 e2e — path tracer soft shadows, subsurface scattering, depth of field.
 * Builds a donut (torus) sitting on a floor + a grazing point light, drives the
 * Material tab to give the donut a warm SSS material, then proves the features
 * with PAIRED per-pixel measurements: every comparison band is defined on the
 * control frame and the same pixels are re-read in the feature frame.
 *
 * How the bands isolate each physical effect (see the P9-4 Result notes):
 *   - The donut material is warm (#e8b48c) and the floor is neutral grey, so a
 *     per-pixel R-B "warmth" split cleanly separates donut pixels (rb > 15) from
 *     floor pixels (rb < 8) on the CONTROL frame — no hard-coded crop, robust to
 *     Monte-Carlo noise (a colour ratio, not a single sample).
 *   - Soft shadows lift the FLOOR's cast-shadow penumbra: floor pixels whose
 *     control luminance sits in the mid band (40..120 — the shadow edge) get
 *     brighter when the area light samples its disc, while fully-lit floor
 *     (>170) is unchanged. A hard light (radius 0) leaves both identical → the
 *     check fails if the feature is off.
 *   - SSS makes the DONUT glow: the spec's wrapped-diffuse + dipped-continuation
 *     model lifts grazing-LIT donut pixels (control lum 110..220), tinted by the
 *     warm base colour, while the neutral fully-lit floor is unchanged (energy
 *     is redistributed on the donut, not added globally). Weight 0 → identical →
 *     the check fails.
 *   - DoF: opening the render-window aperture with a far focus plane blurs the
 *     scene → lower spatial variance across the crop.
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

  // --- Setup: a donut on a floor + a grazing point light ---
  // The light is low and to the side (z=1.2) so the donut is GRAZING-lit — that
  // is where the wrapped-diffuse SSS glow shows, and it casts a long soft floor
  // shadow with a wide penumbra for the soft-shadow check.
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
    floor.transform = floor.transform.withPosition(new floor.transform.position.constructor(0, 0, -0.3));
    // Donut.
    const torus = s.add('Donut', m.makeTorus());
    s.selectOnly(torus.id);
    // Grazing point light to the side so the donut casts a long floor shadow and
    // is lit at a shallow angle (the SSS glow region).
    const light = s.addLight('Light', 'point');
    light.light.power = 4000;
    light.light.radius = 0;
    light.transform = light.transform.withPosition(new light.transform.position.constructor(3.5, -2.5, 1.2));
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

  // Warm skin-ish base color via the UI so the SSS glow is tinted AND so donut
  // pixels are separable from the neutral floor by their R-B warmth.
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

  // --- Per-pixel readback over the central image crop ---------------------
  // Each grab returns per-pixel luminance + warmth (R-B) plus aggregate mean /
  // variance / litCount. We keep the full arrays in the page and only transfer
  // small scalars out; band comparisons run in-page against the stored control.
  await t.evaluate(`window.__grab = () => {
    const cv = window.__renderEngine.canvas();
    const ctx = cv.getContext('2d');
    const w = cv.width, h = cv.height;
    const x0 = Math.floor(w * 0.30), x1 = Math.floor(w * 0.70);
    const y0 = Math.floor(h * 0.30), y1 = Math.floor(h * 0.70);
    const d = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
    const n = d.length / 4;
    const lum = new Array(n), rb = new Array(n);
    let sum = 0, lit = 0;
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      const L = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      lum[j] = L; rb[j] = d[i] - d[i + 2];
      sum += L; if (L > 6) lit++;
    }
    const mean = sum / n;
    let variance = 0; for (const L of lum) variance += (L - mean) * (L - mean); variance /= n;
    return { lum, rb, mean, variance, litCount: lit };
  }; true`);

  // Render, wait for `minSample` accumulated passes, stash the grab under `key`
  // (full arrays stay in the page), then close the window.
  const renderInto = async (label, key, minSample) => {
    await t.evaluate('window.__renderEngine.start()');
    const ok = await t.until(`window.__renderEngine.sample() >= ${minSample}`, 90000);
    t.check(`${label}: render reaches >= ${minSample} samples`, ok);
    await t.evaluate(`window.__p9.${key} = window.__grab(); true`);
    await t.evaluate('window.__renderEngine.close()');
    await t.sleep(120);
  };

  // Paired band comparison: over pixels selected by `maskExpr` (uses the `rb`
  // warmth variable) whose CONTROL luminance is in [lo, hi), return the control
  // mean and the SAME pixels' mean in frame `toKey`.
  const compareBand = (toKey, maskExpr, lo, hi) => t.evaluate(`(() => {
    const A = window.__p9.ctrl, B = window.__p9.${toKey};
    let cs = 0, vs = 0, n = 0;
    for (let i = 0; i < A.lum.length; i++) {
      const rb = A.rb[i], c = A.lum[i];
      if ((${maskExpr}) && c >= ${lo} && c < ${hi}) { cs += c; vs += B.lum[i]; n++; }
    }
    return { n, from: n ? cs / n : 0, to: n ? vs / n : 0 };
  })()`);

  // Higher sample count than the raster checks: the paired band means over
  // thousands of pixels are stable, but the extra passes keep the effect well
  // above the noise floor.
  const SAMPLES = 16;

  // --- Control render: hard shadow (radius 0), no SSS (weight 0) ---
  await evalAsync(`(() => { window.__app.scene.get(window.__p9.lightId).light.radius = 0; })()`);
  await setSubsurface(0);
  await renderInto('control (hard, no SSS)', 'ctrl', SAMPLES);
  const ctrlLit = await t.evaluate('window.__p9.ctrl.litCount');
  t.check('control render produced lit pixels', ctrlLit > 200, `litCount=${ctrlLit}`);
  const masks = await t.evaluate(`(() => {
    const g = window.__p9.ctrl; let donut = 0, floor = 0;
    for (let i = 0; i < g.rb.length; i++) { if (g.rb[i] > 15) donut++; else if (g.rb[i] < 8) floor++; }
    return { donut, floor };
  })()`);
  t.check('warmth mask separates donut from floor',
    masks.donut > 1000 && masks.floor > 5000, `donut=${masks.donut} floor=${masks.floor}`);

  // --- Soft-shadow render: light radius > 0, still no SSS ---
  await evalAsync(`(() => { window.__app.scene.get(window.__p9.lightId).light.radius = 0.6; })()`);
  await renderInto('soft shadow (radius 0.6)', 'soft', SAMPLES);
  // Floor cast-shadow penumbra (control lum 40..120) lifts; fully-lit floor
  // (>170) is unchanged. Both are neutral floor pixels (rb < 8).
  const softPenumbra = await compareBand('soft', 'rb < 8', 40, 120);
  t.check('soft shadow lifts the floor penumbra (shadow-edge pixels brighten)',
    softPenumbra.n > 500 && softPenumbra.to > softPenumbra.from * 1.06,
    `n=${softPenumbra.n} ${softPenumbra.from.toFixed(2)} -> ${softPenumbra.to.toFixed(2)}`);
  const softLit = await compareBand('soft', 'rb < 8', 170, 256);
  t.check('soft shadow leaves fully-lit floor unchanged',
    softLit.n > 500 && Math.abs(softLit.to - softLit.from) < softLit.from * 0.03,
    `n=${softLit.n} ${softLit.from.toFixed(2)} -> ${softLit.to.toFixed(2)}`);

  // --- SSS render: radius back to 0, subsurface weight 1 ---
  await evalAsync(`(() => { window.__app.scene.get(window.__p9.lightId).light.radius = 0; })()`);
  await setSubsurface(1);
  await renderInto('subsurface (weight 1)', 'sss', SAMPLES);
  // Grazing-lit donut pixels (warm, control lum 110..220) glow brighter.
  const sssGlow = await compareBand('sss', 'rb > 15', 110, 220);
  t.check('SSS makes the grazing-lit donut glow brighter (weight 1 vs 0)',
    sssGlow.n > 1000 && sssGlow.to > sssGlow.from * 1.04,
    `n=${sssGlow.n} ${sssGlow.from.toFixed(2)} -> ${sssGlow.to.toFixed(2)}`);
  // The glow is a MATERIAL effect: the neutral fully-lit floor is unchanged
  // (energy is redistributed on the donut, not added globally).
  const sssFloor = await compareBand('sss', 'rb < 8', 170, 256);
  t.check('SSS does not brighten the neutral floor (glow is local to the donut)',
    sssFloor.n > 500 && Math.abs(sssFloor.to - sssFloor.from) < sssFloor.from * 0.03,
    `n=${sssFloor.n} ${sssFloor.from.toFixed(2)} -> ${sssFloor.to.toFixed(2)}`);

  await t.screenshot('/tmp/p9-render2-sss.png');

  // --- Depth of field: pinhole vs open aperture (needs low noise → 40 samples) ---
  await setSubsurface(0);
  await t.evaluate(`window.__app.scene.get(window.__p9.lightId).light.radius = 0`);
  await t.evaluate('window.__renderEngine.setAperture(0)');
  await renderInto('pinhole', 'sharp', 40);
  // Focus plane far past the donut + a wide aperture → strong defocus blur.
  await t.evaluate('window.__renderEngine.setFocusDistance(60)');
  await t.evaluate('window.__renderEngine.setAperture(1.2)');
  await renderInto('open aperture', 'blurred', 40);
  const sharpVar = await t.evaluate('window.__p9.sharp.variance');
  const blurVar = await t.evaluate('window.__p9.blurred.variance');
  t.check('open aperture blurs the off-focus scene (lower spatial variance)',
    blurVar < sharpVar * 0.9,
    `variance ${sharpVar.toFixed(1)} -> ${blurVar.toFixed(1)}`);

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
