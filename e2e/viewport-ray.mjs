/**
 * UR15-1 — Viewport raytraced mode (Rendered → Live | Raytraced).
 *
 * Drives the progressive path tracer that accumulates INTO the viewport (not the
 * F12 window). Each renderer.render() call is one accumulation tick, so the tests
 * force ticks in-page and read the driver state (window.__app.viewportRay) + the
 * tonemapped image (renderer.viewportRay.imageBytes) + the GL canvas (overlays).
 *
 * Runs on E2E_GPU=1 (real GPU) AND SwiftShader. The GPU-engine checks are gated on
 * viewportRay.gpuAvailable() — the GPU tracer IS available on SwiftShader (float
 * targets), but if a backend ever lacks it the GPU checks skip and the CPU-engine
 * checks (which are pure main-thread JS, backend-independent) still run.
 *
 * Sample counts kept modest so SwiftShader finishes in a few minutes; the F12
 * comparison is over 32² BLOCK luminance (each block averages ~1000 px), so path
 * noise averages out and a low spp still matches within the threshold.
 *
 *   E2E_PORT=9711 node e2e/viewport-ray.mjs http://localhost:5199/
 *   E2E_GPU=1 E2E_PORT=9711 node e2e/viewport-ray.mjs http://localhost:5199/
 */
import { runE2e } from './harness.mjs';

const BACKEND = process.env.E2E_GPU ? 'REAL-GPU' : 'SwiftShader';

