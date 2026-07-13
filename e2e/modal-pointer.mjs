/**
 * Continuous-grab modal pointer (UR4-1).
 *
 * Headless Chrome has NO working Pointer Lock, so this exercises the FALLBACK
 * path: the virtual pointer is accumulated from real-event position deltas
 * (movementX/Y under real lock isn't reachable here). We verify:
 *   (1) G then pointer moves translate the object;
 *   (2) the SAME pixel distance with Shift held moves it ~0.1× as far;
 *   (3) engaging Shift mid-gesture never jumps the position (continuous);
 *   (4) moving to coordinates BEYOND the canvas rect keeps integrating (the
 *       virtual pointer is unbounded — edge of canvas no longer stops the tool);
 *   (5) Escape still cancels (restores the pre-G position).
 *
 * Run: E2E_PORT=<unique> node e2e/modal-pointer.mjs   (dev server on :5199)
 */
import { runE2e } from './harness.mjs';

const SHIFT = 8; // harness modifier bitmask: alt=1 ctrl=2 meta=4 shift=8

runE2e(async (t) => {
  await t.key('Escape', 'Escape', 0); // dismiss splash
  t.check('app booted', await t.until('!!window.__app'));

  // Default scene: Cube + Camera + Spot; the cube (objects[0]) is selected.
  t.check('default cube exists and is selected', await t.evaluate(
    'window.__app.scene.objects.length === 3 && ' +
    'window.__app.scene.objects[0].name === "Cube" && ' +
    'window.__app.scene.selection.has(window.__app.scene.objects[0].id)'));

  const rect = await t.evaluate(
    '(() => { const r = document.querySelector("canvas").getBoundingClientRect();' +
    ' return { x: r.left, y: r.top, w: r.width, h: r.height, b: r.bottom }; })()');
  const cx = Math.round(rect.x + rect.w * 0.5);
  const cy = Math.round(rect.y + rect.h * 0.48); // off the exact origin (gizmo arrows converge there)

  const pos = () => t.evaluate(
    '(() => { const p = window.__app.scene.objects[0].transform.position; return [p.x, p.y, p.z]; })()');
  const mag = (p) => Math.hypot(p[0], p[1], p[2]);
  const active = () => t.evaluate('window.__app.input.activeOperatorName');
  const move = async (x, y, shift = false) => {
    await t.mouse('mouseMoved', x, y, 'none', { modifiers: shift ? SHIFT : 0 });
    await t.sleep(30);
  };
  const startG = async () => {
    await move(cx, cy);        // seat the real cursor at the cube (virtual pointer seed)
    await t.key('g', 'KeyG', 0);
    await t.sleep(40);
  };

  // The headless fallback is what we're testing — assert no real lock is held.
  t.check('no real pointer lock in headless (fallback path)',
    (await t.evaluate('document.pointerLockElement === null')) === true);

  // --- (1) G + moves translate the object ----------------------------------
  await startG();
  t.check('G starts a continuous-grab Move', (await active()) === 'Move', String(await active()));
  await move(cx + 100, cy);
  const moved = await pos();
  t.check('pointer move translates the object', mag(moved) > 0.1, moved.map((v) => v.toFixed(3)).join(','));
  const fullDisp = mag(moved);
  await t.key('Escape', 'Escape', 0);
  await t.sleep(40);
  t.check('Escape restores origin', mag(await pos()) < 1e-6);
  t.check('operator cleared after Escape', (await active()) === null);

  // --- (2) Shift = precision (~0.1× displacement for the same pixels) -------
  await startG();
  await move(cx + 100, cy, true); // same 100px, but Shift held from the first move
  const preciseDisp = mag(await pos());
  await t.key('Escape', 'Escape', 0);
  await t.sleep(40);
  const ratio = preciseDisp / fullDisp;
  t.check('Shift scales displacement to ~0.1×', ratio > 0.05 && ratio < 0.2, `ratio=${ratio.toFixed(3)}`);

  // --- (3) Shift engaged mid-gesture → no positional jump ------------------
  await startG();
  await move(cx + 60, cy);              // full-scale move
  const before = await pos();
  await move(cx + 60, cy, true);        // Shift ON, SAME coordinate (zero delta) → must not jump
  const afterShift = await pos();
  const jump = Math.hypot(afterShift[0] - before[0], afterShift[1] - before[1], afterShift[2] - before[2]);
  t.check('no jump when Shift engages mid-gesture', jump < 1e-6, `jump=${jump.toExponential(2)}`);
  await move(cx + 160, cy, true);       // now move 100px precise → should add ~0.1× more
  const afterPrecise = await pos();
  t.check('precise motion continues after the transition', mag(afterPrecise) > mag(before) + 1e-4);
  await t.key('Escape', 'Escape', 0);
  await t.sleep(40);
  t.check('Escape restores origin (3)', mag(await pos()) < 1e-6);

  // --- (4) Moves BEYOND the canvas rect keep integrating -------------------
  const outsideY = Math.round(rect.b + 80); // below the canvas bottom edge, still inside the window
  t.check('probe coordinate is beyond the canvas rect', outsideY > rect.b, `${outsideY} > ${rect.b}`);
  await startG();
  await move(cx, cy - 40);               // a modest in-canvas move first
  const inside = mag(await pos());
  await move(cx, outsideY);              // dispatched OUTSIDE the canvas — must still apply
  const outside = mag(await pos());
  t.check('out-of-canvas move still applies (virtual pointer keeps integrating)',
    outside > inside + 0.1, `inside=${inside.toFixed(3)} outside=${outside.toFixed(3)}`);
  await t.key('Escape', 'Escape', 0);
  await t.sleep(40);
  t.check('Escape restores origin (4)', mag(await pos()) < 1e-6);

  // --- (5) Escape cancels after a real drag (explicit) ---------------------
  await startG();
  await move(cx + 120, cy + 40);
  t.check('object moved before cancel', mag(await pos()) > 0.1);
  await t.key('Escape', 'Escape', 0);
  await t.sleep(40);
  t.check('Escape cancels the modal move', mag(await pos()) < 1e-6);
  t.check('no operator active after final Escape', (await active()) === null);
});
