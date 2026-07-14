/*
 * Camera-view zoom/pan (passepartout) — Blender's view_camera_zoom/offset while
 * looking through a camera (not view-lock). Verifies the frame scales + shifts
 * on screen AND that the render projection and the input (OrbitCamera) rays stay
 * pixel-consistent after a zoom+pan (the whole point of the shared applyCamView).
 *
 *   flock /tmp/vibe-blender-e2e.lock node e2e/camview-zoompan.mjs
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  await t.until('!!window.__app');

  // Frame the default cube through the default Camera; reset the camera-view.
  await t.evaluate(`(() => {
    const s = window.__app.scene;
    const cam = s.objects.find(o => o.kind === 'camera');
    s.deselectAll();
    window.__app.renderer.cameraViewId = cam.id;
    window.__app.renderer.camView = { zoom: 1, panX: 0, panY: 0 };
    window.__cubeId = s.objects.find(o => o.kind === 'mesh').id;
  })()`);
  await t.sleep(120);

  const frame = `(() => {
    const f = document.querySelector('.passepartout-frame');
    const r = f.getBoundingClientRect();
    return { w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
  })()`;
  const canvasW = await t.evaluate(`(document.querySelector('#viewport-wrap canvas')||document.querySelector('canvas')).clientWidth`);
  const base = await t.evaluate(frame);

  // Zoom → the passepartout frame scales about the viewport center.
  await t.evaluate(`(() => { window.__app.renderer.camView.zoom = 2; })()`);
  await t.sleep(60);
  const zoomed = await t.evaluate(frame);
  t.check('zoom scales the passepartout frame ~2x', Math.abs(zoomed.w / base.w - 2) < 0.15,
    `grew ${(zoomed.w / base.w).toFixed(2)}`);

  // Pan → the frame center shifts by panX * (canvasWidth / 2).
  await t.evaluate(`(() => { const cv = window.__app.renderer.camView; cv.zoom = 1; cv.panX = 0.4; cv.panY = 0; })()`);
  await t.sleep(60);
  const panned = await t.evaluate(frame);
  const expect = 0.4 * (canvasW / 2);
  t.check('pan shifts the passepartout frame by panX·(canvasW/2)', Math.abs((panned.cx - base.cx) - expect) < 5,
    `shift ${(panned.cx - base.cx).toFixed(1)} vs ${expect.toFixed(1)}`);

  // Consistency: after a zoom+pan, project the cube via the RENDER proj, then
  // both renderer.pick AND the OrbitCamera input ray at that pixel must land on
  // the cube (proves applyCamView is applied identically to render + input).
  await t.evaluate(`(() => { window.__app.renderer.camView = { zoom: 1.7, panX: 0.25, panY: -0.15 }; })()`);
  await t.sleep(120); // let syncInputCameraToView mirror camView onto the input camera
  const check = await t.evaluate(`(() => {
    const app = window.__app, s = app.scene, r = app.renderer, cam = app.camera;
    const canvas = document.querySelector('#viewport-wrap canvas') || document.querySelector('canvas');
    const rect = canvas.getBoundingClientRect();
    const c = s.worldTransformOf(s.get(window.__cubeId)).position;
    const ndc = r.currentViewProj(s, cam).transformPoint(c);
    const sx = (ndc.x + 1) / 2 * rect.width, sy = (1 - ndc.y) / 2 * rect.height;
    const hit = r.pick(s, cam, sx, sy);
    const ray = cam.pointerRay(sx, sy, rect.width, rect.height);
    const closest = ray.origin.add(ray.dir.scale(c.sub(ray.origin).dot(ray.dir)));
    return { pickId: hit && hit.kind === 'object' ? hit.id : -1, cubeId: window.__cubeId, miss: closest.sub(c).length() };
  })()`);
  t.check('render pick hits the cube through the zoomed/panned frame', check.pickId === check.cubeId);
  t.check('input ray matches the render frame after zoom+pan (miss ≈ 0)', check.miss < 0.02, `miss ${check.miss.toFixed(4)}`);

  // Zooming the frame past the canvas must NOT overflow #viewport-wrap — an
  // oversized passepartout used to trigger scrollbars, shrinking the canvas and
  // oscillating the frame every rAF ("stuck between two zoom positions").
  await t.evaluate(`(() => { window.__app.renderer.camView = { zoom: 3, panX: 0.1, panY: 0.05 }; })()`);
  await t.sleep(120);
  const over = await t.evaluate(`(() => {
    const wrap = document.getElementById('viewport-wrap');
    const de = document.scrollingElement || document.documentElement;
    return Math.max(0, wrap.scrollWidth - wrap.clientWidth, wrap.scrollHeight - wrap.clientHeight,
      de.scrollWidth - de.clientWidth, de.scrollHeight - de.clientHeight);
  })()`);
  t.check('a zoomed-in passepartout does not overflow the viewport (no scrollbar loop)', over <= 1, `overflow ${over}px`);
  await t.evaluate(`(() => { window.__app.renderer.camView = { zoom: 1, panX: 0, panY: 0 }; })()`);
  await t.sleep(60);

  // A plain MMB (no shift) still EXITS camera view.
  const rect = await t.evaluate(`(() => { const r = document.querySelector('canvas').getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
  await t.mouse('mouseMoved', rect.x, rect.y);
  await t.mouse('mousePressed', rect.x, rect.y, 'middle');
  await t.mouse('mouseReleased', rect.x, rect.y, 'middle');
  await t.sleep(60);
  t.check('plain MMB exits camera view', (await t.evaluate('window.__app.renderer.cameraViewId')) === null);
});
