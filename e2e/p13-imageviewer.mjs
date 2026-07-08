/**
 * Image Viewer pane e2e (P13-2). Switches an area to the Image Viewer editor,
 * asserts the "No render yet" hint, adds a material with a tiny canvas-made
 * image, checks the source dropdown lists it, selects it and verifies the
 * canvas draws (non-blank at the centre), then that wheel-zoom changes the
 * drawn scale and Fit restores it.
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  // Handle helper: run an expression against the live __imageViewer debug handle.
  const iv = (expr) => t.evaluate(
    `(() => { const h = document.querySelector('.image-viewer').__imageViewer; return ${expr}; })()`);

  // --- Switch the Properties area to the Image Viewer editor ----------------
  await t.evaluate(`(() => {
    const selects = [...document.querySelectorAll('.wsp-area-select')];
    const sel = selects.find((s) => s.value === 'properties') || selects[selects.length - 1];
    sel.value = 'image';
    sel.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(200);

  t.check('exactly one Image Viewer pane exists',
    (await t.evaluate(`document.querySelectorAll('.image-viewer').length`)) === 1);
  t.check('default source is Render Result', (await iv('h.sourceKey()')) === 'render');

  // --- No render yet: the hint is visible -----------------------------------
  t.check('"No render yet" hint is visible',
    await t.evaluate(`(() => {
      const el = document.querySelector('.image-viewer-hint');
      return el && el.style.display !== 'none' && /No render yet/.test(el.textContent);
    })()`));

  // --- Add a material with a tiny canvas-made image -------------------------
  const matId = await t.evaluate(`(() => {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const x = c.getContext('2d');
    x.fillStyle = '#e050a0';
    x.fillRect(0, 0, 64, 64);
    const m = window.__app.scene.addMaterial('Icing');
    m.texDataUrl = c.toDataURL('image/png');
    return m.id;
  })()`);
  await t.sleep(150); // update() rebuilds the dropdown on the next frame

  const labels = await iv('h.optionLabels()');
  t.check('dropdown lists "Icing — Base Color"',
    Array.isArray(labels) && labels.includes('Icing — Base Color'), JSON.stringify(labels));

  // --- Select the material image → it should decode + draw ------------------
  await iv(`h.setSource('mat:${matId}:tex')`);
  t.check('source switched to the material image',
    (await iv('h.sourceKey()')) === `mat:${matId}:tex`);

  // Wait for the Image to decode + the pane to blit it to its source canvas.
  const decoded = await t.until('(() => { const h = document.querySelector(".image-viewer").__imageViewer; const s = h.sourceSize(); return s[0] === 64 && s[1] === 64; })()');
  t.check('material image decoded to 64x64 source', decoded);
  await t.sleep(120); // one more frame so Fit + draw land

  // Canvas non-blank at centre (the pink image, not the #101010 backdrop).
  const rect = await t.evaluate(`(() => { const r = document.querySelector('.image-viewer-canvas').getBoundingClientRect(); return { w: r.width, h: r.height }; })()`);
  const centerPx = await iv(`h.pixelAt(${rect.w / 2}, ${rect.h / 2})`);
  t.check('canvas draws the image at the centre (non-blank)',
    Array.isArray(centerPx) && centerPx[3] === 255 && (centerPx[0] > 40 || centerPx[1] > 40 || centerPx[2] > 40),
    JSON.stringify(centerPx));

  // Pixel readout reads the source pixel under the centre.
  const readPx = await iv(`h.readPixel(${rect.w / 2}, ${rect.h / 2})`);
  t.check('pixel readout returns an in-range image pixel',
    Array.isArray(readPx) && readPx[0] >= 0 && readPx[0] < 64 && readPx[1] >= 0 && readPx[1] < 64,
    JSON.stringify(readPx));

  // --- Wheel zoom changes the drawn scale; Fit restores it ------------------
  const fitZoom = await iv('h.zoom()');
  await iv(`h.wheelAt(${rect.w / 2}, ${rect.h / 2}, -400)`); // deltaY<0 → zoom in
  const zoomedIn = await iv('h.zoom()');
  t.check('wheel zoom increases the scale', zoomedIn > fitZoom + 0.01, `${fitZoom} → ${zoomedIn}`);

  await iv('h.fit()');
  const refit = await iv('h.zoom()');
  t.check('Fit restores the letterbox zoom', Math.abs(refit - fitZoom) < 1e-6, `${zoomedIn} → ${refit}`);

  await t.screenshot('/tmp/vibe-blender-imageviewer.png');
});
