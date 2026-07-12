/**
 * UR14-4 — navigation batch (UI-REVIEW item 14).
 *
 * Drives the orientation gizmo + numpad view shortcuts and probes the ORBIT
 * CAMERA STATE (eye direction) rather than pixels:
 *   - click the gizmo's +X ball → snap to the Right view (+X);
 *   - Numpad 1/3/7 → Front/Right/Top, Ctrl variants → Back/Left/Bottom;
 *   - Numpad 9 → opposite of the current view;
 *   - the gizmo tracks the orbit (a ball's screen position moves with yaw);
 *   - Numpad 0 is untouched (no view snap, orbit unchanged).
 * Screenshots the gizmo at two orientations for eyes-on review.
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  const ev = async (expr) => {
    for (let i = 0; i < 6; i++) {
      try { return await t.evaluate(expr); }
      catch { await t.sleep(150); }
    }
    return t.evaluate(expr);
  };

  // Eye-side unit direction (from target toward camera) — unambiguous, no yaw
  // wrapping. Front=(0,−1,0), Right=(1,0,0), Top=(0,0,1).
  const eyeDir = () => ev(
    '(() => { const c = window.__app.camera; const e = c.eye, t = c.target;' +
    ' const dx=e.x-t.x, dy=e.y-t.y, dz=e.z-t.z; const L=Math.hypot(dx,dy,dz);' +
    ' return [dx/L, dy/L, dz/L]; })()',
  );
  const yawPitch = () => ev('[window.__app.camera.yaw, window.__app.camera.pitch]');
  const snapping = () => ev('window.__app.gizmo.snapping()');
  const settle = async () => {
    await t.sleep(60);                       // let the tween start
    await t.until('window.__app.gizmo.snapping()===false', 4000);
    await t.sleep(60);
  };
  const near = (a, b, eps = 0.02) => Math.abs(a - b) <= eps;
  const dirIs = (d, x, y, z) => near(d[0], x) && near(d[1], y) && near(d[2], z);

  // --- Gizmo exists --------------------------------------------------------
  t.check('gizmo canvas in the DOM', await ev('!!document.getElementById("axis-gizmo")'));
  t.check('gizmo lives in #viewport-wrap',
    await ev('document.getElementById("axis-gizmo").parentElement.id === "viewport-wrap"'));

  // --- Numpad view shortcuts ----------------------------------------------
  await t.key('3', 'Numpad3'); await settle();
  t.check('Numpad3 → Right (+X)', dirIs(await eyeDir(), 1, 0, 0), JSON.stringify(await eyeDir()));

  await t.key('1', 'Numpad1'); await settle();
  t.check('Numpad1 → Front (−Y)', dirIs(await eyeDir(), 0, -1, 0), JSON.stringify(await eyeDir()));

  await t.key('7', 'Numpad7'); await settle();
  { const d = await eyeDir(); t.check('Numpad7 → Top (+Z)', d[2] > 0.999, JSON.stringify(d)); }

  await t.key('3', 'Numpad3', 2); await settle(); // Ctrl+3 = Left
  t.check('Ctrl+Numpad3 → Left (−X)', dirIs(await eyeDir(), -1, 0, 0), JSON.stringify(await eyeDir()));

  await t.key('1', 'Numpad1', 2); await settle(); // Ctrl+1 = Back
  t.check('Ctrl+Numpad1 → Back (+Y)', dirIs(await eyeDir(), 0, 1, 0), JSON.stringify(await eyeDir()));

  await t.key('7', 'Numpad7', 2); await settle(); // Ctrl+7 = Bottom
  { const d = await eyeDir(); t.check('Ctrl+Numpad7 → Bottom (−Z)', d[2] < -0.999, JSON.stringify(d)); }

  // Numpad 9 = opposite. Go to Right, then 9 should give Left.
  await t.key('3', 'Numpad3'); await settle();
  await t.key('9', 'Numpad9'); await settle();
  t.check('Numpad9 → opposite of Right = Left (−X)',
    dirIs(await eyeDir(), -1, 0, 0), JSON.stringify(await eyeDir()));

  // --- Gizmo tracks the orbit (ball moves with yaw) ------------------------
  await ev('(window.__app.camera.yaw = 0, window.__app.camera.pitch = 0)');
  await t.sleep(80); // one draw frame updates ball positions
  const ballAtFront = await ev('window.__app.gizmo.ball("+X")');
  await ev('(window.__app.camera.yaw = Math.PI/2, window.__app.camera.pitch = 0)');
  await t.sleep(80);
  const ballAtRight = await ev('window.__app.gizmo.ball("+X")');
  t.check('gizmo +X ball reported at both yaws', !!ballAtFront && !!ballAtRight);
  t.check('gizmo tracks orbit (+X ball screen x shifts with yaw)',
    !!ballAtFront && !!ballAtRight && Math.abs(ballAtFront.x - ballAtRight.x) > 8,
    JSON.stringify([ballAtFront, ballAtRight]));

  // --- Click the gizmo's +X ball → Right view ------------------------------
  // Reset to Front so the +X ball sits clearly at the widget's right edge.
  await ev('(window.__app.camera.yaw = 0, window.__app.camera.pitch = 0)');
  await t.sleep(80);
  const plusX = await ev('window.__app.gizmo.ball("+X")');
  t.check('+X ball client position resolved', !!plusX, JSON.stringify(plusX));
  if (plusX) {
    await t.screenshot('e2e/screenshots/ur14-4-gizmo-front.png');
    await t.click(Math.round(plusX.x), Math.round(plusX.y));
    await settle();
    t.check('click gizmo +X → Right view (+X)',
      dirIs(await eyeDir(), 1, 0, 0), JSON.stringify(await eyeDir()));
    await t.screenshot('e2e/screenshots/ur14-4-gizmo-right.png');
  }

  // --- Numpad 0 untouched (no view snap, orbit unchanged) ------------------
  const before = await yawPitch();
  const hasCam = await ev('window.__app.scene.activeCameraId !== null');
  await t.key('0', 'Numpad0');
  await t.sleep(120);
  t.check('Numpad0 did NOT start a view snap', (await snapping()) === false);
  const after = await yawPitch();
  t.check('Numpad0 left the orbit yaw/pitch unchanged',
    near(before[0], after[0], 1e-4) && near(before[1], after[1], 1e-4),
    JSON.stringify([before, after]));
  if (hasCam) {
    t.check('Numpad0 still toggles camera view',
      await ev('window.__app.renderer.cameraViewId !== null'));
  }

  // --- Help overlay lists the new keys ------------------------------------
  await t.key('F1', 'F1'); // open
  await t.sleep(120);
  const helpText = await ev(
    '(() => { const el = document.querySelector(".help-overlay"); return el ? el.textContent : ""; })()',
  );
  t.check('help overlay mentions Numpad view snap', /Numpad1/.test(helpText) && /Front/.test(helpText));
  t.check('help overlay mentions the gizmo', /Gizmo/i.test(helpText));
  await t.key('F1', 'F1'); // close

  // --- Verify catch (2026-07-12): numpad digits in a focused DOM field must
  // TYPE, not snap the view (InputManager numpad-branch activeElement guard).
  // Leave camera view if the earlier Numpad0 check left us in it.
  await ev('(() => { window.__app.renderer.cameraViewId = null; })()');
  await t.sleep(150);
  await ev(`(() => { const c = window.__app.camera; c.yaw = 0.5; c.pitch = 0.3;
    document.querySelector('.timeline-frame, input[type=number]').focus(); })()`);
  await t.key('1', 'Numpad1'); await t.sleep(300);
  const kept = await ev('JSON.stringify([window.__app.camera.yaw, window.__app.camera.pitch])');
  const [ky, kp] = JSON.parse(kept);
  t.check('numpad1 in a focused input does NOT snap the camera',
    Math.abs(ky - 0.5) < 0.01 && Math.abs(kp - 0.3) < 0.01, kept);
  await ev('document.activeElement.blur()');
  await t.key('1', 'Numpad1'); await t.sleep(500);
  const snapped = await ev('JSON.stringify([window.__app.camera.yaw, window.__app.camera.pitch])');
  const [sy, sp] = JSON.parse(snapped);
  t.check('numpad1 unfocused still snaps to front',
    Math.abs(sy) < 0.01 && Math.abs(sp) < 0.01, snapped);
});

