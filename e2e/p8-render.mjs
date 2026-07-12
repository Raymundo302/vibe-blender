/**
 * P8-4 e2e — F12 progressive path tracer (render engine).
 * Run with the dev server up:
 *   flock /tmp/vibe-blender-e2e.lock node e2e/p8-render.mjs
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  // UR12-3: default render engine is GPU; these are CPU-path regression suites — pin CPU.
  await t.until('!!window.__renderEngine');
  await t.evaluate("window.__renderEngine.setEngine('cpu')");
  // --- Setup: default Cube + a bright point light above-right (via __app) ---
  await t.evaluate(`(() => {
    const s = window.__app.scene;
    if (s.editMode) s.exitEditMode();
    // Remove any prior lights/cameras from earlier runs of this suite.
    for (const o of [...s.objects]) if (o.kind !== 'mesh') s.remove(o.id);
    const light = s.addLight('Light', 'point');
    // Bright so the lit cube faces saturate well above the sky gradient.
    light.light.power = 400000;
    const P = light.transform.position;
    light.transform = light.transform.withPosition(new P.constructor(5, 6, 5));
  })()`);

  t.check('render engine debug handle present',
    await t.evaluate('typeof window.__renderEngine === "object"'));
  t.check('render window starts closed', (await t.evaluate('window.__renderEngine.isOpen()')) === false);

  // --- F12 opens the window and starts rendering ---
  await t.key('F12', 'F12', 0);
  await t.sleep(120);
  t.check('F12 opens the render window', (await t.evaluate('window.__renderEngine.isOpen()')) === true);
  t.check('render-win canvas is in the DOM',
    await t.evaluate(`!!document.querySelector('.render-win-canvas')`));

  // Sample counter increments as passes accumulate.
  const gotSamples = await t.until('window.__renderEngine.sample() >= 4', 40000);
  t.check('sample counter reaches >= 4', gotSamples);

  // --- Read the canvas center row: lit cube vs sky gradient ---
  const readRow = () => t.evaluate(`(() => {
    const cv = window.__renderEngine.canvas();
    const ctx = cv.getContext('2d');
    const w = cv.width, h = cv.height;
    const row = Math.floor(h / 2);
    const d = ctx.getImageData(0, row, w, 1).data;
    const lum = (i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    // Sky sample: far-left column (cube is centered, so this is background).
    const skyLum = lum(2 * 4);
    // Cube area: central 40% of the row — take the brightest pixel.
    let cubeMax = 0;
    for (let x = Math.floor(w * 0.3); x < Math.floor(w * 0.7); x++) {
      cubeMax = Math.max(cubeMax, lum(x * 4));
    }
    return { skyLum, cubeMax };
  })()`);

  const orbit = await readRow();
  t.check('lit cube center is > 3x the sky-gradient luminance',
    orbit.cubeMax > 3 * orbit.skyLum,
    `cubeMax=${orbit.cubeMax.toFixed(1)} sky=${orbit.skyLum.toFixed(1)}`);

  // --- Esc closes the window and terminates the worker (no more samples) ---
  await t.key('Escape', 'Escape', 0);
  await t.sleep(120);
  t.check('Esc closes the render window', (await t.evaluate('window.__renderEngine.isOpen()')) === false);

  const sClose = await t.evaluate('window.__renderEngine.sample()');
  await t.sleep(700);
  const sAfter = await t.evaluate('window.__renderEngine.sample()');
  t.check('worker stopped: sample count frozen after close', sClose === sAfter,
    `${sClose} -> ${sAfter}`);

  // --- Active camera: looking at the cube shows it; looking away = flat sky ---
  // Add a camera on +Z looking toward the origin (default rotation → forward -Z).
  await t.evaluate(`(() => {
    const s = window.__app.scene;
    for (const o of [...s.objects]) if (o.kind === 'camera') s.remove(o.id);
    const cam = s.addCamera('Camera');
    const P = cam.transform.position;
    cam.transform = cam.transform.withPosition(new P.constructor(0, 0, 8));
  })()`);
  t.check('scene now has an active camera',
    (await t.evaluate('!!window.__app.scene.activeCamera')) === true);

  // Render from the camera (looking toward the cube).
  await t.evaluate('window.__renderEngine.start()');
  const cam1ok = await t.until('window.__renderEngine.sample() >= 4', 40000);
  t.check('camera render accumulates samples (toward)', cam1ok);
  const toward = await readRow();
  t.check('camera looking AT the cube: cube present (center > 3x sky)',
    toward.cubeMax > 3 * toward.skyLum,
    `cubeMax=${toward.cubeMax.toFixed(1)} sky=${toward.skyLum.toFixed(1)}`);
  await t.evaluate('window.__renderEngine.close()');
  await t.sleep(120);

  // Rotate the camera 180° about Y (forward → +Z), now looking AWAY from the cube.
  await t.evaluate(`(() => {
    const cam = window.__app.scene.activeCamera;
    const Q = cam.transform.rotation.constructor;
    cam.transform = cam.transform.withRotation(new Q(0, 1, 0, 0)); // 180° about Y
  })()`);
  await t.evaluate('window.__renderEngine.start()');
  const cam2ok = await t.until('window.__renderEngine.sample() >= 4', 40000);
  t.check('camera render accumulates samples (away)', cam2ok);
  const away = await readRow();
  t.check('camera looking AWAY: cube absent (center is flat sky, not >3x)',
    away.cubeMax <= 3 * away.skyLum,
    `cubeMax=${away.cubeMax.toFixed(1)} sky=${away.skyLum.toFixed(1)}`);

  await t.screenshot('/tmp/p8-render.png');

  // Clean up: close the window and remove the added light/camera.
  await t.evaluate('window.__renderEngine.close()');
  await t.evaluate(`(() => {
    const s = window.__app.scene;
    for (const o of [...s.objects]) if (o.kind !== 'mesh') s.remove(o.id);
  })()`);
});
