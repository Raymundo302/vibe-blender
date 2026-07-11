/**
 * UR4-3 — Shift+A ▸ Image ▸ Diffuse…/Emit… image planes.
 *
 * Drives imagePlane.ts's exported createImagePlane directly (bypassing the file
 * picker) with an in-browser solid-color PNG, then:
 *  - verifies aspect + material wiring (diffuse) and shadeless (emit);
 *  - proves a single undo removes BOTH the plane and its material;
 *  - switches the viewport to Rendered and pixel-checks that the EMIT plane
 *    shows the image's color UNLIT (bright, exact) while a DIFFUSE plane with no
 *    lights only picks up ambient (much darker) — emit is brighter/exact.
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  await t.key('Escape', 'Escape', 0); // dismiss splash

  // Expose the module (Vite serves the TS source) + a solid-color PNG data URL.
  await t.evaluate(`(async () => {
    window.__ip = await import('/src/tools/imagePlane.ts');
    const cvs = document.createElement('canvas'); cvs.width = 8; cvs.height = 8;
    const cx = cvs.getContext('2d');
    cx.fillStyle = 'rgb(220,40,40)'; cx.fillRect(0, 0, 8, 8);
    window.__ipUrl = cvs.toDataURL('image/png');
  })()`);
  t.check('imagePlane module + test PNG ready',
    await t.until('!!(window.__ip && window.__ipUrl)'));

  // Clean slate so nothing occludes the sampled pixels.
  await t.evaluate(`(() => {
    const S = window.__app.scene;
    for (const o of [...S.objects]) S.remove(o.id);
    window.__app.undo.clear();
  })()`);

  // --- Diffuse: aspect + material wired, correct kind. --------------------
  const diffuse = await t.evaluate(`(() => {
    const S = window.__app.scene;
    const obj = window.__ip.createImagePlane(S, window.__app.undo, {
      dataUrl: window.__ipUrl, name: 'blueprint', w: 400, h: 200, mode: 'diffuse',
    });
    const xs = [...obj.mesh.verts.values()].map((v) => v.co.x);
    const ys = [...obj.mesh.verts.values()].map((v) => v.co.y);
    const mat = S.getMaterial(obj.materialId);
    return {
      name: obj.name, kind: obj.kind,
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
      matName: mat.name, texKind: mat.texKind, hasUrl: mat.texDataUrl === window.__ipUrl,
      shadeless: !!mat.shadeless, rough: mat.roughness, metal: mat.metallic,
      mats: S.materials.length, objs: S.objects.length,
    };
  })()`);
  t.check('diffuse plane named by basename', diffuse.name === 'blueprint');
  t.check('diffuse plane is a mesh', diffuse.kind === 'mesh');
  t.check('aspect 2:1 → width 4, height 2',
    Math.abs(diffuse.width - 4) < 1e-6 && Math.abs(diffuse.height - 2) < 1e-6);
  t.check('material added + wired (image, correct data URL)',
    diffuse.mats === 1 && diffuse.matName === 'blueprint' && diffuse.texKind === 'image' && diffuse.hasUrl);
  t.check('diffuse material: roughness 1, metallic 0, shadeless false',
    diffuse.rough === 1 && diffuse.metal === 0 && diffuse.shadeless === false);

  // --- Single undo removes BOTH plane and material. ----------------------
  const afterUndo = await t.evaluate(`(() => {
    window.__app.undo.undo();
    const S = window.__app.scene;
    return { objs: S.objects.length, mats: S.materials.length };
  })()`);
  t.check('one undo removes plane AND material',
    afterUndo.objs === 0 && afterUndo.mats === 0);

  // --- Emit variant: shadeless true. -------------------------------------
  const emit = await t.evaluate(`(() => {
    const S = window.__app.scene;
    const obj = window.__ip.createImagePlane(S, window.__app.undo, {
      dataUrl: window.__ipUrl, name: 'emit', w: 100, h: 100, mode: 'emit',
    });
    return { shadeless: !!S.getMaterial(obj.materialId).shadeless };
  })()`);
  t.check('emit variant sets shadeless=true', emit.shadeless === true);

  // --- Rendered-mode pixel check: emit unlit & exact vs diffuse in shadow. -
  await t.evaluate(`(() => {
    // Top-down look so the flat (+Z normal) plane faces the camera.
    const cam = window.__app.camera;
    cam.yaw = 0; cam.pitch = 1.4; cam.distance = 5;
    window.__app.renderer.shadingMode = 'rendered';
    window.__app.shadePrefs.ao = false; // no AO multiply muddying the readback
    // Deselect: the translate gizmo arrows converge at the object origin (world
    // origin here), so a center-pixel read would sample the gizmo, not the plane.
    window.__app.scene.deselectAll();
  })()`);

  // Sample the plane center (world origin) after forcing a render.
  const centerPixel = () => t.evaluate(`(() => {
    const app = window.__app, gl = app.renderer.ctx.gl, c = gl.canvas;
    app.renderer.render(app.scene, app.camera);
    const m = app.renderer.currentViewProj(app.scene, app.camera).m;
    const cw = m[3]*0 + m[7]*0 + m[11]*0 + m[15];
    const cx = (m[12]) / cw, cy = (m[13]) / cw;
    const px = Math.round((cx*0.5+0.5) * c.width);
    const py = Math.round((cy*0.5+0.5) * c.height);
    const out = new Uint8Array(4);
    gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return [out[0], out[1], out[2]];
  })()`);

  // The GL image upload is async — poll until the texture lands (red-dominant).
  t.check('emit texture uploads (center pixel becomes red-dominant)',
    await t.until(`(() => {
      const app = window.__app, gl = app.renderer.ctx.gl, c = gl.canvas;
      app.renderer.render(app.scene, app.camera);
      const m = app.renderer.currentViewProj(app.scene, app.camera).m;
      const px = Math.round((m[12]/m[15]*0.5+0.5) * c.width);
      const py = Math.round((m[13]/m[15]*0.5+0.5) * c.height);
      const out = new Uint8Array(4);
      gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
      return out[0] > 150 && out[0] > out[1] + 60;
    })()`));

  const emitPx = await centerPixel();
  t.check('emit shows the image color UNLIT (bright red, low green/blue): ' + JSON.stringify(emitPx),
    emitPx[0] > 180 && emitPx[1] < 100 && emitPx[2] < 100);

  // Swap the emit plane's material to diffuse (same texture) — no lights in the
  // scene, so it renders dark (ambient only). Force a fresh render, re-read.
  await t.evaluate(`(() => {
    const S = window.__app.scene;
    S.materials[0].shadeless = false;
  })()`);
  await t.sleep(60);
  const diffusePx = await centerPixel();
  t.check('diffuse plane (no lights) is much darker than emit: emit=' +
    JSON.stringify(emitPx) + ' diffuse=' + JSON.stringify(diffusePx),
    emitPx[0] > diffusePx[0] + 60);

  // --- Menu integration: Shift+A ▸ Image ▸ opens Diffuse…/Emit… items. ----
  await t.evaluate(`(() => {
    const S = window.__app.scene; for (const o of [...S.objects]) S.remove(o.id);
    window.__app.undo.clear();
  })()`);
  await t.evaluate(`window.__app.renderer.shadingMode = 'matcap'`);
  // Move the pointer into the viewport, then Shift+A.
  await t.evaluate(`(() => {
    const wrap = document.querySelector('#viewport-wrap') || document.querySelector('canvas').parentElement;
    const r = wrap.getBoundingClientRect();
    window.__app.input.pointer.x = r.width/2; window.__app.input.pointer.y = r.height/2;
  })()`);
  await t.key('a', 'KeyA', 8); // Shift = modifier bit 8
  await t.sleep(60);
  t.check('Add menu shows an Image category',
    await t.evaluate(`!!document.querySelector('.add-menu-category[data-category="Image"]')`));
  const imageItems = await t.evaluate(`(() => {
    const row = document.querySelector('.add-menu-category[data-category="Image"]');
    row.dispatchEvent(new MouseEvent('mouseenter'));
    return [...document.querySelectorAll('.add-menu-flyout .add-menu-item')].map((b) => b.textContent);
  })()`);
  // UR4-4 added the two HTML… items to the same flyout; pin all four.
  t.check('Image flyout has Diffuse…, Emit… + the UR4-4 HTML items: ' + JSON.stringify(imageItems),
    imageItems.includes('Diffuse…') && imageItems.includes('Emit…') && imageItems.length === 4);
  await t.key('Escape', 'Escape', 0);
});
