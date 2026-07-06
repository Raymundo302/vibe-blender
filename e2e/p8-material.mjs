/**
 * P8-3 e2e — Material properties tab. Drives the UI to create + assign a
 * material on the default cube, paint it red with low roughness, switch to
 * rendered shading, and prove the viewport center pixel is red-dominant. Then
 * undo back to the default grey. Run with the dev server up:
 *   flock /tmp/vibe-blender-e2e.lock node e2e/p8-material.mjs
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  // Clean single-Cube scene in the Layout workspace (Properties panel visible).
  const saved = await t.evaluate('window.__app.io.serialize()');
  await t.evaluate(`document.querySelector('.wsp-tab[data-workspace="Layout"]')?.click()`);
  await t.sleep(150);
  await t.evaluate(`window.__app.io.apply(${JSON.stringify(saved)})`);
  await t.evaluate(`window.__app.scene.selectOnly(window.__app.scene.objects[0].id)`);
  await t.sleep(120);

  // --- Material tab presence ---
  t.check('Material tab button exists',
    await t.until(`!!document.querySelector('.properties-tab-btn[data-tab="material"]')`, 5000));
  await t.evaluate(`document.querySelector('.properties-tab-btn[data-tab="material"]').click()`);
  await t.sleep(140);
  t.check('Material tab tooltip reads "Material"',
    (await t.evaluate(`document.querySelector('.properties-tab-btn[data-tab="material"]').title`)) === 'Material');
  t.check('slot select renders with a (None) option',
    await t.evaluate(`(() => {
      const sel = document.querySelector('.material-tab-slot-select');
      return !!sel && [...sel.options].some((o) => o.textContent === '(None)');
    })()`));
  t.check('no material assigned yet → fields hidden',
    await t.evaluate(`document.querySelector('.material-tab-fields').style.display === 'none'`));

  // --- New material via the UI (creates + assigns in one undo step) ---
  const matCountBefore = await t.evaluate('window.__app.scene.materials.length');
  await t.evaluate(`document.querySelector('.material-tab-new-btn').click()`);
  await t.sleep(160);
  t.check('New adds one material to the library',
    (await t.evaluate('window.__app.scene.materials.length')) === matCountBefore + 1);
  t.check('New assigns the material to the active cube',
    (await t.evaluate('window.__app.scene.activeObject.materialId')) !== null);
  t.check('material fields now visible',
    await t.evaluate(`document.querySelector('.material-tab-fields').style.display !== 'none'`));

  const newMatId = await t.evaluate('window.__app.scene.activeObject.materialId');

  // Add a bright key point light OFF to the upper-right of the camera so the
  // front face is lit red (diffuse) but the tight glossy highlight lands
  // off-center — rendered mode has no fallback rig, an unlit scene is near-black.
  await t.evaluate(`(() => {
    const app = window.__app, cam = app.camera, e = cam.eye;
    const Y = e.constructor.Y ?? new e.constructor(0, 1, 0);
    const right = cam.forward.cross(Y).normalize();
    const pos = e.add(right.scale(6)).add(Y.scale(4));
    const L = app.scene.addLight('KeyLight', 'point');
    L.transform = L.transform.withPosition(pos);
    L.light.power = 20000;
  })()`);

  // Paint the material red via the color input (input=live preview, change=commit).
  await t.evaluate(`(() => {
    const inp = document.querySelector('.material-tab-basecolor');
    inp.value = '#ff2020';
    inp.dispatchEvent(new Event('input'));
    inp.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(120);
  t.check('baseColor committed red-ish',
    await t.evaluate(`(() => {
      const m = window.__app.scene.getMaterial(${newMatId});
      return m.baseColor[0] > 0.9 && m.baseColor[1] < 0.3 && m.baseColor[2] < 0.3;
    })()`));

  // Drop roughness to 0.2 via the slider.
  await t.evaluate(`(() => {
    const inp = document.querySelector('.material-tab-roughness');
    inp.value = '0.2';
    inp.dispatchEvent(new Event('input'));
    inp.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(120);
  t.check('roughness committed to 0.2',
    Math.abs((await t.evaluate(`window.__app.scene.getMaterial(${newMatId}).roughness`)) - 0.2) < 1e-6);

  // --- Rendered shading: center pixel must be red-dominant ---
  await t.evaluate(`window.__app.renderer.shadingMode = 'rendered'`);
  await t.sleep(120);

  // Force a render then read the center pixel immediately (preserveDrawingBuffer
  // is false, so the read must happen in the same synchronous turn as the draw).
  const readCenter = () => t.evaluate(`(() => {
    const app = window.__app, gl = app.renderer.ctx.gl, c = gl.canvas;
    app.renderer.render(app.scene, app.camera);
    const px = new Uint8Array(4);
    gl.readPixels((c.width / 2) | 0, (c.height / 2) | 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return [px[0], px[1], px[2], px[3]];
  })()`);

  await t.screenshot('/tmp/p8-material-red.png');
  const red = await readCenter();
  t.check('rendered center pixel is red-dominant',
    red[0] > 90 && red[0] > red[1] + 40 && red[0] > red[2] + 40,
    `rgba(${red.join(', ')})`);

  // --- Undo back to grey: undoing the baseColor edit restores the default grey ---
  // (roughness edit first, then baseColor edit).
  await t.key('z', 'KeyZ', 2); // undo roughness
  await t.sleep(120);
  await t.key('z', 'KeyZ', 2); // undo baseColor → back to default grey (0.8)
  await t.sleep(120);
  t.check('Ctrl+Z restored the material baseColor to grey',
    await t.evaluate(`(() => {
      const m = window.__app.scene.getMaterial(${newMatId});
      return !!m && Math.abs(m.baseColor[0] - 0.8) < 1e-6 &&
             Math.abs(m.baseColor[1] - m.baseColor[0]) < 1e-6 &&
             Math.abs(m.baseColor[2] - m.baseColor[0]) < 1e-6;
    })()`));

  await t.screenshot('/tmp/p8-material-grey.png');
  const grey = await readCenter();
  // Red→grey de-saturates: the red/green gap collapses (was ~54 in the red
  // frame) and the pixel is no longer red-dominant by the strong threshold.
  t.check('rendered center pixel is now grey (not red-dominant)',
    grey[0] - grey[1] < 30 && !(grey[0] > grey[1] + 40 && grey[0] > grey[2] + 40),
    `rgba(${grey.join(', ')})`);

  // --- Redo re-applies the red baseColor (same material id, no library churn) ---
  await t.key('z', 'KeyZ', 2 | 8); // ctrl+shift+z → redo baseColor
  await t.sleep(120);
  t.check('redo re-applies red baseColor',
    await t.evaluate(`window.__app.scene.getMaterial(${newMatId}).baseColor[0] > 0.9`));

  // --- Undo the whole New (remove material + clear assignment) ---
  await t.key('z', 'KeyZ', 2); // undo baseColor again
  await t.sleep(100);
  await t.key('z', 'KeyZ', 2); // undo New → material removed, slot cleared
  await t.sleep(120);
  t.check('undoing New removes the material from the library',
    (await t.evaluate('window.__app.scene.materials.length')) === matCountBefore);
  t.check('undoing New clears the slot assignment',
    (await t.evaluate('window.__app.scene.activeObject.materialId')) === null);

  // --- Assign via the slot select round-trips through undo ---
  await t.evaluate(`window.__app.scene.addMaterial('Slotted')`);
  await t.sleep(120); // let the tab rebuild the option list
  const slotId = await t.evaluate('window.__app.scene.materials.at(-1).id');
  await t.evaluate(`(() => {
    const sel = document.querySelector('.material-tab-slot-select');
    sel.value = String(${slotId});
    sel.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(120);
  t.check('slot select assigns the chosen material',
    (await t.evaluate('window.__app.scene.activeObject.materialId')) === slotId);
  await t.key('z', 'KeyZ', 2); // undo assign
  await t.sleep(120);
  t.check('Ctrl+Z clears the slot assignment',
    (await t.evaluate('window.__app.scene.activeObject.materialId')) === null);

  // Restore a clean default scene + matcap shading so the suite ends as it began.
  await t.evaluate(`window.__app.renderer.shadingMode = 'matcap'`);
  await t.evaluate(`window.__app.io.apply(${JSON.stringify(saved)})`);
  await t.evaluate(`window.__app.autosave.clear()`);
});
