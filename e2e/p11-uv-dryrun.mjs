/**
 * P11-4 e2e — THE UV DRY RUN.
 *
 * Loads the pre-UV donut (research/donut.vibe.json — predates UVs, must load
 * clean), then walks the real UV workflow end-to-end through public entry points
 * (in-page fetch + __app.io.apply, the InputManager Ctrl+E / U menus, the
 * workspace UV Editor, the Material tab, the F12 tracer, save/load):
 *
 *   1. Fetch + apply donut.vibe.json (deep-link loader path). Clean load, 0 UVs.
 *   2. Icing → edit mode → mark two meridian seams (Ctrl+E → Mark Seam, real
 *      menu) → U → Unwrap. Every icing face UV'd, all in [0,1]², >= 2 islands.
 *   3. UV Editor workspace: islands visible (checker pixel probe), click-select
 *      one island, G-nudge, undo.
 *   4. Material tab: icing texture → Checker. Rendered viewport shows the checker
 *      mapping onto the icing — ambient-only inspection lighting makes texKind
 *      'none' flat (box luminance spread ≈ 0) and 'checker' bold (spread ≈ 55);
 *      the spread assert is unreachable for 'none'.
 *   5. Torus body: U → Smart UV Project (no seams) → UVs populate every face.
 *   6. F12 path trace at low samples: icing-region variance with the checker
 *      exceeds a no-checker control render (non-vacuity: the assert fails when
 *      texKind is 'none' — see the CHECKER-NON-VACUITY comment for measured
 *      values).
 *   7. Restore the real unwrap + donut lighting, save research/donut-uv.vibe.json,
 *      reload, re-serialize byte-identical; UVs + texture survive.
 *
 * WORKAROUND (documented in research/UV-RUN.md):
 *  - Seam EDGE SELECTION is driven through the mesh/edit API (deterministic
 *    meridian rings); the Ctrl+E → Mark Seam MENU is exercised for real. Alt+
 *    click loop-select itself is separately proven by e2e/p9-select.mjs. This
 *    mirrors e2e/p11-unwrap.mjs's own approach.
 *
 * FIXED (P11-5): the modifiers now propagate UVs to the evaluated mesh
 * (subsurf subdivides corner UVs in per-face UV space, solidify copies to both
 * shells, shrinkwrap clones), so the checker shows on the FULL modified icing —
 * shrinkwrap+solidify+subsurf LIVE. The old gap-#1 (clear the modifier stack)
 * and gap-#2 (hide the z-fighting torus, an artefact of the dropped offset when
 * the stack was cleared) workarounds are GONE: the live stack keeps the icing
 * offset above the donut body, so there is no z-fight to isolate. Only ambient-
 * only inspection lighting remains, so the 0.2/1.0 checker cells read cleanly.
 *
 * Run with the dev server up (under flock; long — two F12 passes):
 *   flock /tmp/vibe-blender-e2e.lock node e2e/p11-uv-dryrun.mjs
 */
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runE2e } from './harness.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const SHOTS = '/tmp/uvrun';
mkdirSync(SHOTS, { recursive: true });

