import { runE2e } from './harness.mjs';
runE2e(async (t) => {
  await t.until('!!window.__app');
  await t.key('Escape', 'Escape', 0);
  await new Promise(r => setTimeout(r, 120));

  // Orbit the OrbitCamera far from the default camera pose, then enter camera view.
  await t.evaluate(`(() => { const c = window.__app.camera; c.yaw += 1.4; c.pitch = -0.1; c.distance = 14; })()`);
  await t.key('0', 'Numpad0', 0);
  await new Promise(r => setTimeout(r, 120));

  // After the frame-loop sync, the OrbitCamera's eye/forward should match the
  // active camera's world pose (the whole point of the fix).
  const poseMatch = await t.evaluate(`(() => {
    const app = window.__app, s = app.scene;
    const cam = s.get(app.renderer.cameraViewId);
    const wm = s.cameraWorldMatrix(cam).m;
    const camPos = { x: wm[12], y: wm[13], z: wm[14] };
    const camFwd = { x: -wm[8], y: -wm[9], z: -wm[10] };
    const e = app.camera.eye, f = app.camera.forward;
    const dPos = Math.hypot(e.x-camPos.x, e.y-camPos.y, e.z-camPos.z);
    const dFwd = Math.hypot(f.x-camFwd.x, f.y-camFwd.y, f.z-camFwd.z);
    return { dPos, dFwd };
  })()`);
  console.log('POSE MATCH after sync:', JSON.stringify(poseMatch));
  t.check('OrbitCamera eye synced to active camera', poseMatch.dPos < 1e-3, `dPos=${poseMatch.dPos}`);
  t.check('OrbitCamera forward synced to active camera', poseMatch.dFwd < 1e-3, `dFwd=${poseMatch.dFwd}`);

  // Canvas center (the cube sits at the origin, framed near center in camera view).
  const rect = await t.evaluate(`(() => { const r = document.querySelector('canvas').getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  const cx = Math.round(rect.x + rect.w * 0.5);
  const cy = Math.round(rect.y + rect.h * 0.5);

  // Clicking the cube's on-screen center should select it (pick already uses the
  // camera-view; this confirms input agrees).
  await t.mouse('mouseMoved', cx, cy);
  await t.mouse('mousePressed', cx, cy, 'left');
  await t.mouse('mouseReleased', cx, cy, 'left');
  await new Promise(r => setTimeout(r, 100));
  const selSize = await t.evaluate(`window.__app.scene.selection.size`);
  t.check('click at center selects the cube in camera view', selSize === 1, `sel=${selSize}`);

  // Shift+RightClick at center places the 3D cursor. It must land ON the cube
  // (near the origin), NOT flung off by a stale OrbitCamera ray.
  await t.mouse('mouseMoved', cx, cy);
  await t.mouse('mousePressed', cx, cy, 'right', { modifiers: 8 });
  await t.mouse('mouseReleased', cx, cy, 'right', { modifiers: 8 });
  await new Promise(r => setTimeout(r, 120));
  const cur = await t.evaluate(`(() => { const c = window.__app.scene.cursor; return { x:c.x, y:c.y, z:c.z }; })()`);
  const curDist = Math.hypot(cur.x, cur.y, cur.z);
  console.log('3D cursor after Shift+RMB at center:', JSON.stringify(cur), 'dist', curDist);
  t.check('3D cursor lands on the cube near origin (< 1.8)', curDist < 1.8, `dist=${curDist.toFixed(3)} at ${JSON.stringify(cur)}`);
});
