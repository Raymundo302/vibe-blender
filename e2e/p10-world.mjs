/**
 * P10-4 e2e — World environment (flat / gradient / HDRI).
 * Run with the dev server up:
 *   flock /tmp/vibe-blender-e2e.lock node e2e/p10-world.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runE2e } from './harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));

runE2e(async (t) => {
  // UR12-3: default render engine is GPU; these are CPU-path regression suites — pin CPU.
  await t.until('!!window.__renderEngine');
  await t.evaluate("window.__renderEngine.setEngine('cpu')");
  // Snapshot a clean scene so the suite can restore it at the end.
  const saved = await t.evaluate('window.__app.io.serialize()');

  // --- World tab is present with NO selection (world is scene state) ---
  await t.evaluate('window.__app.scene.deselectAll()');
  await t.sleep(60);
  t.check('World tab button exists in the properties editor',
    await t.evaluate(`!!document.querySelector('[data-tab="world"]')`));
  t.check('World tab mode select is built even with nothing selected',
    await t.evaluate(`!!document.querySelector('.world-tab-mode')`));
  t.check('debug __world handle present',
    (await t.evaluate('typeof window.__world === "object"')) === true);

  // --- Flat red → the Rendered viewport background reads red ---
  await t.evaluate(`(() => {
    const w = window.__app.scene.world;
    w.mode = 'flat';
    w.color = [1, 0, 0];
    w.strength = 1;
    window.__app.renderer.shadingMode = 'rendered';
  })()`);
  await t.sleep(80);

  const bgPixel = () => t.evaluate(`(() => {
    const app = window.__app, gl = app.renderer.ctx.gl, c = gl.canvas;
    app.renderer.render(app.scene, app.camera);
    const px = new Uint8Array(4);
    // Top-left corner = above the horizon = pure sky (never the cube or grid).
    gl.readPixels(4, c.height - 4, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return [px[0], px[1], px[2]];
  })()`);

  await t.screenshot('/tmp/p10-world-flat.png');
  const bg = await bgPixel();
  t.check('rendered viewport background is red',
    bg[0] > 120 && bg[0] > bg[1] + 60 && bg[0] > bg[2] + 60, `rgb(${bg.join(', ')})`);

  // --- F12 render's sky pixels also read red ---
  await t.evaluate('window.__renderEngine.start()');
  const rendered = await t.until('window.__renderEngine.sample() >= 4', 40000);
  t.check('F12 render accumulates samples', rendered);
  const skyPixel = await t.evaluate(`(() => {
    const cv = window.__renderEngine.canvas();
    const ctx = cv.getContext('2d');
    // Top-left of the render = sky (geometry is centered).
    const d = ctx.getImageData(2, 2, 1, 1).data;
    return [d[0], d[1], d[2]];
  })()`);
  t.check('F12 render sky pixel is red',
    skyPixel[0] > 120 && skyPixel[0] > skyPixel[1] + 60 && skyPixel[0] > skyPixel[2] + 60,
    `rgb(${skyPixel.join(', ')})`);
  await t.evaluate('window.__renderEngine.close()');
  await t.sleep(120);

  // --- Gradient mode round-trips through save/load ---
  await t.evaluate(`(() => {
    const w = window.__app.scene.world;
    w.mode = 'gradient';
    w.horizon = [0.1, 0.2, 0.3];
    w.zenith = [0.4, 0.5, 0.6];
  })()`);
  const gjson = await t.evaluate('window.__app.io.serialize()');
  await t.evaluate(`window.__app.io.apply(${JSON.stringify(gjson)})`);
  await t.sleep(80);
  t.check('gradient world survives save/load',
    await t.evaluate(`(() => {
      const w = window.__app.scene.world;
      return w.mode === 'gradient' &&
        w.horizon[0] === 0.1 && w.horizon[2] === 0.3 &&
        w.zenith[0] === 0.4 && w.zenith[2] === 0.6;
    })()`));

  // --- Undo restores the previous mode ---
  // Start from flat (no command), then switch to hdri-less 'gradient' via the
  // select (pushes a command), then undo → back to flat.
  await t.evaluate(`window.__app.scene.world.mode = 'flat'`);
  await t.evaluate(`(() => {
    const sel = document.querySelector('.world-tab-mode');
    sel.value = 'gradient';
    sel.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(80);
  t.check('mode select changed the world to gradient',
    (await t.evaluate('window.__app.scene.world.mode')) === 'gradient');
  await t.key('z', 'KeyZ', 2); // Ctrl+Z
  await t.sleep(120);
  t.check('undo restores the previous world mode (flat)',
    (await t.evaluate('window.__app.scene.world.mode')) === 'flat');

  // --- HDRI: drive the internal load with a generated equirect data URL ---
  await t.evaluate(`(() => {
    const cv = document.createElement('canvas');
    cv.width = 8; cv.height = 4;
    const c = cv.getContext('2d');
    c.fillStyle = '#3070ff'; c.fillRect(0, 0, 8, 4);
    const url = cv.toDataURL('image/png');
    window.__hdriDone = false;
    window.__world.loadHdri(url).then(() => { window.__hdriDone = true; });
  })()`);
  const hdriLoaded = await t.until('window.__hdriDone === true', 10000);
  t.check('internal HDRI load resolved', hdriLoaded);
  t.check('world is now HDRI with decoded pixels + packed data URL',
    await t.evaluate(`(() => {
      const w = window.__app.scene.world;
      return w.mode === 'hdri' &&
        typeof w.hdri === 'string' && w.hdri.startsWith('data:image/png') &&
        !!w.hdriImage && w.hdriImage.width === 8 && w.hdriImage.data.length === 8 * 4 * 3;
    })()`));

  // Undo the HDRI load → back to flat (the mode before the load).
  await t.key('z', 'KeyZ', 2);
  await t.sleep(120);
  t.check('undo of HDRI load restores the prior mode',
    (await t.evaluate('window.__app.scene.world.mode')) === 'flat');

  // --- Old scene (no world key) loads with the default gradient world ---
  // FROZEN pre-P10-4 fixture: research/donut.vibe.json is REGENERATED by
  // donut.mjs with the current serializer, so it legitimately grows new keys
  // (world, texKind, ...). This copy is pinned at tag p9-donut-2026-07-06.
  const donut = readFileSync(join(here, 'fixtures', 'donut-p9-frozen.vibe.json'), 'utf8');
  t.check('donut fixture has no world key (pre-P10-4 file)', !JSON.parse(donut).world);
  const donutOk = await t.evaluate(`(() => {
    try {
      window.__app.io.apply(${JSON.stringify(donut)});
      const w = window.__app.scene.world;
      return w.mode === 'gradient' && w.hdri === null;
    } catch (e) { return 'THREW: ' + e.message; }
  })()`);
  t.check('donut loads with the default gradient world (no throw)', donutOk === true, String(donutOk));

  // --- Restore the clean scene + matcap shading ---
  await t.evaluate(`window.__app.renderer.shadingMode = 'matcap'`);
  await t.evaluate(`window.__app.io.apply(${JSON.stringify(saved)})`);
  await t.evaluate('window.__app.autosave.clear()');
});
