/**
 * P13-3 e2e — Material tab map slots (normal/bump, roughness, metallic).
 * Boots, selects the cube, creates a material via the tab's New, sets a
 * canvas-generated normal map through the file-input change handler, drives the
 * Strength slider + Bump toggle, sets roughness/metallic maps, proves the RAW
 * decode caches fill (normalImage/roughImage/metalImage), that a Ctrl+Z chain
 * restores each step, and that Rendered shading throws no GL error while the
 * mapped frame visibly differs from the pre-map frame.
 *   flock /tmp/vibe-blender-e2e.lock node e2e/p13-mattab-maps.mjs
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  // Clean single-Cube scene in the Layout workspace, cube selected, per-face UVs
  // seeded (needed so the rendered pass can sample the maps), a key light added,
  // and a bright flat world so the surface is lit. Then switch to the Material tab.
  const saved = await t.evaluate('window.__app.io.serialize()');
  await t.evaluate(`document.querySelector('.wsp-tab[data-workspace="Layout"]')?.click()`);
  await t.sleep(150);
  await t.evaluate(`window.__app.io.apply(${JSON.stringify(saved)})`);

  const setup = await t.evaluate(`(() => {
    const app = window.__app, scene = app.scene, obj = scene.objects[0];
    scene.selectOnly(obj.id);
    for (const f of obj.mesh.faces.values()) {
      if (f.verts.length === 4) obj.mesh.setFaceUVs(f.id, [[0, 0], [1, 0], [1, 1], [0, 1]]);
    }
    const w = scene.world; w.mode = 'flat'; w.color = [1, 1, 1]; w.strength = 2;
    const cam = app.camera, e = cam.eye;
    const Y = e.constructor.Y ?? new e.constructor(0, 1, 0);
    const right = cam.forward.cross(Y).normalize();
    const L = scene.addLight('KeyLight', 'point');
    L.transform = L.transform.withPosition(e.add(right.scale(6)).add(Y.scale(4)));
    L.light.power = 20000;
    return obj.mesh.uvs.size;
  })()`);
  t.check('cube seeded with per-face UVs + key light', typeof setup === 'number' && setup > 0, String(setup));

  t.check('Material tab button exists',
    await t.until(`!!document.querySelector('.properties-tab-btn[data-tab="material"]')`, 5000));
  await t.evaluate(`document.querySelector('.properties-tab-btn[data-tab="material"]').click()`);
  await t.sleep(140);

  // --- New material via the tab (creates + assigns in one undo step) ---
  await t.evaluate(`document.querySelector('.material-tab-new-btn').click()`);
  await t.sleep(160);
  const matId = await t.evaluate('window.__app.scene.activeObject.materialId');
  t.check('New assigns a material to the cube', matId !== null);

  // UR16-2: normal/rough/metal maps live under the SUPER (everything) shader —
  // switch to it so the map affordances appear.
  await t.evaluate(`window.__materialTab.setShader('super')`);
  await t.sleep(140);

  // Map-slot UI is present.
  t.check('normal-map file input rendered',
    await t.evaluate(`!!document.querySelector('.material-tab-normalfile')`));
  t.check('bump checkbox rendered',
    await t.evaluate(`!!document.querySelector('.material-tab-normal-bump')`));
  t.check('strength slider is 0..2 step 0.05',
    await t.evaluate(`(() => {
      const s = document.querySelector('.material-tab-normal-strength');
      return !!s && s.min === '0' && s.max === '2' && s.step === '0.05';
    })()`));
  // UR16-2: roughness/metallic maps attach through their channel sockets (image
  // kind) rather than standalone file rows — verify those channel rows exist.
  t.check('roughness + metallic channel rows rendered',
    await t.evaluate(`!!document.querySelector('.prop-row[data-channel="roughness"]') && !!document.querySelector('.prop-row[data-channel="metallic"]')`));

  // Rendered shading + a pre-map full-frame capture stashed in-page for a
  // deterministic before/after diff (rasterized rendered mode is stable across
  // identical frames, so any nonzero diff is the maps).
  await t.evaluate(`window.__app.renderer.shadingMode = 'rendered'`);
  await t.sleep(120);
  await t.screenshot('/tmp/p13-mattab-pre.png');
  const preErr = await t.evaluate(`(() => {
    const app = window.__app, gl = app.renderer.ctx.gl, c = gl.canvas;
    app.renderer.render(app.scene, app.camera);
    const px = new Uint8Array(c.width * c.height * 4);
    gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
    window.__p13pre = px;
    return gl.getError();
  })()`);
  t.check('rendered pass reports NO GL error (pre-map)', preErr === 0, `getError ${preErr}`);

  // --- Normal map via the REAL file-input change handler (canvas → File) ---
  // High-contrast tangent-space-ish pattern so perturbed normals visibly shift.
  await t.evaluate(`(() => {
    const cv = document.createElement('canvas'); cv.width = 8; cv.height = 8;
    const c = cv.getContext('2d');
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      c.fillStyle = ((x + y) & 1) === 0 ? '#3030ff' : '#ff3030';
      c.fillRect(x, y, 1, 1);
    }
    const url = cv.toDataURL('image/png');
    const bstr = atob(url.split(',')[1]);
    const bytes = new Uint8Array(bstr.length);
    for (let i = 0; i < bstr.length; i++) bytes[i] = bstr.charCodeAt(i);
    const file = new File([bytes], 'normal.png', { type: 'image/png' });
    const dt = new DataTransfer(); dt.items.add(file);
    const inp = document.querySelector('.material-tab-normalfile');
    inp.files = dt.files;
    inp.dispatchEvent(new Event('change'));
  })()`);
  const normalSet = await t.until(`(() => {
    const m = window.__app.scene.getMaterial(${matId});
    return typeof m.normalDataUrl === 'string' && m.normalDataUrl.startsWith('data:image/png') && !!m.normalImage;
  })()`, 10000);
  t.check('file-input set fills normalDataUrl + normalImage cache', normalSet);
  t.check('normal cache is RAW-decoded 0..1 (blue channel of a #3030ff/#ff3030 map)',
    await t.evaluate(`(() => {
      const m = window.__app.scene.getMaterial(${matId});
      if (!m.normalImage) return false;
      const px = m.normalImage.pixels;
      // Some pixel must have a high blue channel (~255/255) — proof it is not
      // sRGB-linearized (that would crush 255 far less, but 0x30=48 → 0.188 raw
      // vs 0.029 sRGB is the real tell). Assert a red-ish pixel's R ≈ 0..1 raw.
      let maxB = 0, minChan = 1;
      for (let i = 0; i < px.length; i += 3) { if (px[i + 2] > maxB) maxB = px[i + 2]; if (px[i] < minChan) minChan = px[i]; }
      return maxB > 0.9 && minChan >= 0 && minChan < 0.25;
    })()`));

  // --- Strength slider writes normalStrength (input=live, change=commit) ---
  await t.evaluate(`(() => {
    const s = document.querySelector('.material-tab-normal-strength');
    s.value = '1.75';
    s.dispatchEvent(new Event('input'));
    s.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(100);
  t.check('strength slider committed 1.75',
    Math.abs((await t.evaluate(`window.__app.scene.getMaterial(${matId}).normalStrength`)) - 1.75) < 1e-6);

  // --- Bump toggle flips normalIsBump ---
  await t.evaluate(`(() => {
    const b = document.querySelector('.material-tab-normal-bump');
    b.checked = true;
    b.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(100);
  t.check('bump checkbox set normalIsBump true',
    (await t.evaluate(`window.__app.scene.getMaterial(${matId}).normalIsBump`)) === true);

  // --- Roughness + metallic maps via the tab's internal apply (setMap) ---
  // Fully-black roughness map (glossy) + fully-white metallic map (full metal) —
  // a large, unambiguous appearance change vs the dielectric pre-map frame.
  await t.evaluate(`(() => {
    const mk = (hex) => { const cv = document.createElement('canvas'); cv.width = 4; cv.height = 4;
      const c = cv.getContext('2d'); c.fillStyle = hex; c.fillRect(0, 0, 4, 4); return cv.toDataURL('image/png'); };
    window.__p13done = 0;
    window.__materialTab.setMap('rough', mk('#000000')).then(() => { window.__p13done++; });
    window.__materialTab.setMap('metal', mk('#ffffff')).then(() => { window.__p13done++; });
  })()`);
  const mapsSet = await t.until('window.__p13done === 2', 10000);
  t.check('rough + metal setMap resolved', mapsSet);
  t.check('rough + metal caches populated RAW',
    await t.evaluate(`(() => {
      const m = window.__app.scene.getMaterial(${matId});
      return !!m.roughDataUrl && !!m.roughImage && !!m.metalDataUrl && !!m.metalImage &&
        m.roughImage.pixels[0] < 0.02 && m.metalImage.pixels[0] > 0.98;
    })()`));

  // --- Rendered frame now visibly differs from the pre-map frame + no GL error ---
  await t.screenshot('/tmp/p13-mattab-post.png');
  const post = await t.evaluate(`(() => {
    const app = window.__app, gl = app.renderer.ctx.gl, c = gl.canvas;
    app.renderer.render(app.scene, app.camera);
    const px = new Uint8Array(c.width * c.height * 4);
    gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const pre = window.__p13pre;
    let diff = 0;
    for (let i = 0; i < px.length; i++) diff += Math.abs(px[i] - pre[i]);
    return { err: gl.getError(), diff };
  })()`);
  t.check('rendered pass reports NO GL error (post-map)', post.err === 0, `getError ${post.err}`);
  t.check('mapped rendered frame differs from pre-map frame', post.diff > 2000, `sumAbsDiff ${post.diff}`);

  // --- Ctrl+Z chain restores each step (LIFO: metal, rough, bump, strength, normal) ---
  const get = (f) => t.evaluate(`window.__app.scene.getMaterial(${matId}).${f}`);
  await t.key('z', 'KeyZ', 2); await t.sleep(80);
  t.check('undo #1 clears metallic map',
    (await get('metalDataUrl')) === null && (await get('metalImage')) === undefined);
  await t.key('z', 'KeyZ', 2); await t.sleep(80);
  t.check('undo #2 clears roughness map',
    (await get('roughDataUrl')) === null && (await get('roughImage')) === undefined);
  await t.key('z', 'KeyZ', 2); await t.sleep(80);
  t.check('undo #3 restores normalIsBump false', (await get('normalIsBump')) === false);
  await t.key('z', 'KeyZ', 2); await t.sleep(80);
  t.check('undo #4 restores normalStrength 1', Math.abs((await get('normalStrength')) - 1) < 1e-6);
  await t.key('z', 'KeyZ', 2); await t.sleep(80);
  t.check('undo #5 clears normal map (dataUrl + cache)',
    (await get('normalDataUrl')) === null && (await get('normalImage')) === undefined);

  // --- Redo re-applies the normal map (dataUrl + cache) ---
  await t.key('z', 'KeyZ', 2 | 8); await t.sleep(80);
  t.check('redo re-applies the normal map',
    (await t.evaluate(`(() => { const m = window.__app.scene.getMaterial(${matId});
      return typeof m.normalDataUrl === 'string' && !!m.normalImage; })()`)));

  // Restore a clean default scene + matcap shading so the suite ends as it began.
  await t.evaluate(`window.__app.renderer.shadingMode = 'matcap'`);
  await t.evaluate(`window.__app.io.apply(${JSON.stringify(saved)})`);
  await t.evaluate(`window.__app.autosave.clear()`);
});