/** Mean absolute difference of two equal-length numeric arrays (0..1 space). */
function mad(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

/** Max absolute per-element difference (0..1 space) — catches a localized change
 *  (a cube silhouette sweeping across blocks) that a mean would wash out. */
function maxDiff(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

runE2e(async (t) => {
  console.log(`\n== viewport-ray on ${BACKEND} ==`);
  await t.key('Escape', 'Escape', 0); // dismiss splash

  // In-page helpers: block-luminance downsample, tick loop, converge-to-spp.
  await t.evaluate(`(() => {
    // 32x32 block-average luminance (0..1) of an RGBA byte buffer, row 0 = top.
    window.__lum32 = (bytes, w, h) => {
      const N = 32, out = new Array(N * N).fill(0);
      const cnt = new Array(N * N).fill(0);
      for (let y = 0; y < h; y++) {
        const by = Math.min(N - 1, (y * N / h) | 0);
        for (let x = 0; x < w; x++) {
          const bx = Math.min(N - 1, (x * N / w) | 0);
          const i = (y * w + x) * 4;
          const lum = (0.2126 * bytes[i] + 0.7152 * bytes[i + 1] + 0.0722 * bytes[i + 2]) / 255;
          const b = by * N + bx;
          out[b] += lum; cnt[b]++;
        }
      }
      for (let b = 0; b < out.length; b++) out[b] = cnt[b] ? out[b] / cnt[b] : 0;
      return out;
    };
    // Force n accumulation ticks (each render() = one tick). flushSync completes
    // the fenced GPU batch + presents synchronously (2026-07-20 pacing pass), so
    // spp/imageBytes read as if the pipeline were synchronous — the suite's
    // semantics predate the fences and keep working unchanged.
    window.__tick = (n) => {
      const a = window.__app;
      for (let i = 0; i < n; i++) { a.renderer.render(a.scene, a.camera); a.renderer.viewportRay.flushSync(); }
    };
    // Tick until spp >= target (or maxTicks), return the reached spp.
    window.__converge = (target, maxTicks) => {
      const a = window.__app;
      for (let i = 0; i < maxTicks && a.renderer.viewportRay.spp < target; i++) {
        a.renderer.render(a.scene, a.camera);
        a.renderer.viewportRay.flushSync();
      }
      return a.renderer.viewportRay.spp;
    };
    // 32² block luminance of the CURRENT viewport ray image.
    window.__rayLum = () => {
      const vr = window.__app.renderer.viewportRay;
      return vr.imageBytes ? window.__lum32(vr.imageBytes, vr.imageW, vr.imageH) : null;
    };
    // Central-pixel [r,g,b] of the current ray image.
    window.__rayCenter = () => {
      const vr = window.__app.renderer.viewportRay;
      if (!vr.imageBytes) return null;
      const i = ((vr.imageH >> 1) * vr.imageW + (vr.imageW >> 1)) * 4;
      return [vr.imageBytes[i], vr.imageBytes[i + 1], vr.imageBytes[i + 2]];
    };
    // Count SATURATED canvas pixels (overlay gizmo/outline colors that the grey
    // traced cube + dark bg + faint grid never produce). Reads the GL framebuffer.
    window.__saturatedCount = () => {
      const a = window.__app, gl = a.renderer.ctx.gl, c = gl.canvas;
      a.renderer.render(a.scene, a.camera);
      const px = new Uint8Array(c.width * c.height * 4);
      gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let n = 0;
      for (let i = 0; i < px.length; i += 4) {
        const r = px[i], g = px[i + 1], b = px[i + 2];
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        if (mx > 90 && mx - mn > 70) n++;
      }
      return n;
    };
  })()`);

  // Grab a small 8x8 grid of canvas pixels (byte-exact) for the live-unchanged
  // comparison.
  const gridPixels = () => t.evaluate(`(() => {
    const a = window.__app, gl = a.renderer.ctx.gl, c = gl.canvas;
    a.renderer.render(a.scene, a.camera);
    const out = [];
    for (let gy = 0; gy < 8; gy++) for (let gx = 0; gx < 8; gx++) {
      const x = Math.floor((gx + 0.5) * c.width / 8), y = Math.floor((gy + 0.5) * c.height / 8);
      const p = new Uint8Array(4);
      gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p);
      out.push(p[0], p[1], p[2]);
    }
    return out;
  })()`);

  const gpuAvailable = await t.evaluate('window.__app.viewportRay.gpuAvailable()');
  console.log(`GPU tracer available: ${gpuAvailable} (${await t.evaluate('window.__app.viewportRay.gpuReason()')})`);

  // Enter Rendered mode (Live) so the shading menu shows the Rendered sub-choice.
  await t.evaluate(`(() => {
    const a = window.__app;
    a.renderer.shadingMode = 'rendered';
    a.shadePrefs.renderedMode = 'live';
    a.scene.deselectAll();
  })()`);
  await t.sleep(60);

  // ------------------------------------------------------------------ UI menu
  await t.evaluate(`document.querySelector('.shading-menu-btn').click()`);
  await t.sleep(80);
  t.check('shading menu shows the Rendered Mode select (Live|Raytraced)',
    await t.evaluate(`(() => {
      const s = document.querySelector('[data-rendered-mode]');
      return !!s && [...s.options].map(o => o.value).join(',') === 'live,ray';
    })()`));
  t.check('Engine select hidden while Mode = Live',
    await t.evaluate(`(() => {
      const r = document.querySelector('[data-ray-engine]');
      return !!r && r.closest('.shading-menu-select-row').style.display === 'none';
    })()`));
  // Switch Mode → Raytraced via the select; the Engine row should reveal.
  await t.evaluate(`(() => {
    const s = document.querySelector('[data-rendered-mode]');
    s.value = 'ray'; s.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(60);
  t.check('shadePrefs.renderedMode = ray after choosing Raytraced',
    (await t.evaluate('window.__app.shadePrefs.renderedMode')) === 'ray');
  t.check('Engine select (GPU|CPU) reveals when Raytraced, GPU listed first',
    await t.evaluate(`(() => {
      const r = document.querySelector('[data-ray-engine]');
      return !!r && r.closest('.shading-menu-select-row').style.display !== 'none'
        && [...r.options].map(o => o.value).join(',') === 'gpu,cpu';
    })()`));
  await t.key('Escape', 'Escape', 0);
  await t.sleep(40);

  // ================================================================= GPU tests
  if (gpuAvailable) {
    // (1) GPU: switch Rendered→Raytraced GPU, spp climbs, converges to match F12.
    await t.evaluate(`window.__app.shadePrefs.rayEngine = 'gpu'`);
    // First ticks from a fresh accumulation.
    const spp1 = await t.evaluate('window.__converge(4, 20)');
    const spp2 = await t.evaluate('window.__converge(24, 60)');
    t.check('GPU spp counter climbs (>= 24 after ticking)', spp2 >= 24, `spp ${spp1} -> ${spp2}`);
    t.check('GPU engine reported', (await t.evaluate('window.__app.viewportRay.engine()')) === 'gpu');

    const rayLum = await t.evaluate('window.__rayLum()');
    // F12 GPU reference: same scene + same camera + same resolution as the ray
    // image, tonemapped identically, 32² block luminance. Capped at 24 spp so
    // SwiftShader finishes quickly (block luminance is converged well before that).
    await t.evaluate(`(async () => {
      try {
        const vr = window.__app.renderer.viewportRay;
        const w = vr.imageW, h = vr.imageH, spp = Math.min(vr.spp, 24);
        const snapMod = await import('/src/renderEngine/snapshot.ts');
        const shared = await import('/src/renderEngine/gpu/sharedTracer.ts');
        const rw = await import('/src/renderEngine/renderWindow.ts');
        const app = window.__app;
        const snap = snapMod.buildSnapshot(app.scene, app.camera);
        const tr = shared.getGpuTracer();
        tr.setSnapshot(snap);
        const avg = tr.render(w, h, spp, 0x1234567); // averaged RGBA, row0=top
        const rgb = new Float32Array(w * h * 3);
        for (let i = 0; i < w * h; i++) { rgb[i*3]=avg[i*4]; rgb[i*3+1]=avg[i*4+1]; rgb[i*3+2]=avg[i*4+2]; }
        const out = new Uint8ClampedArray(w * h * 4);
        rw.tonemapAccumToRgba(rgb, 1, out);
        window.__f12lum = window.__lum32(out, w, h);
      } catch (e) { window.__f12err = String(e && e.stack || e); }
    })()`);
    // The async import resolves after the evaluate returns; poll for the result.
    const f12ok = await t.until('!!window.__f12lum || !!window.__f12err', 90000);
    if (await t.evaluate('!!window.__f12err')) console.log('F12 ref error:', await t.evaluate('window.__f12err'));
    t.check('F12 GPU reference built', f12ok && await t.evaluate('!!window.__f12lum'));
    const f12 = await t.evaluate('window.__f12lum');
    const diff1 = f12 && rayLum ? mad(rayLum, f12) : NaN;
    t.check('(1) GPU viewport converges to match an F12 GPU render (32² lum MAD < 0.05)',
      diff1 < 0.05, `MAD ${Number.isFinite(diff1) ? diff1.toFixed(4) : 'n/a'}`);

    // (2) orbit → spp RESETS and keeps rendering (no stale ghost).
    const beforeLum = await t.evaluate('window.__rayLum()');
    const sppReset = await t.evaluate(`(() => {
      const a = window.__app;
      a.camera.yaw += 1.1; a.camera.pitch += 0.25;
      a.renderer.render(a.scene, a.camera); // this tick sees the view change → reset
      return a.renderer.viewportRay.spp;
    })()`);
    t.check('(2a) orbit RESETS the sample count', sppReset < 24, `spp after orbit ${sppReset}`);
    const sppAfter = await t.evaluate('window.__converge(8, 40)');
    const afterLum = await t.evaluate('window.__rayLum()');
    // Grey cube on a floor has near rotation-invariant MEAN block luminance, so
    // the "must change" probe is the MAX per-block change (the silhouette sweep).
    const orbitDiff = maxDiff(beforeLum, afterLum);
    t.check('(2b) orbit changes the image (no stale ghost)', orbitDiff > 0.03,
      `maxBlockDiff ${orbitDiff.toFixed(4)}, engine ${await t.evaluate('window.__app.viewportRay.engine()')}`);
    t.check('(2c) still rendering after orbit (spp > 0)', sppAfter > 0, `spp ${sppAfter}`);

    // (3) edit a material color → reset + the new color appears. The materialId
    // reassignment is caught INSTANTLY by the cheap per-frame content key
    // (2026-07-20 — version counters, no snapshot build); pure per-field pokes
    // on an already-assigned material would land via the rare full sweep.
    await t.evaluate('window.__converge(16, 60)');
    const beforeColor = await t.evaluate('window.__rayCenter()');
    const sppAfterMat = await t.evaluate(`(() => {
      const a = window.__app, S = a.scene;
      const mat = S.addMaterial('RayRed'); mat.baseColor = [0.85, 0.05, 0.05];
      const cube = S.objects.find(o => o.name === 'Cube'); cube.materialId = mat.id;
      a.renderer.render(a.scene, a.camera); // content changed → reset
      return a.renderer.viewportRay.spp;
    })()`);
    t.check('(3a) material edit RESETS the accumulation', sppAfterMat < 16, `spp ${sppAfterMat}`);
    await t.evaluate('window.__converge(16, 60)');
    const afterColor = await t.evaluate('window.__rayCenter()');
    t.check('(3b) new red material appears in the traced image',
      afterColor && afterColor[0] > afterColor[2] + 25 && afterColor[0] > (beforeColor ? beforeColor[0] : 0),
      `center ${JSON.stringify(beforeColor)} -> ${JSON.stringify(afterColor)}`);

    // (4) gizmo + selection outline visible OVER the traced image.
    const satSel = await t.evaluate(`(() => {
      const a = window.__app, S = a.scene;
      const cube = S.objects.find(o => o.name === 'Cube'); S.selectOnly(cube.id);
      a.renderer.gizmoVisible = true;
      return window.__saturatedCount();
    })()`);
    const satNone = await t.evaluate(`(() => { window.__app.scene.deselectAll(); return window.__saturatedCount(); })()`);
    t.check('(4) gizmo + outline draw OVER the traced image (selection adds saturated overlay pixels)',
      satSel - satNone > 200, `selected ${satSel} vs deselected ${satNone} (delta ${satSel - satNone})`);
    // Re-select for the mid-convergence screenshot.
    await t.evaluate(`(() => { const S = window.__app.scene; S.selectOnly(S.objects.find(o=>o.name==='Cube').id); })()`);
    await t.evaluate('window.__converge(20, 80)');
    await t.screenshot('e2e/screenshots/viewport-ray-gpu.png');
    console.log('screenshot: e2e/screenshots/viewport-ray-gpu.png');
  } else {
    t.check('GPU tracer unavailable on this backend — GPU checks skipped (CPU below)', true);
  }

  // ================================================================= CPU tests
  // (5) Engine CPU also converges (small spp; CPU is pure main-thread JS).
  await t.evaluate(`(() => {
    const a = window.__app, S = a.scene;
    // Reset the cube to the default grey material for a clean CPU render.
    const cube = S.objects.find(o => o.name === 'Cube'); cube.materialId = null;
    S.deselectAll();
    a.shadePrefs.rayEngine = 'cpu';
    a.renderer.render(a.scene, a.camera); // engine switch → reset
  })()`);
  const cpuSpp = await t.evaluate('window.__converge(16, 40)');
  t.check('(5a) CPU engine reported', (await t.evaluate('window.__app.viewportRay.engine()')) === 'cpu');
  t.check('(5b) CPU spp climbs', cpuSpp >= 16, `spp ${cpuSpp}`);
  const cpuLum = await t.evaluate('window.__rayLum()');
  // CPU render vs a CPU-tracer reference of the same scene/camera/res (same
  // engine, so RNG-comparable) — 32² block luminance.
  await t.evaluate(`(async () => {
    try {
      const vr = window.__app.renderer.viewportRay;
      const w = vr.imageW, h = vr.imageH, spp = vr.spp;
      const snapMod = await import('/src/renderEngine/snapshot.ts');
      const tracer = await import('/src/renderEngine/tracer.ts');
      const rw = await import('/src/renderEngine/renderWindow.ts');
      const app = window.__app;
      const snap = snapMod.buildSnapshot(app.scene, app.camera);
      const sc = tracer.prepareScene(snap);
      const accum = new Float32Array(w * h * 3);
      for (let s = 0; s < spp; s++) tracer.renderSample(sc, accum, w, h, s, 0x1234567);
      const out = new Uint8ClampedArray(w * h * 4);
      rw.tonemapAccumToRgba(accum, spp, out);
      window.__cpuRef = window.__lum32(out, w, h);
    } catch (e) { window.__cpuErr = String(e && e.stack || e); }
  })()`);
  const cpuRefOk = await t.until('!!window.__cpuRef || !!window.__cpuErr', 90000);
  if (await t.evaluate('!!window.__cpuErr')) console.log('CPU ref error:', await t.evaluate('window.__cpuErr'));
  t.check('CPU reference built', cpuRefOk && await t.evaluate('!!window.__cpuRef'));
  const cpuRef = await t.evaluate('window.__cpuRef');
  const cpuDiff = cpuRef && cpuLum ? mad(cpuLum, cpuRef) : NaN;
  t.check('(5c) CPU viewport converges to a real render (32² lum MAD < 0.05)',
    cpuDiff < 0.05, `MAD ${Number.isFinite(cpuDiff) ? cpuDiff.toFixed(4) : 'n/a'}`);
  await t.screenshot('e2e/screenshots/viewport-ray-cpu.png');
  console.log('screenshot: e2e/screenshots/viewport-ray-cpu.png');

  // ================================================================= (6) live
  // Self-contained at a FIXED camera: capture a Live frame, detour through Ray,
  // return to Live → the frame must be BIT-IDENTICAL (my changes never touch the
  // Live raster path). (The cube is back on the default material, deselected.)
  await t.evaluate(`(() => {
    const a = window.__app;
    a.renderer.shadingMode = 'rendered';
    a.shadePrefs.renderedMode = 'live';
    a.scene.deselectAll();
  })()`);
  await t.sleep(40);
  const liveA = await gridPixels();
  await t.evaluate(`(() => { const a = window.__app; a.shadePrefs.renderedMode = 'ray'; window.__tick(4); })()`);
  await t.evaluate(`(() => { const a = window.__app; a.shadePrefs.renderedMode = 'live'; a.scene.deselectAll(); })()`);
  await t.sleep(40);
  const liveB = await gridPixels();
  const identical = liveA.length === liveB.length && liveA.every((v, i) => v === liveB[i]);
  t.check('(6) Live mode unchanged — bit-identical across a Ray detour', identical);

  // ================================================================= (7) persist
  // Drive persistence through the real menu selects (their change handlers call
  // the app's own saveShadePrefs on the live singleton — a dynamic import() can
  // resolve to a DUPLICATE module instance whose default singleton never mutated).
  await t.evaluate(`(() => { window.__app.renderer.shadingMode = 'rendered'; document.querySelector('.shading-menu-btn').click(); })()`);
  await t.sleep(80);
  await t.evaluate(`(() => {
    const md = document.querySelector('[data-rendered-mode]'); md.value = 'ray'; md.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(40);
  await t.evaluate(`(() => {
    const en = document.querySelector('[data-ray-engine]'); en.value = 'cpu'; en.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(40);
  await t.key('Escape', 'Escape', 0);
  await t.until(`(() => { const s = localStorage.getItem('vibe-shading-v7'); return s && JSON.parse(s).renderedMode === 'ray' && JSON.parse(s).rayEngine === 'cpu'; })()`);
  console.log('stored v7 before reload:', await t.evaluate(`localStorage.getItem('vibe-shading-v7')`));
  await t.reload();
  const persistedMode = await t.evaluate('window.__app.shadePrefs.renderedMode');
  const persistedEngine = await t.evaluate('window.__app.shadePrefs.rayEngine');
  t.check('(7) renderedMode + rayEngine persist across reload',
    persistedMode === 'ray' && persistedEngine === 'cpu',
    `mode ${persistedMode}, engine ${persistedEngine}`);
});
