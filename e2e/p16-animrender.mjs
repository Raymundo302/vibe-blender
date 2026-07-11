/**
 * P16-1 e2e — Render Animation (🎞 / Ctrl+F12): WebM + PNG-zip.
 * Loads research/donut-flythrough.vibe.json, drives __app.animRender.render()
 * headlessly, and asserts:
 *   - PNG mode: 5 PNGs land in the store-only zip; frames differ pairwise
 *     (the camera moves); frameCurrent + shading mode restored afterwards.
 *   - cancel() mid-run resolves cleanly (null).
 *   - WebM mode: a video/webm Blob with size > 0 for a 5-frame run.
 *
 * Run with the dev server up:
 *   flock /tmp/vibe-blender-e2e.lock node e2e/p16-animrender.mjs
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  // The shared harness evaluate() does not await page promises; this helper
  // does (awaitPromise), needed for fetch + the async render() calls.
  const evalAsync = async (expr) => {
    const { result, exceptionDetails } = await t.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    });
    if (exceptionDetails) throw new Error(`page threw: ${exceptionDetails.text}`);
    return result.value;
  };

  // --- Load the acceptance scene (animated donut flythrough) ---------------
  const loaded = await evalAsync(`(async () => {
    const txt = await fetch('/research/donut-flythrough.vibe.json').then((r) => r.text());
    window.__app.io.apply(txt);
    const s = window.__app.scene;
    return { objects: s.objects.length, activeCamera: s.activeCameraId, start: s.frameStart, end: s.frameEnd };
  })()`);
  t.check('donut-flythrough loaded', loaded.objects > 1, `objects=${loaded.objects}`);
  t.check('scene has an active camera', loaded.activeCamera !== null, `activeCamera=${loaded.activeCamera}`);

  t.check('__app.animRender exposed', await t.evaluate('typeof window.__app.animRender.render === "function"'));

  // Record pre-render state so we can confirm restoration.
  const before = await t.evaluate(`(() => {
    const s = window.__app.scene;
    s.frameCurrent = 7; // a distinctive value to detect restoration
    return { frame: s.frameCurrent, shading: window.__app.renderer.shadingMode, cameraViewId: window.__app.renderer.cameraViewId };
  })()`);

  // --- PNG mode: render frames 1..5, parse the zip in-page -----------------
  // The page returns a summary (entry count, per-frame CRCs from the zip's
  // local headers) so we can assert the frames differ pairwise.
  const png = await evalAsync(`(async () => {
    const blob = await window.__app.animRender.render({ mode: 'png', start: 1, end: 5 });
    const buf = new Uint8Array(await blob.arrayBuffer());
    const dv = new DataView(buf.buffer);
    // Walk local file headers (0x04034b50) collecting name + CRC + size.
    const entries = [];
    let p = 0;
    while (p + 4 <= buf.length && dv.getUint32(p, true) === 0x04034b50) {
      const crc = dv.getUint32(p + 14, true);
      const csize = dv.getUint32(p + 18, true);
      const nameLen = dv.getUint16(p + 26, true);
      const extraLen = dv.getUint16(p + 28, true);
      const name = new TextDecoder().decode(buf.subarray(p + 30, p + 30 + nameLen));
      entries.push({ name, crc, csize });
      p += 30 + nameLen + extraLen + csize;
    }
    return { type: blob.type, size: blob.size, entries };
  })()`);

  t.check('PNG zip is application/zip', png.type === 'application/zip', png.type);
  t.check('PNG zip has 5 entries', png.entries.length === 5, `n=${png.entries.length}`);
  t.check('entries are .png files', png.entries.every((e) => e.name.endsWith('.png')),
    png.entries.map((e) => e.name).join(','));
  t.check('every PNG has non-zero size', png.entries.every((e) => e.csize > 0));
  // Frames differ pairwise: the camera moves, so consecutive CRCs differ.
  const crcs = png.entries.map((e) => e.crc);
  const uniqueCrc = new Set(crcs).size;
  t.check('all 5 frames differ pairwise (camera moves)', uniqueCrc === 5,
    `unique=${uniqueCrc} crcs=${crcs.join(',')}`);

  // --- State restored after the render -------------------------------------
  const after = await t.evaluate(`(() => {
    const s = window.__app.scene;
    return { frame: s.frameCurrent, shading: window.__app.renderer.shadingMode, cameraViewId: window.__app.renderer.cameraViewId, running: window.__app.animRender.isRunning() };
  })()`);
  t.check('frameCurrent restored', after.frame === before.frame, `before=${before.frame} after=${after.frame}`);
  t.check('shading mode restored', after.shading === before.shading, `before=${before.shading} after=${after.shading}`);
  t.check('cameraViewId restored', after.cameraViewId === before.cameraViewId,
    `before=${before.cameraViewId} after=${after.cameraViewId}`);
  t.check('not running after completion', after.running === false);

  // --- Cancel mid-run resolves cleanly (null) ------------------------------
  const cancelResult = await evalAsync(`(async () => {
    const p = window.__app.animRender.render({ mode: 'png', start: 1, end: 20 });
    // Cancel shortly after kickoff (the loop yields per frame via rAF).
    setTimeout(() => window.__app.animRender.cancel(), 30);
    const blob = await p;
    return { isNull: blob === null, running: window.__app.animRender.isRunning() };
  })()`);
  t.check('cancel() mid-run resolves to null', cancelResult.isNull, `isNull=${cancelResult.isNull}`);
  t.check('not running after cancel', cancelResult.running === false);

  // --- WebM mode: a video/webm Blob with size > 0 for 5 frames -------------
  const webm = await evalAsync(`(async () => {
    const blob = await window.__app.animRender.render({ mode: 'webm', start: 1, end: 5, fps: 24 });
    return blob ? { type: blob.type, size: blob.size } : null;
  })()`);
  t.check('WebM render returned a Blob', webm !== null);
  t.check('WebM blob is video/webm', !!webm && webm.type === 'video/webm', webm && webm.type);
  t.check('WebM blob size > 0', !!webm && webm.size > 0, webm && `size=${webm.size}`);

  // =========================================================================
  // UR5-3 — Path-traced engine + MP4/format menu
  // =========================================================================

  // (1) Path-traced PNG-sequence render: a 2-frame range at tiny spp (8) and a
  // small canvas → zip blob produced; both frames non-black and DIFFERENT (the
  // flythrough camera — a keyed object — moves, and each frame is seeded by its
  // index so the noise differs too). We decode each stored PNG in-page and read
  // its pixels to prove non-black + per-frame difference.
  const pt = await evalAsync(`(async () => {
    const blob = await window.__app.animRender.render({
      mode: 'png', engine: 'pathtraced', samples: 8, start: 1, end: 2, width: 96, height: 64,
    });
    const buf = new Uint8Array(await blob.arrayBuffer());
    const dv = new DataView(buf.buffer);
    // Extract stored PNG bytes from each local file header (store method).
    const pngs = [];
    let p = 0;
    while (p + 4 <= buf.length && dv.getUint32(p, true) === 0x04034b50) {
      const csize = dv.getUint32(p + 18, true);
      const nameLen = dv.getUint16(p + 26, true);
      const extraLen = dv.getUint16(p + 28, true);
      const dataStart = p + 30 + nameLen + extraLen;
      pngs.push(buf.slice(dataStart, dataStart + csize));
      p = dataStart + csize;
    }
    // Decode each PNG → canvas → pixels; measure max luma + a cheap fingerprint.
    const decode = async (bytes) => {
      const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const c = document.createElement('canvas');
      c.width = bmp.width; c.height = bmp.height;
      const g = c.getContext('2d');
      g.drawImage(bmp, 0, 0);
      const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
      let maxV = 0, sum = 0;
      for (let i = 0; i < d.length; i += 4) {
        const v = d[i] + d[i + 1] + d[i + 2];
        if (v > maxV) maxV = v;
        sum += v;
      }
      return { w: bmp.width, h: bmp.height, maxV, sum };
    };
    const stats = [];
    for (const png of pngs) stats.push(await decode(png));
    return { type: blob.type, count: pngs.length, stats };
  })()`);
  t.check('path-traced PNG zip is application/zip', pt.type === 'application/zip', pt.type);
  t.check('path-traced produced 2 frames', pt.count === 2, `count=${pt.count}`);
  t.check('traced frames are 96x64', pt.stats.every((s) => s.w === 96 && s.h === 64),
    JSON.stringify(pt.stats.map((s) => `${s.w}x${s.h}`)));
  t.check('both traced frames are non-black', pt.stats.every((s) => s.maxV > 10),
    JSON.stringify(pt.stats.map((s) => s.maxV)));
  t.check('the two traced frames DIFFER (object/camera keyed to move)',
    pt.stats.length === 2 && pt.stats[0].sum !== pt.stats[1].sum,
    JSON.stringify(pt.stats.map((s) => s.sum)));

  // (2) Cancel mid-run (path-traced) restores frameCurrent + shading mode.
  const ptCancel = await evalAsync(`(async () => {
    const s = window.__app.scene;
    const r = window.__app.renderer;
    r.shadingMode = 'matcap';
    s.frameCurrent = 13; // distinctive
    const before = { frame: s.frameCurrent, shading: r.shadingMode };
    const p = window.__app.animRender.render({
      mode: 'png', engine: 'pathtraced', samples: 64, start: 1, end: 12, width: 96, height: 64,
    });
    setTimeout(() => window.__app.animRender.cancel(), 40);
    const blob = await p;
    return {
      isNull: blob === null,
      running: window.__app.animRender.isRunning(),
      before,
      after: { frame: s.frameCurrent, shading: r.shadingMode },
    };
  })()`);
  t.check('path-traced cancel resolves to null', ptCancel.isNull, `isNull=${ptCancel.isNull}`);
  t.check('not running after path-traced cancel', ptCancel.running === false);
  t.check('frameCurrent restored after path-traced cancel',
    ptCancel.after.frame === ptCancel.before.frame,
    `before=${ptCancel.before.frame} after=${ptCancel.after.frame}`);
  t.check('shading mode restored after path-traced cancel',
    ptCancel.after.shading === ptCancel.before.shading,
    `before=${ptCancel.before.shading} after=${ptCancel.after.shading}`);

  // (4) MP4 format option is shown/hidden CONSISTENTLY with the browser probe.
  const mp4 = await evalAsync(`(async () => {
    window.__app.animRender.open();
    const sel = document.querySelector('[data-testid=anim-format]');
    const values = sel ? Array.from(sel.options).map((o) => o.value) : [];
    const CANDIDATES = [
      'video/mp4;codecs=avc1.42E01E',
      'video/mp4;codecs=avc1.640028',
      'video/mp4;codecs=h264',
      'video/mp4',
    ];
    const supported = CANDIDATES.some((c) => MediaRecorder.isTypeSupported(c));
    window.__app.animRender.close();
    return { values, menuHasMp4: values.includes('mp4'), supported };
  })()`);
  t.check('format menu always offers WebM + PNG',
    mp4.values.includes('webm') && mp4.values.includes('png'), JSON.stringify(mp4.values));
  t.check('MP4 menu option matches MediaRecorder support (consistency)',
    mp4.menuHasMp4 === mp4.supported,
    `menuHasMp4=${mp4.menuHasMp4} supported=${mp4.supported}`);

  // --- start >= end is refused ---------------------------------------------
  const refused = await evalAsync(`(async () => {
    try { await window.__app.animRender.render({ mode: 'png', start: 5, end: 5 }); return 'resolved'; }
    catch (e) { return 'rejected'; }
  })()`);
  t.check('start >= end is refused', refused === 'rejected', refused);

  // Clean up for later suites.
  await t.evaluate(`(() => {
    const s = window.__app.scene;
    s.frameStart = 1; s.frameEnd = 250; s.frameCurrent = 1;
    window.__app.renderer.cameraViewId = null;
    window.__app.animRender.close();
  })()`);
});
