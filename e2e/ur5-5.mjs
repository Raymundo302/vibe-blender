/**
 * UR5-5 e2e — the render frame is REAL. Proves (1) scene.renderSettings drives
 * the passepartout aspect (1000×1000 → square frame), (2) the through-camera
 * projection letterboxes to the render aspect so a point at the render-frame
 * edge lands on the passepartout frame edge, (3) F12 renders at the render
 * resolution (1000×1000 output buffer), (4) a fresh Shift+A camera spawns
 * looking at the horizon (world matrix −Z → +Y), and (5) resolution round-trips
 * through save/load. Screenshots at 1:1 and 21:9 for eyes-on.
 *
 *   flock /tmp/vibe-blender-e2e.lock E2E_PORT=9443 node e2e/ur5-5.mjs
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  const pristine = await t.evaluate('window.__app.io.serialize()');

  // Reduce to a single cube at origin, then Shift+A a fresh Camera (exercises the
  // real add-menu spawn path → its horizon rotation, check 4).
  await t.evaluate(`(() => {
    const s = window.__app.scene;
    if (s.editMode) s.exitEditMode();
    while (s.objects.length > 1) s.remove(s.objects[s.objects.length - 1].id);
    s.cursor = window.__app.scene.cursor.constructor.ZERO; // add-at-origin
  })()`);
  await t.sleep(80);

  // Shift+A → click the Camera item.
  await t.key('a', 'KeyA', 8); // shift
  await t.sleep(120);
  const opened = await t.evaluate(`!!document.querySelector('.add-menu')`);
  t.check('Shift+A opened the Add menu', opened === true);
  await t.evaluate(`(() => {
    const btn = [...document.querySelectorAll('.add-menu-item')].find((b) => b.textContent.trim() === 'Camera');
    if (btn) btn.click();
  })()`);
  await t.sleep(150);

  // --- Check 4: fresh camera looks toward the horizon (world −Z → +Y) ---
  const spawn = await t.evaluate(`(() => {
    const s = window.__app.scene;
    const cam = s.objects.find((o) => o.kind === 'camera');
    if (!cam) return null;
    const m = s.cameraWorldMatrix(cam).m; // col-major
    // Local -Z in world = -(third column). Should aim at world +Y (horizon).
    const fwd = [-m[8], -m[9], -m[10]];
    const pos = [m[12], m[13], m[14]];
    return { fwd, pos };
  })()`);
  t.check('a fresh Shift+A camera exists', spawn !== null);
  t.check('camera spawns at the origin (3D cursor)',
    spawn && Math.hypot(spawn.pos[0], spawn.pos[1], spawn.pos[2]) < 1e-4,
    spawn && spawn.pos.join(','));
  t.check('camera looks toward the horizon: local −Z → world +Y',
    spawn && Math.abs(spawn.fwd[0]) < 1e-3 && Math.abs(spawn.fwd[1] - 1) < 1e-3 && Math.abs(spawn.fwd[2]) < 1e-3,
    spawn && spawn.fwd.map((n) => n.toFixed(3)).join(','));

  // --- Look through the camera at a SQUARE render resolution ---
  await t.evaluate(`(() => {
    const s = window.__app.scene;
    const cam = s.objects.find((o) => o.kind === 'camera');
    s.activeCameraId = cam.id;
    s.renderSettings = { width: 1000, height: 1000 };
    window.__app.renderer.cameraViewId = cam.id; // Numpad0 equivalent
  })()`);
  await t.sleep(200);

  // --- Check 1: passepartout frame is SQUARE ---
  const frame = await t.evaluate(`(() => {
    const el = document.querySelector('.passepartout-frame');
    if (!el || getComputedStyle(el.parentElement).display === 'none') return null;
    const r = el.getBoundingClientRect();
    return { w: r.width, h: r.height, left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  })()`);
  t.check('passepartout frame is visible in camera view', frame !== null);
  t.check('passepartout frame is square at 1000×1000',
    frame && Math.abs(frame.w - frame.h) < 2, frame && `w=${frame.w?.toFixed(1)} h=${frame.h?.toFixed(1)}`);

  // --- Check 2: through-camera projection uses the RENDER aspect — a point at the
  // render-frame right edge projects exactly onto the passepartout frame's right
  // edge (what you see inside the frame == what renders). ---
  const proj = await t.evaluate(`(() => {
    const s = window.__app.scene, r = window.__app.renderer, cam = window.__app.camera;
    const camObj = s.objects.find((o) => o.kind === 'camera');
    const canvas = document.getElementById('viewport');
    const cr = canvas.getBoundingClientRect();
    const m = s.cameraWorldMatrix(camObj).m;
    const right = [m[0], m[1], m[2]];
    const fwd = [-m[8], -m[9], -m[10]];
    const eye = [m[12], m[13], m[14]];
    const tanH = 12 / camObj.camera.focalLength; // app's sensor formula
    const d = 3;
    // Right edge of the SQUARE render frame at depth d: offset = right * tanH * d.
    const P = [
      eye[0] + fwd[0] * d + right[0] * tanH * d,
      eye[1] + fwd[1] * d + right[1] * tanH * d,
      eye[2] + fwd[2] * d + right[2] * tanH * d,
    ];
    const vp = r.currentViewProj(s, cam).m; // col-major
    const cx = vp[0]*P[0] + vp[4]*P[1] + vp[8]*P[2] + vp[12];
    const cw = vp[3]*P[0] + vp[7]*P[1] + vp[11]*P[2] + vp[15];
    const ndcX = cx / cw;
    const screenX = cr.left + (ndcX * 0.5 + 0.5) * cr.width;
    // Same for the TOP edge (render NDC.y = +1): offset = up * tanH * d.
    const up = [m[4], m[5], m[6]];
    const Pt = [
      eye[0] + fwd[0] * d + up[0] * tanH * d,
      eye[1] + fwd[1] * d + up[1] * tanH * d,
      eye[2] + fwd[2] * d + up[2] * tanH * d,
    ];
    const cyt = vp[1]*Pt[0] + vp[5]*Pt[1] + vp[9]*Pt[2] + vp[13];
    const cwt = vp[3]*Pt[0] + vp[7]*Pt[1] + vp[11]*Pt[2] + vp[15];
    const ndcY = cyt / cwt;
    const screenY = cr.top + (-ndcY * 0.5 + 0.5) * cr.height; // screen y is flipped
    return { screenX, screenY };
  })()`);
  t.check('render-frame right edge projects onto the passepartout frame right edge',
    Math.abs(proj.screenX - frame.right) < 2, `projX=${proj.screenX.toFixed(1)} frameR=${frame.right.toFixed(1)}`);
  t.check('render-frame top edge projects onto the passepartout frame top edge',
    Math.abs(proj.screenY - frame.top) < 2, `projY=${proj.screenY.toFixed(1)} frameT=${frame.top.toFixed(1)}`);

  // Screenshot: passepartout at 1:1.
  await t.screenshot('e2e/screenshots/ur5-5-passepartout-1x1.png');

  // --- 21:9 → wide letterboxed frame (eyes-on) ---
  await t.evaluate(`window.__app.scene.renderSettings = { width: 2560, height: 1097 }`);
  await t.sleep(200);
  const wide = await t.evaluate(`(() => {
    const el = document.querySelector('.passepartout-frame');
    const r = el.getBoundingClientRect();
    return { aspect: r.width / r.height };
  })()`);
  t.check('passepartout frame is wide (~21:9) at 2560×1097',
    Math.abs(wide.aspect - 2560 / 1097) < 0.05, `aspect=${wide.aspect.toFixed(3)}`);
  await t.screenshot('e2e/screenshots/ur5-5-passepartout-21x9.png');

  // --- Check 3: F12 renders at the render resolution (1000×1000 buffer) ---
  await t.evaluate(`window.__app.scene.renderSettings = { width: 1000, height: 1000 }`);
  await t.sleep(80);
  await t.evaluate('window.__renderEngine.start()');
  await t.until('window.__renderEngine.sample() > 0', 15000);
  const rw = await t.evaluate(`(() => {
    const c = window.__renderEngine.canvas();
    return { w: c.width, h: c.height };
  })()`);
  t.check('F12 render output buffer is 1000×1000', rw.w === 1000 && rw.h === 1000, `${rw.w}×${rw.h}`);
  await t.evaluate('window.__renderEngine.close()');
  await t.sleep(80);

  // --- Check 5: save → load round-trips the resolution ---
  await t.evaluate(`window.__app.scene.renderSettings = { width: 1234, height: 567 }`);
  const saved = await t.evaluate('window.__app.io.serialize()');
  t.check('renderSettings serialized into the file',
    JSON.parse(saved).renderSettings?.width === 1234 && JSON.parse(saved).renderSettings?.height === 567);
  // Perturb then reload from the saved file.
  await t.evaluate(`window.__app.scene.renderSettings = { width: 640, height: 480 }`);
  await t.evaluate(`window.__app.io.apply(${JSON.stringify(saved)})`);
  await t.sleep(120);
  const loaded = await t.evaluate('JSON.stringify(window.__app.scene.renderSettings)');
  t.check('resolution round-trips through save → load', loaded === '{"width":1234,"height":567}', loaded);

  // Restore pristine (also proves an old-style scene with renderSettings loads).
  await t.evaluate(`window.__app.renderer.cameraViewId = null`);
  await t.evaluate(`window.__app.io.apply(${JSON.stringify(pristine)})`);
  await t.sleep(80);
  t.check('app still alive after the suite', await t.evaluate('!!window.__app.scene'));
});
