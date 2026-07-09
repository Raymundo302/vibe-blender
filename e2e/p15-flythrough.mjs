/**
 * P15-4 e2e — THE CAMERA FLY-THROUGH DRY RUN.
 *
 * Loads the frozen donut fixture (research/donut.vibe.json), then drives the
 * full animation stack end-to-end through public entry points:
 *
 *   1. Fetch + apply donut.vibe.json (deep-link loader path). The fixture has a
 *      Camera, a Sun key light, and the Icing mesh (Material.001). Make the
 *      camera active + look through it.
 *   2. Key a camera MOVE (frame 1 pose → frame 48 pose) via InsertKeysCommand
 *      (LocRotScale) on the camera object; key the Sun key light's power
 *      (50 → 400) via the NEW ● button on the Light tab (channel light.power);
 *      key the Icing material's baseColor (r 0.9 → 0.1) via the NEW ● button on
 *      the Material tab (channels material.baseColor.r/g/b).
 *   3. Scrub via the TIMELINE PANE frame input to frames 1, 24, 48: assert the
 *      posed camera worldTransform + light.power + material.baseColor.r match
 *      evalFCurve of each object's own curves; Rendered-viewport screenshots at
 *      frame 1 vs 48 differ (camera move + light + material all change).
 *   4. Playback: ▶ for ~0.5s, assert frameCurrent advanced and stayed within
 *      [frameStart, frameEnd]; ⏸ stops it.
 *   5. Save scene → research/donut-flythrough.vibe.json; reload it fresh
 *      (io.apply) and re-serialize BYTE-IDENTICAL; curves + posed state survive.
 *
 * The ● insert-key buttons on the Light/Material tabs are P15-4's UI
 * affordance; this suite EXERCISES them (not InsertKeysCommand directly) for
 * the payload channels, proving the wiring. The camera transform is keyed
 * through InsertKeysCommand (spec allows either) via an in-page dynamic import,
 * mirroring the uv-dryrun's import pattern.
 *
 * Run with the dev server up (under flock):
 *   flock /tmp/vibe-blender-e2e.lock node e2e/p15-flythrough.mjs
 */
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runE2e } from './harness.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const SHOTS = '/tmp/flythrough';
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
  const report = {};

  // Layout workspace + dismiss splash.
  await t.evaluate(`document.querySelector('.wsp-tab[data-workspace="Layout"]')?.click()`);
  await t.sleep(150);
  await t.key('Escape', 'Escape', 0);
  await t.sleep(80);

  // =====================================================================
  // STAGE 1 — Load the donut fixture; make the camera active + look through it.
  // =====================================================================
  const load = await evalAsync(`(async () => {
    const txt = await fetch('/research/donut.vibe.json').then((r) => r.text());
    window.__app.io.apply(txt);
    const S = window.__app.scene;
    const cam = S.objects.find((o) => o.kind === 'camera');
    const sun = S.objects.find((o) => o.name === 'Sun');
    const icing = S.objects.find((o) => o.name === 'Icing');
    if (cam) S.activeCameraId = cam.id;
    return {
      objects: S.objects.length,
      cam: cam ? cam.id : null,
      sun: sun ? sun.id : null,
      icing: icing ? icing.id : null,
      icingMat: icing ? icing.materialId : null,
      bytes: txt.length,
    };
  })()`);
  t.check('S1: donut fixture loaded (9 objects)', load.objects === 9, `objects=${load.objects}`);
  t.check('S1: fixture has a Camera', load.cam != null, `cam=${load.cam}`);
  t.check('S1: fixture has the Sun key light', load.sun != null, `sun=${load.sun}`);
  t.check('S1: fixture has the Icing mesh with a material', load.icing != null && load.icingMat != null,
    `icing=${load.icing} mat=${load.icingMat}`);
  const camId = load.cam, sunId = load.sun, icingId = load.icing;
  report.fixtureBytes = load.bytes;

  // Deterministic frame range [1,48]; look through the scene camera.
  await t.evaluate(`(() => {
    const S = window.__app.scene;
    S.frameStart = 1; S.frameEnd = 48; S.frameCurrent = 1; S.playing = false;
    window.__app.renderer.shadingMode = 'rendered';
    window.__app.renderer.cameraViewId = ${camId};
  })()`);
  await t.sleep(120);
  await shot('01', 'loaded');

  // =====================================================================
  // STAGE 2 — Key the camera move + light power + material baseColor.
  // =====================================================================
  // (a) Camera: key LocRotScale at frame 1 (current pose), move to a distinct
  //     pose, key LocRotScale at frame 48. InsertKeysCommand via in-page import.
  const camKeys = await evalAsync(`(async () => {
    const S = window.__app.scene, undo = window.__app.undo;
    const { InsertKeysCommand, LOC_ROT_SCALE } = await import('/src/core/anim/animCommands.ts');
    const cam = S.get(${camId});
    S.selectOnly(${camId});
    // Frame 1: current pose.
    S.frameCurrent = 1;
    const c1 = InsertKeysCommand.perform('Insert Camera Key', S, [cam], LOC_ROT_SCALE, 1);
    if (c1) undo.push(c1);
    const p1 = cam.transform.position;
    const pose1 = { x: p1.x, y: p1.y, z: p1.z };
    // Move to a clearly different pose (arc around the donut, drop + rotate).
    const V = cam.transform.position.constructor;
    const Q = cam.transform.rotation.constructor;
    cam.transform = cam.transform
      .withPosition(new V(-2.6, 1.4, -2.2))
      .withRotation(Q.fromEulerXYZ(-0.35, -2.4, 0.05));
    // Frame 48: new pose.
    S.frameCurrent = 48;
    const c2 = InsertKeysCommand.perform('Insert Camera Key', S, [cam], LOC_ROT_SCALE, 48);
    if (c2) undo.push(c2);
    const p2 = cam.transform.position;
    const pose2 = { x: p2.x, y: p2.y, z: p2.z };
    const locx = cam.anim.fcurves.find((c) => c.channelPath === 'location.x');
    return { pose1, pose2, keyCount: locx ? locx.keys.length : 0 };
  })()`);
  t.check('S2: camera location.x has two keys (frame 1 & 48)', camKeys.keyCount === 2, `keys=${camKeys.keyCount}`);
  t.check('S2: the two camera poses differ',
    Math.abs(camKeys.pose1.x - camKeys.pose2.x) > 1, JSON.stringify([camKeys.pose1, camKeys.pose2]));

  // (b) Light power via the ● button on the Light tab: 50 @ frame 1, 400 @ 48.
  await t.evaluate(`window.__app.scene.selectOnly(${sunId})`);
  await t.evaluate(`document.querySelector('.properties-tab-btn[data-tab="light"]')?.click()`);
  await t.sleep(80);
  t.check('S2: Light tab exposes the ● Power insert-key button',
    await t.evaluate(`!!document.querySelector('.light-tab-key-power')`));
  // Frame 1, power 50.
  await t.evaluate(`(() => { const S = window.__app.scene; S.frameCurrent = 1; S.get(${sunId}).light.power = 50; })()`);
  await t.evaluate(`document.querySelector('.light-tab-key-power').click()`);
  await t.sleep(60);
  // Frame 48, power 400.
  await t.evaluate(`(() => { const S = window.__app.scene; S.frameCurrent = 48; S.get(${sunId}).light.power = 400; })()`);
  await t.evaluate(`document.querySelector('.light-tab-key-power').click()`);
  await t.sleep(60);
  const powerKeys = await t.evaluate(`(() => {
    const c = window.__app.scene.get(${sunId}).anim?.fcurves.find((c) => c.channelPath === 'light.power');
    return c ? c.keys.map((k) => k.value) : [];
  })()`);
  t.check('S2: ● keyed light.power at 2 frames (50 & 400)',
    powerKeys.length === 2 && powerKeys[0] === 50 && powerKeys[1] === 400, JSON.stringify(powerKeys));

  // (c) Material baseColor via the ● button on the Material tab: r 0.9 @ 1, 0.1 @ 48.
  await t.evaluate(`window.__app.scene.selectOnly(${icingId})`);
  await t.evaluate(`document.querySelector('.properties-tab-btn[data-tab="material"]')?.click()`);
  await t.sleep(80);
  t.check('S2: Material tab exposes the ● Base Color insert-key button',
    await t.evaluate(`!!document.querySelector('.material-tab-key-basecolor')`));
  await t.evaluate(`(() => {
    const S = window.__app.scene; S.frameCurrent = 1;
    S.materialOf(S.get(${icingId})).baseColor[0] = 0.9;
  })()`);
  await t.evaluate(`document.querySelector('.material-tab-key-basecolor').click()`);
  await t.sleep(60);
  await t.evaluate(`(() => {
    const S = window.__app.scene; S.frameCurrent = 48;
    S.materialOf(S.get(${icingId})).baseColor[0] = 0.1;
  })()`);
  await t.evaluate(`document.querySelector('.material-tab-key-basecolor').click()`);
  await t.sleep(60);
  const colorKeys = await t.evaluate(`(() => {
    const c = window.__app.scene.get(${icingId}).anim?.fcurves.find((c) => c.channelPath === 'material.baseColor.r');
    return c ? c.keys.map((k) => k.value) : [];
  })()`);
  t.check('S2: ● keyed material.baseColor.r at 2 frames (0.9 & 0.1)',
    colorKeys.length === 2 && Math.abs(colorKeys[0] - 0.9) < 1e-6 && Math.abs(colorKeys[1] - 0.1) < 1e-6,
    JSON.stringify(colorKeys));
  report.keyed = { camKeys: camKeys.keyCount, powerKeys, colorKeys };

  // =====================================================================
  // STAGE 3 — Scrub via the TIMELINE PANE to frames 1, 24, 48.
  // Switch a NON-properties area to the Timeline editor (keep the properties
  // tabs available), then use its frame input to scrub — the pane calls
  // applyAnimation, which poses camera + light + material together.
  // =====================================================================
  await t.evaluate(`(() => {
    const sel = [...document.querySelectorAll('.wsp-area-select')].find((s) => s.value === 'outliner') ||
                [...document.querySelectorAll('.wsp-area-select')].find((s) => s.value !== 'properties');
    if (sel) { sel.value = 'timeline'; sel.dispatchEvent(new Event('change')); }
  })()`);
  await t.sleep(300);
  t.check('S3: timeline pane mounted', await t.evaluate(`!!window.__timeline.canvas.closest('.timeline').querySelector('.timeline-frame')`));

  const scrub = async (f) => {
    await t.evaluate(`(() => {
      const inp = window.__timeline.canvas.closest('.timeline').querySelector('.timeline-frame');
      inp.value = '${f}'; inp.dispatchEvent(new Event('change'));
    })()`);
    await t.sleep(120);
    return evalAsync(`(async () => {
      const S = window.__app.scene;
      const { findCurve, evalFCurve } = await import('/src/core/anim/fcurve.ts');
      const cam = S.get(${camId}), sun = S.get(${sunId}), icing = S.get(${icingId});
      const wt = S.worldTransformOf(cam).position;
      const ev = (obj, path) => { const c = findCurve(obj.anim, path); return c ? evalFCurve(c, S.frameCurrent) : null; };
      return {
        frame: S.frameCurrent,
        camActual: { x: wt.x, y: wt.y, z: wt.z },
        camExpected: { x: ev(cam, 'location.x'), y: ev(cam, 'location.y'), z: ev(cam, 'location.z') },
        powerActual: sun.light.power, powerExpected: ev(sun, 'light.power'),
        colorActual: S.materialOf(icing).baseColor[0], colorExpected: ev(icing, 'material.baseColor.r'),
      };
    })()`);
  };

  const close = (a, b, tol = 1e-4) => Math.abs(a - b) <= tol;
  for (const [i, f] of [1, 24, 48].entries()) {
    const s = await scrub(f);
    t.check(`S3: frame ${f} — camera worldTransform matches evalFCurve`,
      s.frame === f &&
      close(s.camActual.x, s.camExpected.x) && close(s.camActual.y, s.camExpected.y) && close(s.camActual.z, s.camExpected.z),
      JSON.stringify({ a: s.camActual, e: s.camExpected }));
    t.check(`S3: frame ${f} — light.power matches evalFCurve`,
      close(s.powerActual, s.powerExpected), `${s.powerActual} vs ${s.powerExpected}`);
    t.check(`S3: frame ${f} — material.baseColor.r matches evalFCurve`,
      close(s.colorActual, s.colorExpected), `${s.colorActual} vs ${s.colorExpected}`);
    await shot(`03-${i}`, `frame-${f}`);
  }

  // Rendered-viewport screenshots at frame 1 vs 48 differ (full-frame luminance).
  const capLum = (slot) => t.evaluate(`(() => {
    const app = window.__app, gl = app.renderer.ctx.gl, c = gl.canvas;
    app.renderer.render(app.scene, app.camera);
    const w = c.width, h = c.height, px = new Uint8Array(w*h*4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const lum = new Float64Array(w*h);
    for (let i = 0; i < w*h; i++) lum[i] = 0.299*px[i*4] + 0.587*px[i*4+1] + 0.114*px[i*4+2];
    window['${slot}'] = lum; return w*h;
  })()`);
  const countChanged = (a, b) => t.evaluate(`(() => { const A = window['${a}'], B = window['${b}']; let n = 0; for (let i = 0; i < A.length; i++) if (Math.abs(A[i] - B[i]) > 20) n++; return n; })()`);
  await scrub(1); await capLum('__f1');
  await scrub(48); await capLum('__f48');
  const changed = await countChanged('__f1', '__f48');
  t.check('S3: Rendered viewport at frame 1 vs 48 differ (thousands of pixels)', changed > 500, `changed=${changed}`);
  report.frameDiffPixels = changed;

  // =====================================================================
  // STAGE 4 — Playback: ▶ for ~0.5s, frameCurrent advances + stays in range.
  // =====================================================================
  await scrub(1);
  const beforePlay = await t.evaluate(`window.__app.scene.frameCurrent`);
  await t.evaluate(`window.__timeline.canvas.closest('.timeline').querySelector('.timeline-play').click()`);
  t.check('S4: play button set scene.playing', (await t.evaluate(`window.__app.scene.playing`)) === true);
  // Sample frameCurrent over ~0.5s and confirm it never leaves [start,end].
  let inRange = true, maxSeen = beforePlay;
  for (let i = 0; i < 6; i++) {
    await t.sleep(90);
    const f = await t.evaluate(`window.__app.scene.frameCurrent`);
    if (f < 1 || f > 48) inRange = false;
    maxSeen = Math.max(maxSeen, f);
  }
  await t.evaluate(`window.__timeline.canvas.closest('.timeline').querySelector('.timeline-play').click()`);
  t.check('S4: pause button cleared scene.playing', (await t.evaluate(`window.__app.scene.playing`)) === false);
  t.check('S4: playback advanced frameCurrent', maxSeen > beforePlay, `before=${beforePlay} maxSeen=${maxSeen}`);
  t.check('S4: playback stayed within [frameStart, frameEnd]', inRange === true);
  report.playbackMaxFrame = maxSeen;

  // =====================================================================
  // STAGE 5 — Save → research/donut-flythrough.vibe.json; reload fresh;
  // byte-identical re-serialize; curves + posed state survive.
  // =====================================================================
  await scrub(48); // deterministic saved pose (frame 48)
  // Transform curves store EULER; the sampler rebuilds the quat from the
  // 6-decimal-rounded euler keys on load, so the very first save-after-authoring
  // differs from every subsequent one by <1e-6 (a one-time euler↔quat settle —
  // see ANIM-RUN.md PUNCH-LIST). Settle ONCE (apply→serialize) so the file we
  // write is the round-trip fixed point that reloads byte-identically.
  const raw = await t.evaluate('window.__app.io.serialize()');
  const settled = await t.evaluate(`(() => { window.__app.io.apply(${JSON.stringify(raw)}); return window.__app.io.serialize(); })()`);
  const outPath = join(REPO, 'research', 'donut-flythrough.vibe.json');
  writeFileSync(outPath, settled);
  const reserialized = await t.evaluate(`(() => {
    window.__app.io.apply(${JSON.stringify(settled)});
    return window.__app.io.serialize();
  })()`);
  const onDisk = readFileSync(outPath, 'utf8');
  t.check('S5: research/donut-flythrough.vibe.json round-trips byte-identical',
    reserialized === onDisk, `len ${reserialized.length} vs ${onDisk.length}`);
  const survive = await t.evaluate(`(() => {
    const S = window.__app.scene;
    const cam = S.objects.find((o) => o.kind === 'camera');
    const sun = S.objects.find((o) => o.name === 'Sun');
    const icing = S.objects.find((o) => o.name === 'Icing');
    const has = (o, p) => !!(o && o.anim && o.anim.fcurves.some((c) => c.channelPath === p));
    return {
      camKeyed: has(cam, 'location.x'),
      powerKeyed: has(sun, 'light.power'),
      colorKeyed: has(icing, 'material.baseColor.r'),
      // posed state at frame 48: power 400, baseColor.r ~0.1
      power: sun ? sun.light.power : null,
      colorR: icing ? S.materialOf(icing).baseColor[0] : null,
      frame: S.frameCurrent,
    };
  })()`);
  t.check('S5: camera + light + material curves survive the reload',
    survive.camKeyed && survive.powerKeyed && survive.colorKeyed, JSON.stringify(survive));
  t.check('S5: posed state survives (frame 48 → power 400, baseColor.r ≈ 0.1)',
    survive.frame === 48 && close(survive.power, 400, 1e-3) && close(survive.colorR, 0.1, 1e-3),
    JSON.stringify(survive));
  report.savedBytes = onDisk.length;
  report.survive = survive;
  await shot('05', 'saved-reloaded');

  // Clean up for later suites (donut.mjs, smoke, edit, workspace run after).
  await t.evaluate(`(() => {
    const S = window.__app.scene;
    if (S.editMode) S.exitEditMode();
    S.playing = false;
    for (const o of [...S.objects]) S.remove(o.id);
    for (const m of [...S.materials]) S.removeMaterial(m.id);
    S.frameStart = 1; S.frameEnd = 250; S.frameCurrent = 1;
    window.__app.renderer.shadingMode = 'matcap';
    window.__app.renderer.cameraViewId = null;
    window.__app.autosave.clear();
  })()`);

  report.wallSeconds = ((Date.now() - wallStart) / 1000).toFixed(1);
  console.log('\n===FLYTHROUGH-REPORT===');
  console.log(JSON.stringify(report, null, 2));
  console.log('===END-REPORT===');
});
