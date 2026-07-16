/**
 * NB-B2 — curve-end continuity "Align" tool e2e. Builds two separated wavy
 * cubics via __app, selects both (active = the mover), opens the Align popover
 * with Shift+M, sets G1 + explicit ends through the REAL DOM controls, clicks
 * Apply, then asserts endpoint + flow-oriented tangent continuity numerically
 * from the resulting payloads. Ctrl+Z restores the original curve.
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  await t.until('!!window.__app');
  // CPU-path regression suite — pin CPU like the other NURBS suites.
  await t.until('!!window.__renderEngine');
  await t.evaluate("window.__renderEngine.setEngine('cpu')");

  // Pure NURBS math in-page, for reading continuity straight off the payloads.
  await t.evaluate(`(async () => { window.__nc = await import('/src/core/nurbs/curve.ts'); })()`);
  await t.until('!!window.__nc');

  const rect = await t.evaluate('(() => { const r = document.querySelector("canvas").getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()');

  // Build two separated wavy cubics; active = SRC (the one that moves).
  const ids = await t.evaluate(`(() => {
    const app = window.__app, scene = app.scene;
    const cubic = (pts) => ({ kind: 'nurbs', cyclic: false, resolution: 12, order: 4, points: pts.map(co => ({ co })) });
    const src = scene.addCurve('AlignSrc', cubic([
      [0,0,0],[1,1,0.2],[2,-0.5,0.5],[3,0.8,-0.3],[4,-0.6,0.4],[5,0.5,0.1],[6,0,0.6],
    ]));
    const tgt = scene.addCurve('AlignTgt', cubic([
      [10,0,0],[11,1.2,0.3],[12,-0.4,0.6],[13,0.9,-0.2],[14,-0.5,0.5],[15,0.3,0.2],
    ]));
    scene.selection.clear();
    scene.selection.add(src.id);
    scene.selection.add(tgt.id);
    scene.activeId = src.id;
    return { src: src.id, tgt: tgt.id };
  })()`);

  // Continuity probes from the payloads (src end → target start, ε=+1).
  const probe = () => t.evaluate(`(() => {
    const nc = window.__nc, app = window.__app;
    const src = app.scene.get(${ids.src}).curve, tgt = app.scene.get(${ids.tgt}).curve;
    const cs = nc.fromCurveData(src), ct = nc.fromCurveData(tgt);
    const [slo,shi] = nc.curveDomain(cs), [tlo,thi] = nc.curveDomain(ct);
    const sd = nc.curveDerivs(cs, shi, 1), td = nc.curveDerivs(ct, tlo, 1);
    const sp = nc.curvePoint(cs, shi), tp = nc.curvePoint(ct, tlo);
    const len = (v) => Math.hypot(v.x, v.y, v.z);
    const dot = (a,b) => a.x*b.x + a.y*b.y + a.z*b.z;
    const ts = sd[1], tt = td[1];
    const cosang = dot(ts, tt) / (len(ts) * len(tt)); // ε=+1 → same forward dir
    return {
      endpointDist: Math.hypot(sp.x - tp.x, sp.y - tp.y, sp.z - tp.z),
      tangentCos: cosang,
      srcEndPt: [sp.x, sp.y, sp.z],
      srcPts: src.points.map(p => p.co.slice()),
    };
  })()`);

  const before = await probe();
  t.check('curves start separated', before.endpointDist > 1, `dist=${before.endpointDist.toFixed(3)}`);

  // Open the Align popover with Shift+M (pointer over the canvas centre).
  await t.mouse('mouseMoved', Math.round(rect.x + rect.w * 0.5), Math.round(rect.y + rect.h * 0.5));
  await t.key('M', 'KeyM', 8); // shift+M
  await t.sleep(80);
  const popoverOpen = await t.evaluate('!!document.querySelector(".align-popover")');
  t.check('Align popover opens on Shift+M', popoverOpen);

  // Drive the REAL DOM controls: G1, source End → target Start, Apply.
  await t.evaluate(`(() => {
    const set = (sel, v) => { const el = document.querySelector(sel); el.value = v; el.dispatchEvent(new Event('change')); };
    set('.align-level', '1');
    set('.align-src', 'end');
    set('.align-tgt', 'start');
    document.querySelector('.align-popover-apply').click();
  })()`);
  await t.sleep(80);
  t.check('popover closes after Apply', !(await t.evaluate('!!document.querySelector(".align-popover")')));

  const after = await probe();
  t.check('G0 — endpoints coincident after Apply', after.endpointDist < 1e-9, `dist=${after.endpointDist.toExponential(2)}`);
  t.check('G1 — flow-oriented tangents aligned', after.tangentCos > 1 - 1e-6, `cos=${after.tangentCos}`);

  // The far end (opposite the join) did not move.
  const farMoved = await t.evaluate(`(() => {
    const a = ${JSON.stringify(before.srcPts[0])}, b = window.__app.scene.get(${ids.src}).curve.points[0].co;
    return Math.hypot(a[0]-b[0], a[1]-b[1], a[2]-b[2]);
  })()`);
  t.check('far endpoint control point unchanged', farMoved < 1e-9, `moved=${farMoved.toExponential(2)}`);

  // One undo restores the original source payload.
  await t.evaluate('window.__app.undo.undo()');
  await t.sleep(40);
  const restored = await probe();
  t.check('Ctrl+Z restores separation', restored.endpointDist > 1, `dist=${restored.endpointDist.toFixed(3)}`);
  t.check('Ctrl+Z restores exact source points',
    JSON.stringify(restored.srcPts) === JSON.stringify(before.srcPts));
});