runE2e(async (t) => {
  const wallStart = Date.now();
  const evalAsync = async (expr) => {
    const { result, exceptionDetails } = await t.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    });
    if (exceptionDetails) throw new Error(`page threw: ${exceptionDetails.text}`);
    return result.value;
  };
  const shot = (n, name) => t.screenshot(join(SHOTS, `${n}-${name}.png`));
  const clickItem = (label) => t.evaluate(`(() => {
    const b = [...document.querySelectorAll('.add-menu-item')].find((x) => x.textContent === ${JSON.stringify(label)} && !x.disabled);
    if (b) { b.click(); return true; }
    return false;
  })()`);
  const report = {};

  // Layout workspace + dismiss splash.
  await t.evaluate(`document.querySelector('.wsp-tab[data-workspace="Layout"]')?.click()`);
  await t.sleep(150);
  await t.key('Escape', 'Escape', 0);
  await t.sleep(80);

  const rect = await t.evaluate(`(() => {
    const c = document.querySelector('#viewport-wrap canvas') || document.querySelector('canvas');
    const r = c.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  })()`);
  const cx = Math.round(rect.x + rect.w / 2);
  const cy = Math.round(rect.y + rect.h / 2);

  // =====================================================================
  // STAGE 1 — Load the pre-UV donut via the deep-link loader path.
  // In-page fetch of research/donut.vibe.json (dev server serves the repo
  // root) → __app.io.apply. The file predates UVs, so it must load clean and
  // carry ZERO uvs/seams/textures.
  // =====================================================================
  const load = await evalAsync(`(async () => {
    const txt = await fetch('/research/donut.vibe.json').then((r) => r.text());
    window.__app.io.apply(txt);
    const S = window.__app.scene;
    let uv = 0, seam = 0, tex = 0;
    for (const o of S.objects) if (o.mesh) { uv += o.mesh.uvs.size; seam += o.mesh.seams.size; }
    for (const m of S.materials) if (m.texKind && m.texKind !== 'none') tex++;
    return {
      objects: S.objects.length, uv, seam, tex,
      icing: (S.objects.find((o) => o.name === 'Icing') || {}).id,
      torus: (S.objects.find((o) => o.name === 'Torus') || {}).id,
      bytes: txt.length,
    };
  })()`);
  t.check('S1: donut fixture loaded (9 objects)', load.objects === 9, `objects=${load.objects}`);
  // The fixture predates UVs, but primitives are rebuilt through the makers at
  // load — which SHIP default unwraps since 2026-07-09. Clear them so the dry
  // run still exercises the from-scratch unwrap flow it was written for.
  await t.evaluate(`(() => {
    for (const o of window.__app.scene.objects) if (o.mesh) { o.mesh.uvs.clear(); o.mesh.touch?.(); }
  })()`);
  const cleared = await t.evaluate(`(() => {
    const S = window.__app.scene;
    let uv = 0; for (const o of S.objects) if (o.mesh) uv += o.mesh.uvs.size;
    return uv;
  })()`);
  t.check('S1: UV-less starting state established — 0 uvs, 0 seams, 0 textures',
    cleared === 0 && load.seam === 0 && load.tex === 0, `uv=${cleared} seam=${load.seam} tex=${load.tex}`);
  t.check('S1: icing + torus objects present', load.icing != null && load.torus != null,
    `icing=${load.icing} torus=${load.torus}`);
  const icingId = load.icing;
  const torusId = load.torus;
  report.fixtureBytes = load.bytes;
  await shot('01', 'loaded');

  // =====================================================================
  // STAGE 2 — Icing seams + Unwrap.
  // Enter edit mode on the icing base cap (an annular half-tube band). Select a
  // meridian edge ring (all minor-direction edges at a fixed major angle φ)
  // via the edit API, then MARK SEAM through the real Ctrl+E menu. Two meridian
  // cuts (φ=0 and φ=π) split the band into two islands.
  // =====================================================================
  await evalAsync(`(() => {
    const S = window.__app.scene;
    if (S.editMode) S.exitEditMode();
    S.selectOnly(${icingId});
    S.enterEditMode(${icingId});
    S.editMode.setElementMode('edge', S.editObject.mesh);
    S.editMode.clearSelection();
  })()`);
  await t.sleep(100);
  t.check('S2: no seams before marking', (await t.evaluate(`window.__app.scene.editObject.mesh.seams.size`)) === 0);

  // Select the meridian edge ring nearest major-angle PHI (both endpoints at PHI).
  const selectMeridian = (phi) => t.evaluate(`(() => {
    const S = window.__app.scene, m = S.editObject.mesh;
    const ang = (id) => { const c = m.verts.get(id).co; return Math.atan2(c.z, c.x); };
    const wrap = (d) => Math.atan2(Math.sin(d), Math.cos(d));
    const TOL = 0.075; // ~half the 2π/48 major step
    S.editMode.setElementMode('edge', m);
    S.editMode.clearSelection();
    let n = 0;
    for (const k of m.edges().keys()) {
      const [a, b] = k.split(',').map(Number);
      if (Math.abs(wrap(ang(a) - ${phi})) < TOL && Math.abs(wrap(ang(b) - ${phi})) < TOL) {
        S.editMode.edges.add(k); n++;
      }
    }
    S.editMode.touch();
    return n;
  })()`);

  const markSeamViaMenu = async () => {
    await t.mouse('mouseMoved', cx, cy);
    await t.key('e', 'KeyE', 2); // Ctrl+E → Edge menu
    await t.sleep(90);
    const ok = await clickItem('Mark Seam');
    await t.sleep(120);
    return ok;
  };

  const m0 = await selectMeridian(0);
  t.check('S2: meridian ring φ=0 selected', m0 >= 3, `edges=${m0}`);
  t.check('S2: Ctrl+E → Mark Seam (φ=0) via the real Edge menu', await markSeamViaMenu());
  const seam1 = await t.evaluate(`window.__app.scene.editObject.mesh.seams.size`);
  t.check('S2: seams recorded on the mesh', seam1 > 0, `seams=${seam1}`);
  t.check('S2: status confirms Mark Seam',
    (await t.evaluate(`document.getElementById('status').textContent`)).startsWith('Mark Seam'));

  const m1 = await selectMeridian(Math.PI);
  t.check('S2: meridian ring φ=π selected', m1 >= 3, `edges=${m1}`);
  t.check('S2: Ctrl+E → Mark Seam (φ=π) via the real Edge menu', await markSeamViaMenu());
  const seamTotal = await t.evaluate(`window.__app.scene.editObject.mesh.seams.size`);
  t.check('S2: second seam ring added', seamTotal > seam1, `seams=${seamTotal}`);
  report.seams = seamTotal;

  // U → Unwrap (real UV menu), operating on ALL faces (none selected).
  await evalAsync(`(() => { const S = window.__app.scene; S.editMode.setElementMode('face', S.editObject.mesh); S.editMode.clearSelection(); })()`);
  await t.sleep(60);
  await t.evaluate(`(() => { const m = window.__app.scene.editObject.mesh; m.uvs.clear(); m.touch?.(); })()`);
  t.check('S2: no UVs before unwrap (cleared defaults)', (await t.evaluate(`window.__app.scene.editObject.mesh.uvs.size`)) === 0);
  await t.mouse('mouseMoved', cx, cy);
  await t.key('u', 'KeyU', 0); // U → UV menu
  await t.sleep(90);
  t.check('S2: U opens the UV menu (Unwrap present)', await clickItem('Unwrap'));
  await t.sleep(200);

  const unwrap = await evalAsync(`(async () => {
    const S = window.__app.scene, m = S.editObject.mesh;
    let all = true, corners = 0;
    for (const uvs of m.uvs.values()) for (const [u, v] of uvs) {
      corners++;
      if (!Number.isFinite(u) || !Number.isFinite(v) || u < -1e-6 || u > 1 + 1e-6 || v < -1e-6 || v > 1 + 1e-6) all = false;
    }
    const { seamIslands } = await import('/src/core/mesh/ops/unwrap.ts');
    const islands = seamIslands(m, [...m.faces.keys()]);
    return { faces: m.faces.size, uvFaces: m.uvs.size, allInUnit: all, islands: islands.length, corners };
  })()`);
  t.check('S2: Unwrap gives every icing face UVs',
    unwrap.uvFaces === unwrap.faces && unwrap.uvFaces > 0, `${unwrap.uvFaces}/${unwrap.faces}`);
  t.check('S2: all icing UVs are inside [0,1]²', unwrap.allInUnit === true, `corners=${unwrap.corners}`);
  t.check('S2: two meridian seams → >= 2 islands', unwrap.islands >= 2, `islands=${unwrap.islands}`);
  report.icingFaces = unwrap.faces;
  report.icingIslands = unwrap.islands;

  await evalAsync(`window.__app.scene.exitEditMode()`);
  await t.sleep(80);
  await shot('02', 'icing-unwrapped');

  // =====================================================================
  // STAGE 3 — UV Editor workspace: islands visible, select, G-nudge, undo.
  // Switch an area to the 'uv' editor (the icing is the active object).
  // =====================================================================
  await t.evaluate(`window.__app.scene.selectOnly(${icingId})`);
  await t.sleep(60);
  await t.evaluate(`(() => {
    const sel = [...document.querySelectorAll('.wsp-area-select')].find((s) => s.value === 'properties') ||
                document.querySelector('.wsp-area-select');
    sel.value = 'uv';
    sel.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(400); // frame loop sizes + draws the canvas

  t.check('S3: UV editor canvas mounted', await t.evaluate(`!!document.querySelector('.uv-editor-canvas')`));
  const uvIslands = await t.evaluate(`document.querySelector('.uv-editor').__uvEditor.islandCount()`);
  t.check('S3: UV editor shows the icing islands (>= 2)', uvIslands >= 2, `islands=${uvIslands}`);

  // Checker background visible: >= 2 distinct gray tones across the mid row.
  const tones = await t.evaluate(`(() => {
    const api = document.querySelector('.uv-editor').__uvEditor;
    const r = api.canvas.getBoundingClientRect();
    const set = new Set();
    for (let x = 5; x < r.width - 5; x += 4) set.add(api.pixelAt(x, r.height / 2)[0]);
    return [...set].filter((v) => v >= 45);
  })()`);
  t.check('S3: UV editor checker background visible (>= 2 gray tones)', tones.length >= 2, JSON.stringify(tones));
  await shot('03', 'uv-editor');

  // Click an island, G-nudge it, undo.
  const uvRect = await t.evaluate(`(() => {
    const r = document.querySelector('.uv-editor-canvas').getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  })()`);
  // Probe island centroids in canvas pixels; click the first one that picks.
  const picked = await t.evaluate(`(() => {
    const api = document.querySelector('.uv-editor').__uvEditor;
    const r = document.querySelector('.uv-editor-canvas').getBoundingClientRect();
    // Sweep a coarse grid; selectAt() mutates selection, so probe via
    // selectedFaces(). Return the first canvas point that lands on an island.
    for (let gy = 0.15; gy <= 0.85; gy += 0.07) for (let gx = 0.15; gx <= 0.85; gx += 0.07) {
      api.selectAt(r.width * gx, r.height * gy, false);
      if (api.selectedFaces().length >= 1) return { gx, gy };
    }
    return null;
  })()`);
  let uvSelOk = false;
  if (picked) {
    const px = uvRect.left + uvRect.width * picked.gx;
    const py = uvRect.top + uvRect.height * picked.gy;
    await t.click(px, py);
    const sel = await t.evaluate(`document.querySelector('.uv-editor').__uvEditor.selectedFaces().length`);
    uvSelOk = sel >= 1;
    t.check('S3: clicking an island selects it', uvSelOk, `selected=${sel}`);

    // Record one island's UVs, G-drag, confirm, assert change; undo restores.
    const fid = await t.evaluate(`document.querySelector('.uv-editor').__uvEditor.selectedFaces()[0]`);
    const before = await t.evaluate(`JSON.stringify(window.__app.scene.get(${icingId}).mesh.uvs.get(${fid}))`);
    await t.mouse('mouseMoved', px, py);
    await t.key('g', 'KeyG');
    await t.mouse('mouseMoved', px + 40, py - 22);
    await t.sleep(60);
    await t.click(px + 40, py - 22);
    await t.sleep(80);
    const after = await t.evaluate(`JSON.stringify(window.__app.scene.get(${icingId}).mesh.uvs.get(${fid}))`);
    t.check('S3: G-nudge moved the picked island in UV space', after !== before, `${before} -> ${after}`);
    await t.key('z', 'KeyZ', 2);
    await t.sleep(80);
    const restored = await t.evaluate(`JSON.stringify(window.__app.scene.get(${icingId}).mesh.uvs.get(${fid}))`);
    t.check('S3: Ctrl+Z restores the pre-nudge UVs', restored === before, `${restored}`);
  } else {
    t.check('S3: an island was pickable in the UV editor', false, 'no island picked by grid sweep');
  }

  // Switch the area back to Properties so the Material tab is available.
  await t.evaluate(`(() => {
    const sel = [...document.querySelectorAll('.wsp-area-select')].find((s) => s.value === 'uv');
    if (sel) { sel.value = 'properties'; sel.dispatchEvent(new Event('change')); }
  })()`);
  await t.sleep(250);

  // =====================================================================
  // STAGE 4 — Material tab: icing texture → Checker; the RENDERED VIEWPORT
  // shows the checker mapping through the REAL Tutte-unwrap UVs, following the
  // icing's curvature — on the FULL modified icing (shrinkwrap+solidify+subsurf
  // LIVE, P11-5). The evaluated mesh now carries UVs end-to-end: the base cap's
  // Tutte unwrap survives shrinkwrap (clone), is copied to both solidify shells,
  // and is subdivided in per-face UV space by subsurf.
  //
  // No stack-clearing and no torus-hiding: the live shrinkwrap+solidify offset
  // keeps the icing above the donut body, so there is no z-fight to isolate.
  // Only ambient-only inspection lighting (flat neutral world, lights off) is
  // applied so the checker's 0.2/1.0 cells read cleanly. Restored in Stage 7.
  //
  // NON-VACUITY: none-vs-checker per-pixel diff over the whole frame — none-vs-
  // none is 0 changed pixels (deterministic raster, proven live below), checker
  // changes tens of thousands. The assert `checkerChanged > 500` is UNREACHABLE
  // when texKind stays 'none' (both frames identical → 0). Only the icing
  // material is set to checker, so the (visible) untextured torus is constant
  // across the none/checker toggle and cannot manufacture the diff.
  // =====================================================================
  // Ambient-only inspection lighting (flat neutral world, lights off). The
  // icing keeps its LIVE modifier stack — UVs now propagate through it.
  await evalAsync(`(() => {
    const S = window.__app.scene, w = S.world;
    window.__saveWorld = { mode: w.mode, color: [w.color[0], w.color[1], w.color[2]], strength: w.strength };
    window.__hidden = [];
    w.mode = 'flat'; w.color = [1, 1, 1]; w.strength = 3;
    for (const o of S.objects) if (o.kind === 'light' && o.visible) { o.visible = false; window.__hidden.push(o.id); }
  })()`);

  // Frame the icing + rendered shading.
  await t.evaluate(`window.__app.scene.selectOnly(${icingId})`);
  await t.mouse('mouseMoved', cx, cy);
  await t.key('.', 'NumpadDecimal', 0); await t.sleep(220);
  await t.evaluate(`window.__app.renderer.shadingMode = 'rendered'`);
  await t.sleep(150);

  // Material tab → set texKind through the real select.
  await t.evaluate(`document.querySelector('.properties-tab-btn[data-tab="material"]')?.click()`);
  await t.sleep(120);
  t.check('S4: Material tab texture-kind select exists',
    await t.evaluate(`!!document.querySelector('.material-tab-texkind')`));

  const setTexKind = async (kind) => {
    await t.evaluate(`(() => { const sel = document.querySelector('.material-tab-texkind'); sel.value = '${kind}'; sel.dispatchEvent(new Event('change')); })()`);
    await t.sleep(120);
  };
  // Full-frame luminance capture (stored in-page) for none-vs-checker diffs.
  const capFrame = (slot) => t.evaluate(`(() => {
    const app = window.__app, gl = app.renderer.ctx.gl, c = gl.canvas;
    app.renderer.render(app.scene, app.camera);
    const w = c.width, h = c.height, px = new Uint8Array(w*h*4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const lum = new Float64Array(w*h);
    for (let i = 0; i < w*h; i++) lum[i] = 0.299*px[i*4] + 0.587*px[i*4+1] + 0.114*px[i*4+2];
    window['${slot}'] = lum; return w*h;
  })()`);
  const countChanged = (a, b) => t.evaluate(`(() => { const A = window['${a}'], B = window['${b}']; let n = 0; for (let i = 0; i < A.length; i++) if (Math.abs(A[i] - B[i]) > 20) n++; return n; })()`);

  await setTexKind('none');
  await capFrame('__uvA'); await capFrame('__uvA2');
  const controlChanged = await countChanged('__uvA', '__uvA2');
  t.check('S4: control none-vs-none render is identical (0 changed pixels)', controlChanged === 0, `changed=${controlChanged}`);
  await setTexKind('checker');
  t.check('S4: icing material texKind is now checker',
    (await t.evaluate(`window.__materialTab.material().texKind`)) === 'checker');
  await capFrame('__uvB');
  const checkerChanged = await countChanged('__uvA', '__uvB');
  t.check('S4: checker maps onto the icing in the rendered viewport (thousands of pixels change vs none)',
    checkerChanged > 500 && controlChanged === 0, `checkerChanged=${checkerChanged} controlChanged=${controlChanged}`);
  report.rendered = { controlChanged, checkerChanged };
  await shot('04', 'rendered-checker');

  // =====================================================================
  // STAGE 5 — Torus body: U → Smart UV Project (no seams) → UVs populate.
  // =====================================================================
  await evalAsync(`(() => {
    const S = window.__app.scene;
    if (S.editMode) S.exitEditMode();
    S.selectOnly(${torusId});
    S.enterEditMode(${torusId});
    S.editMode.setElementMode('face', S.editObject.mesh);
    S.editMode.clearSelection();
  })()`);
  await t.sleep(100);
  await t.evaluate(`(() => { const m = window.__app.scene.editObject.mesh; m.uvs.clear(); m.touch?.(); })()`);
  t.check('S5: torus has no seams and no UVs before Smart Project (cleared defaults)',
    (await t.evaluate(`window.__app.scene.editObject.mesh.seams.size`)) === 0 &&
    (await t.evaluate(`window.__app.scene.editObject.mesh.uvs.size`)) === 0);
  await t.mouse('mouseMoved', cx, cy);
  await t.key('u', 'KeyU', 0);
  await t.sleep(90);
  t.check('S5: UV menu offers Smart UV Project', await clickItem('Smart UV Project'));
  await t.sleep(200);
  const smart = await t.evaluate(`(() => {
    const m = window.__app.scene.editObject.mesh;
    let all = true;
    for (const uvs of m.uvs.values()) for (const [u, v] of uvs) {
      if (u < -1e-6 || u > 1 + 1e-6 || v < -1e-6 || v > 1 + 1e-6) all = false;
    }
    return { uvFaces: m.uvs.size, faces: m.faces.size, allInUnit: all };
  })()`);
  t.check('S5: Smart UV Project populates every torus face',
    smart.uvFaces === smart.faces && smart.uvFaces > 0, `${smart.uvFaces}/${smart.faces}`);
  t.check('S5: all Smart Project UVs inside [0,1]²', smart.allInUnit === true);
  report.torusFaces = smart.faces;
  await evalAsync(`window.__app.scene.exitEditMode()`);
  await t.sleep(80);

  // =====================================================================
  // STAGE 6 — F12 path trace: icing checker vs no-checker control.
  // Full donut (icing's LIVE modifier stack, torus visible) + ambient-only
  // inspection lighting + the REAL Tutte-unwrap UVs from Stage 2 propagated
  // through shrinkwrap+solidify+subsurf. The active scene camera frames the
  // icing tightly, so a center box is (subsurf'd) icing surface.
  // NON-VACUITY: texKind 'none' and 'checker' are the SAME scene minus the
  // texture, so checkerVar > noneVar holds ONLY because of the checker (with
  // 'none' both renders match and checkerVar ≈ noneVar). Values in the report.
  // =====================================================================
  await t.evaluate(`window.__app.scene.selectOnly(${icingId})`); // target the icing material
  const F12_SAMPLES = 6;
  const traceBoxVariance = async (label) => {
    await t.evaluate('window.__renderEngine.start()');
    const ok = await t.until(`window.__renderEngine.sample() >= ${F12_SAMPLES}`, 600000);
    t.check(`S6: F12 ${label} render reaches >= ${F12_SAMPLES} samples`, ok);
    const png = await t.evaluate(`window.__renderEngine.canvas().toDataURL('image/png')`);
    writeFileSync(join(SHOTS, `06-render-${label}.png`), Buffer.from(png.split(',')[1], 'base64'));
    const v = await t.evaluate(`(() => {
      const cv = window.__renderEngine.canvas(), c2 = cv.getContext('2d');
      const w = cv.width, h = cv.height;
      const bw = Math.round(w * 0.4), bh = Math.round(h * 0.4);
      const x0 = Math.round((w - bw) / 2), y0 = Math.round((h - bh) / 2);
      const d = c2.getImageData(x0, y0, bw, bh).data;
      let mean = 0, m2 = 0, n = bw * bh;
      const L = new Float64Array(n);
      for (let i = 0; i < n; i++) { L[i] = 0.299 * d[i*4] + 0.587 * d[i*4+1] + 0.114 * d[i*4+2]; mean += L[i]; }
      mean /= n;
      for (let i = 0; i < n; i++) m2 += (L[i] - mean) * (L[i] - mean);
      return m2 / n;
    })()`);
    await t.evaluate('window.__renderEngine.close()');
    await t.sleep(150);
    return v;
  };

  // Control: texKind none.
  await t.evaluate(`document.querySelector('.properties-tab-btn[data-tab="material"]')?.click()`);
  await t.sleep(80);
  await setTexKind('none');
  const noneVar = await traceBoxVariance('none-control');
  // Checker: texKind checker.
  await setTexKind('checker');
  const checkerVar = await traceBoxVariance('checker');
  report.f12 = { noneVar: +noneVar.toFixed(1), checkerVar: +checkerVar.toFixed(1) };
  // CHECKER-NON-VACUITY (F12): measured checkerVar >> noneVar. The assertion
  // `checkerVar > noneVar * 1.3` FAILS when texKind is 'none' (then both renders
  // are the same scene and checkerVar ≈ noneVar). Values printed in the report +
  // written into research/UV-RUN.md after the calibration run.
  t.check('S6: icing checker is visible in the F12 render (variance > no-checker control)',
    checkerVar > noneVar * 1.3, `checkerVar=${checkerVar.toFixed(1)} noneVar=${noneVar.toFixed(1)}`);

  // =====================================================================
  // STAGE 7 — Restore the world + lights hidden for the ambient inspection;
  // save research/donut-uv.vibe.json, reload, assert byte-identical re-serialize.
  // The icing carries its ACTUAL Tutte unwrap (in [0,1]²) + the checker texture,
  // and its full live modifier stack.
  // =====================================================================
  await evalAsync(`(() => {
    const S = window.__app.scene;
    const w = S.world, sw = window.__saveWorld; w.mode = sw.mode; w.color = sw.color; w.strength = sw.strength;
    for (const id of window.__hidden) { const o = S.get(id); if (o) o.visible = true; }
  })()`);
  await t.sleep(60);
  const serialized = await t.evaluate('window.__app.io.serialize()');
  const outPath = join(REPO, 'research', 'donut-uv.vibe.json');
  writeFileSync(outPath, serialized);
  const reserialized = await t.evaluate(`(() => {
    window.__app.io.apply(${JSON.stringify(serialized)});
    return window.__app.io.serialize();
  })()`);
  const onDisk = readFileSync(outPath, 'utf8');
  t.check('S7: research/donut-uv.vibe.json round-trips byte-identical',
    reserialized === onDisk, `len ${reserialized.length} vs ${onDisk.length}`);
  const survive = await t.evaluate(`(() => {
    const S = window.__app.scene;
    let uv = 0, seam = 0;
    for (const o of S.objects) if (o.mesh) { uv += o.mesh.uvs.size; seam += o.mesh.seams.size; }
    const checker = S.materials.some((m) => m.texKind === 'checker');
    return { uv, seam, checker };
  })()`);
  t.check('S7: UVs + seams + checker texture survive the reload',
    survive.uv > 0 && survive.seam > 0 && survive.checker === true, JSON.stringify(survive));
  report.uvBytes = onDisk.length;
  report.survive = survive;
  await shot('07', 'saved-reloaded');

  // Clean up for later suites.
  await t.evaluate(`(() => {
    const S = window.__app.scene;
    if (S.editMode) S.exitEditMode();
    for (const o of [...S.objects]) S.remove(o.id);
    for (const m of [...S.materials]) S.removeMaterial(m.id);
    window.__app.renderer.shadingMode = 'matcap';
    window.__app.renderer.cameraViewId = null;
    window.__app.autosave.clear();
  })()`);

  report.wallSeconds = ((Date.now() - wallStart) / 1000).toFixed(1);
  console.log('\n===UV-DRYRUN-REPORT===');
  console.log(JSON.stringify(report, null, 2));
  console.log('===END-REPORT===');
});
