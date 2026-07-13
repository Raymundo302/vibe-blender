/**
 * UR16-3 e2e — Render Properties tab + transparent background + GPU load limit.
 *
 * Run with the dev server up on 5199:
 *   E2E_PORT=9815 flock /tmp/vibe-blender-e2e.lock node e2e/ur16-3-render-tab.mjs
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  // awaitPromise helper (the shared evaluate() doesn't await page promises).
  const evalAsync = async (expr) => {
    const { result, exceptionDetails } = await t.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    });
    if (exceptionDetails) throw new Error(`page threw: ${exceptionDetails.text}`);
    return result.value;
  };

  await t.until('!!window.__renderEngine && !!window.__app');
  // Fresh default scene (a centered cube, sky in the corners), no active camera.
  await t.evaluate(`(() => {
    const s = window.__app.scene;
    if (s.editMode) s.exitEditMode();
    for (const o of [...s.objects]) if (o.kind !== 'mesh') s.remove(o.id);
    s.renderSettings = { width: 96, height: 72, transparent: false };
  })()`);

  // ---- (1) Render tab present with all rows + round-trips -------------------
  t.check('Render tab button present', await t.evaluate(
    `!!document.querySelector('.properties-tab-btn[data-tab="render"]')`));
  const rowsPresent = await t.evaluate(`(() => {
    const ids = ['render-engine','render-samples','res-x','res-y','still-format','anim-format','transparent','limit-gpu'];
    return ids.every((id) => !!document.querySelector('[data-testid="'+id+'"]'));
  })()`);
  t.check('Render tab has all rows (engine/samples/res/output/transparent/limit)', rowsPresent);

  t.check('Camera-tab Resolution pointer present', await t.evaluate(
    `!!document.querySelector('[data-field="resolution-pointer"]')`));

  // Engine round-trip: tab select → viewPrefs → render window.
  const engineRT = await t.evaluate(`(() => {
    const el = document.querySelector('[data-testid="render-engine"]');
    el.value = 'cpu'; el.dispatchEvent(new Event('change', { bubbles: true }));
    const okCpu = window.__renderEngine.enginePref() === 'cpu';
    el.value = 'gpu'; el.dispatchEvent(new Event('change', { bubbles: true }));
    const okGpu = window.__renderEngine.enginePref() === 'gpu';
    return okCpu && okGpu;
  })()`);
  t.check('Engine select round-trips to the render window (viewPrefs)', engineRT);

  // Samples round-trip: tab field → render window samples().
  const samplesRT = await t.evaluate(`(() => {
    const el = document.querySelector('[data-testid="render-samples"]');
    el.value = '77'; el.dispatchEvent(new Event('change', { bubbles: true }));
    return window.__renderEngine.samples() === 77;
  })()`);
  t.check('Samples field round-trips to the render window', samplesRT);

  // Resolution round-trip: tab field → scene.renderSettings (undoable).
  const resRT = await t.evaluate(`(() => {
    const el = document.querySelector('[data-testid="res-x"]');
    el.value = '321'; el.dispatchEvent(new Event('change', { bubbles: true }));
    const ok = window.__app.scene.renderSettings.width === 321;
    window.__app.undo.undo();
    const undone = window.__app.scene.renderSettings.width !== 321;
    return ok && undone;
  })()`);
  t.check('Resolution X edits scene.renderSettings + undoable', resRT);

  // Reset to a small render size for the fast alpha probes.
  await t.evaluate(`window.__app.scene.renderSettings = { width: 96, height: 72, transparent: false };`);
  await t.evaluate(`window.__renderEngine.setSamples(16)`);

  const gpuAvail = await t.evaluate('window.__renderEngine.gpuAvailable()');

  // Probe alpha off the CURRENT render-window canvas: corner (1,1) vs the
  // central 20% region (max alpha, the cube).
  const probeAlpha = () => t.evaluate(`(() => {
    const cv = window.__renderEngine.canvas();
    const ctx = cv.getContext('2d');
    const w = cv.width, h = cv.height;
    const corner = ctx.getImageData(1, 1, 1, 1).data[3];
    const d = ctx.getImageData(Math.floor(w*0.4), Math.floor(h*0.4), Math.max(1,Math.floor(w*0.2)), Math.max(1,Math.floor(h*0.2))).data;
    let cmax = 0; for (let p = 3; p < d.length; p += 4) cmax = Math.max(cmax, d[p]);
    return { corner, cmax };
  })()`);

  // ---- (3) transparent OFF unchanged: corner is opaque sky (alpha 255) -----
  await t.evaluate(`window.__renderEngine.setEngine('${gpuAvail ? 'gpu' : 'cpu'}')`);
  await t.key('F12', 'F12', 0);
  await t.until('window.__renderEngine.sample() >= 8', 40000);
  const off = await probeAlpha();
  t.check('transparent OFF: corner alpha 255 (opaque, world drawn)', off.corner === 255,
    `corner=${off.corner}`);
  t.check('transparent OFF: cube alpha 255', off.cmax === 255, `cmax=${off.cmax}`);
  await t.evaluate('window.__renderEngine.close()');
  await t.sleep(100);

  // ---- (2) transparent ON, GPU: corner alpha 0, cube alpha 255 -------------
  await t.evaluate(`window.__app.scene.renderSettings = { width: 96, height: 72, transparent: true };`);
  if (gpuAvail) {
    await t.evaluate(`window.__renderEngine.setEngine('gpu')`);
    await t.key('F12', 'F12', 0);
    await t.until('window.__renderEngine.sample() >= 8', 40000);
    const on = await probeAlpha();
    t.check('transparent ON (GPU): corner alpha 0', on.corner === 0, `corner=${on.corner}`);
    t.check('transparent ON (GPU): cube alpha 255', on.cmax === 255, `cmax=${on.cmax}`);

    // Save PNG re-decoded keeps alpha (toDataURL → Image → canvas → readback).
    await t.evaluate(`(() => {
      window.__alphaProbe = null;
      const cv = window.__renderEngine.canvas();
      const url = cv.toDataURL('image/png');
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
        const cx = c.getContext('2d'); cx.drawImage(img, 0, 0);
        const w = c.width, h = c.height;
        const corner = cx.getImageData(1, 1, 1, 1).data[3];
        const d = cx.getImageData(Math.floor(w*0.4), Math.floor(h*0.4), Math.max(1,Math.floor(w*0.2)), Math.max(1,Math.floor(h*0.2))).data;
        let cmax = 0; for (let p = 3; p < d.length; p += 4) cmax = Math.max(cmax, d[p]);
        window.__alphaProbe = { corner, cmax };
      };
      img.src = url;
    })()`);
    await t.until('!!window.__alphaProbe', 8000);
    const png = await t.evaluate('window.__alphaProbe');
    t.check('Save PNG re-decoded keeps alpha (corner 0, cube 255)',
      png.corner === 0 && png.cmax === 255, `corner=${png.corner} cube=${png.cmax}`);

    // The render-window preview shows a checkerboard behind the canvas so alpha
    // is visualized (Ray's "transparent render over a checker").
    const checker = await t.evaluate(`(() => {
      const cv = window.__renderEngine.canvas();
      const cs = getComputedStyle(cv);
      return { hasClass: cv.classList.contains('render-win-canvas-alpha'), grad: /gradient/.test(cs.backgroundImage) };
    })()`);
    t.check('transparent preview shows the alpha checkerboard', checker.hasClass && checker.grad,
      JSON.stringify(checker));
    await t.screenshot('/tmp/ur16-3-transparent.png');
    await t.evaluate('window.__renderEngine.close()');
    await t.sleep(100);
  } else {
    t.check('GPU tracer unavailable — skipping GPU transparent probes', true);
  }

  // ---- (2b) transparent ON, CPU engine: same alpha result ------------------
  await t.evaluate(`window.__renderEngine.setEngine('cpu')`);
  await t.key('F12', 'F12', 0);
  await t.until('window.__renderEngine.sample() >= 8', 60000);
  const cpu = await probeAlpha();
  t.check('transparent ON (CPU): corner alpha 0', cpu.corner === 0, `corner=${cpu.corner}`);
  t.check('transparent ON (CPU): cube alpha 255', cpu.cmax === 255, `cmax=${cpu.cmax}`);
  await t.evaluate('window.__renderEngine.close()');
  await t.sleep(100);

  // ---- (2c) PNG-sequence frame carries alpha -------------------------------
  // Render a 2-frame transparent PNG sequence and decode the first PNG's alpha.
  await t.evaluate(`window.__app.scene.renderSettings = { width: 64, height: 48, transparent: true };`);
  const pngSeq = await evalAsync(`(async () => {
    const blob = await window.__app.animRender.render({
      mode: 'png', engine: 'pathtraced', samples: 8, width: 64, height: 48, start: 1, end: 2,
    });
    if (!blob) return { ok: false };
    const buf = new Uint8Array(await blob.arrayBuffer());
    // Find the first embedded PNG (STORE zip → verbatim bytes): signature .. IEND+crc.
    const sig = [0x89, 0x50, 0x4e, 0x47];
    let start = -1;
    for (let i = 0; i + 4 < buf.length; i++) {
      if (buf[i] === sig[0] && buf[i+1] === sig[1] && buf[i+2] === sig[2] && buf[i+3] === sig[3]) { start = i; break; }
    }
    if (start < 0) return { ok: false };
    let end = -1;
    for (let i = start; i + 8 <= buf.length; i++) {
      if (buf[i] === 0x49 && buf[i+1] === 0x45 && buf[i+2] === 0x4e && buf[i+3] === 0x44) { end = i + 8; break; }
    }
    if (end < 0) return { ok: false };
    const pngBlob = new Blob([buf.slice(start, end)], { type: 'image/png' });
    const url = URL.createObjectURL(pngBlob);
    const alpha = await new Promise((res) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
        const cx = c.getContext('2d'); cx.drawImage(img, 0, 0);
        const w = c.width, h = c.height;
        const corner = cx.getImageData(1, 1, 1, 1).data[3];
        const d = cx.getImageData(Math.floor(w*0.4), Math.floor(h*0.4), Math.max(1,Math.floor(w*0.2)), Math.max(1,Math.floor(h*0.2))).data;
        let cmax = 0; for (let p = 3; p < d.length; p += 4) cmax = Math.max(cmax, d[p]);
        res({ corner, cmax });
      };
      img.onerror = () => res(null);
      img.src = url;
    });
    URL.revokeObjectURL(url);
    return { ok: true, alpha };
  })()`);
  t.check('PNG-seq render produced a decodable frame', pngSeq.ok && !!pngSeq.alpha);
  if (pngSeq.ok && pngSeq.alpha) {
    t.check('PNG-seq frame alpha: corner 0, cube 255',
      pngSeq.alpha.corner === 0 && pngSeq.alpha.cmax === 255,
      `corner=${pngSeq.alpha.corner} cube=${pngSeq.alpha.cmax}`);
  }

  // ---- (4) Limit GPU load: F12 completes + per-batch spp capped ------------
  if (gpuAvail) {
    // Cap read: off → 16, on → 8 (via the tab checkbox).
    const capOff = await t.evaluate('window.__renderEngine.gpuBatchCap()');
    await t.evaluate(`(() => {
      const el = document.querySelector('[data-testid="limit-gpu"]');
      el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    const capOn = await t.evaluate('window.__renderEngine.gpuBatchCap()');
    t.check('Limit GPU load shrinks the per-batch cap (16 → 8)', capOff === 16 && capOn === 8,
      `off=${capOff} on=${capOn}`);

    await t.evaluate(`window.__app.scene.renderSettings = { width: 64, height: 48, transparent: false };`);
    await t.evaluate(`window.__renderEngine.setEngine('gpu')`);
    await t.evaluate(`window.__renderEngine.setSamples(16)`);
    await t.key('F12', 'F12', 0);
    const done = await t.until('window.__renderEngine.sample() >= 16', 40000);
    t.check('Limit GPU load ON: F12 still completes (reaches the samples cap)', done);
    const lastMax = await t.evaluate('window.__renderEngine.gpuLastMaxBatch()');
    t.check('Limit GPU load ON: per-batch spp capped (≤ 8)', lastMax > 0 && lastMax <= 8,
      `lastMaxBatch=${lastMax}`);
    await t.evaluate('window.__renderEngine.close()');
    // Restore the pref.
    await t.evaluate(`(() => {
      const el = document.querySelector('[data-testid="limit-gpu"]');
      el.checked = false; el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
  } else {
    t.check('GPU unavailable — skipping GPU load-limit probe', true);
  }

  // Cleanup: opaque default resolution back.
  await t.evaluate(`(() => {
    window.__app.scene.renderSettings = { width: 1920, height: 1080, transparent: false };
    window.__renderEngine.setSamples(512);
  })()`);
});
