/**
 * P11-3 e2e — base-color textures (checker + image) through UVs, in the
 * Rendered viewport, the F12 path tracer, the Material tab, and save/load.
 * Run with the dev server up:
 *   flock /tmp/vibe-blender-e2e.lock node e2e/p11-textures.mjs
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  const saved = await t.evaluate('window.__app.io.serialize()');

  // --- Seed the default cube with programmatic per-face UVs (each quad face
  //     maps the full 0..1 UV square → 8×8 checker cells across the face).
  //     Assign a fresh material and make the cube active. No P11-1 dependency. ---
  const setup = await t.evaluate(`(() => {
    const scene = window.__app.scene;
    const obj = scene.objects.find((o) => o.kind === 'mesh');
    if (!obj) return 'no mesh';
    for (const f of obj.mesh.faces.values()) {
      if (f.verts.length === 4) obj.mesh.setFaceUVs(f.id, [[0, 0], [1, 0], [1, 1], [0, 1]]);
    }
    const mat = scene.addMaterial('Tex');
    obj.materialId = mat.id;
    scene.selectOnly(obj.id);
    // Flat bright world lights the cube via ambient (no scene light needed) and
    // gives a uniform backdrop so cube-face variance is all texture.
    const w = scene.world;
    w.mode = 'flat'; w.color = [1, 1, 1]; w.strength = 3;
    window.__app.renderer.shadingMode = 'rendered';
    return obj.mesh.uvs.size;
  })()`);
  t.check('cube seeded with per-face UVs + material', typeof setup === 'number' && setup > 0, String(setup));

  // Switch the properties editor to the Material tab.
  await t.evaluate(`(() => {
    const b = document.querySelector('button[data-tab="material"]');
    if (b) b.click();
  })()`);
  await t.sleep(80);
  t.check('Material tab texture kind select exists',
    await t.evaluate(`!!document.querySelector('.material-tab-texkind')`));

  // Luminance spread across a horizontal strip through the viewport center — a
  // checkered face straddles multiple cells → large spread; a flat face → small.
  const centerStripSpread = () => t.evaluate(`(() => {
    const app = window.__app, gl = app.renderer.ctx.gl, c = gl.canvas;
    app.renderer.render(app.scene, app.camera);
    const n = 200, x0 = Math.max(0, Math.round(c.width / 2 - n / 2));
    const px = new Uint8Array(n * 4);
    gl.readPixels(x0, Math.round(c.height / 2), n, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let min = 999, max = -999;
    for (let i = 0; i < n; i++) {
      const l = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
      if (l < min) min = l; if (l > max) max = l;
    }
    return max - min;
  })()`);

  // --- Baseline: texKind 'none' → the face is near-uniform ---
  const noneSpread = await centerStripSpread();
  t.check('untextured face is near-uniform (regression baseline)', noneSpread < 30, `spread ${noneSpread.toFixed(1)}`);

  // --- Checker via the Material tab select ---
  await t.evaluate(`(() => {
    const sel = document.querySelector('.material-tab-texkind');
    sel.value = 'checker';
    sel.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(80);
  t.check('material texKind is now checker',
    (await t.evaluate(`window.__materialTab.material().texKind`)) === 'checker');
  await t.screenshot('/tmp/p11-textures-checker.png');
  const checkerSpread = await centerStripSpread();
  t.check('checkered face shows alternating light/dark squares',
    checkerSpread > 40 && checkerSpread > noneSpread * 2,
    `checker ${checkerSpread.toFixed(1)} vs none ${noneSpread.toFixed(1)}`);

  // --- F12 path-traced render: sky unchanged, cube pixels show checker variance ---
  await t.evaluate('window.__renderEngine.start()');
  const rendered = await t.until('window.__renderEngine.sample() >= 4', 40000);
  t.check('F12 render accumulates samples', rendered);
  const renderProbe = await t.evaluate(`(() => {
    const cv = window.__renderEngine.canvas();
    const ctx = cv.getContext('2d');
    const cx = Math.round(cv.width / 2), cy = Math.round(cv.height / 2);
    const row = ctx.getImageData(cx - 40, cy, 80, 1).data;
    let min = 999, max = -999;
    for (let i = 0; i < 80; i++) {
      const l = 0.299 * row[i * 4] + 0.587 * row[i * 4 + 1] + 0.114 * row[i * 4 + 2];
      if (l < min) min = l; if (l > max) max = l;
    }
    const sky = ctx.getImageData(2, 2, 1, 1).data; // corner = world background
    return { spread: max - min, sky: [sky[0], sky[1], sky[2]] };
  })()`);
  t.check('F12 cube pixels show checker variance', renderProbe.spread > 30, `spread ${renderProbe.spread.toFixed(1)}`);
  t.check('F12 sky corner reads the (bright flat) world', renderProbe.sky.every((v) => v > 180), `rgb(${renderProbe.sky.join(',')})`);
  await t.evaluate('window.__renderEngine.close()');
  await t.sleep(120);

  // --- Switch to a tiny generated data-URL image → dominant color changes ---
  await t.evaluate(`(() => {
    const cv = document.createElement('canvas');
    cv.width = 4; cv.height = 4;
    const c = cv.getContext('2d');
    c.fillStyle = '#ff2020'; c.fillRect(0, 0, 4, 4);
    const url = cv.toDataURL('image/png');
    window.__texDone = false;
    window.__materialTab.loadTexture(url).then(() => { window.__texDone = true; });
  })()`);
  const texLoaded = await t.until('window.__texDone === true', 10000);
  t.check('image texture load resolved', texLoaded);
  t.check('material is image with a packed data URL + decoded pixels',
    await t.evaluate(`(() => {
      const m = window.__materialTab.material();
      return m.texKind === 'image' &&
        typeof m.texDataUrl === 'string' && m.texDataUrl.startsWith('data:image/png') &&
        !!m.texImage && m.texImage.width === 4 && m.texImage.pixels.length === 4 * 4 * 3;
    })()`));

  // Wait for the async GL upload, then the cube's dominant color reads red.
  // Sample BELOW-LEFT of center: the translate gizmo's arrows converge exactly
  // at the cube origin (= canvas center), so the dead-center pixel can land on
  // a shaft instead of the cube face.
  const centerPixel = () => t.evaluate(`(() => {
    const app = window.__app, gl = app.renderer.ctx.gl, c = gl.canvas;
    app.renderer.render(app.scene, app.camera);
    const px = new Uint8Array(4);
    gl.readPixels(Math.round(c.width / 2) - 60, Math.round(c.height / 2) - 60, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return [px[0], px[1], px[2]];
  })()`);
  let redOk = false, last = [0, 0, 0];
  for (let i = 0; i < 25 && !redOk; i++) {
    last = await centerPixel();
    redOk = last[0] > 120 && last[0] > last[1] + 40 && last[0] > last[2] + 40;
    if (!redOk) await t.sleep(200);
  }
  t.check('image texture makes the cube dominantly red', redOk, `rgb(${last.join(',')})`);
  const imgThumb = await t.evaluate(`(() => {
    const img = document.querySelector('.material-tab-texthumb');
    return !!img && img.style.display !== 'none' && (img.getAttribute('src') || '').startsWith('data:image/png');
  })()`);
  t.check('image thumbnail <img> shows the packed texture', imgThumb);

  // --- Undo: image → checker → none ---
  await t.key('z', 'KeyZ', 2);
  await t.sleep(120);
  t.check('undo of image load restores checker',
    (await t.evaluate(`window.__materialTab.material().texKind`)) === 'checker');
  await t.key('z', 'KeyZ', 2);
  await t.sleep(120);
  t.check('undo of checker restores None',
    (await t.evaluate(`window.__materialTab.material().texKind`)) === 'none');

  // --- Save → load keeps the texture byte-equal ---
  await t.evaluate(`(() => {
    const m = window.__materialTab.material();
    m.texKind = 'image';
    m.texDataUrl = 'data:image/png;base64,ROUNDTRIP';
  })()`);
  const j1 = await t.evaluate('window.__app.io.serialize()');
  await t.evaluate(`window.__app.io.apply(${JSON.stringify(j1)})`);
  const j2 = await t.evaluate('window.__app.io.serialize()');
  t.check('texture survives save/load byte-identically', j1 === j2);
  t.check('reloaded material still has the packed image url',
    await t.evaluate(`(() => {
      const m = window.__app.scene.materials.find((x) => x.texKind === 'image');
      return !!m && m.texDataUrl === 'data:image/png;base64,ROUNDTRIP';
    })()`));

  // --- Restore the clean scene + matcap shading ---
  await t.evaluate(`window.__app.renderer.shadingMode = 'matcap'`);
  await t.evaluate(`window.__app.io.apply(${JSON.stringify(saved)})`);
  await t.evaluate('window.__app.autosave.clear()');
});
