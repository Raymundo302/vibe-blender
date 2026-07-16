/**
 * NB-C3 v2 trimmed-tessellation e2e. Adds a flat NURBS patch in the XY plane
 * with a CIRCULAR hole trim, frames it top-down, and proves the hole is real:
 *   - the projected hole shows background pixels (a genuine cut, not shading);
 *   - the hole EDGE is round — 16 radial rays from the hole center hit the
 *     surface at ~the same radius (stdev < one sub-cell size), i.e. the snapped
 *     boundary rides a circle, not a stair-step.
 * Then a low-spp F12 (path tracer) snapshot confirms the trimmed mesh doesn't
 * crash the tracer (skipped gracefully if the render engine isn't exposed).
 * Screenshot: research/nurbs-trim.png.
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  await t.until('!!window.__app');
  await t.until('!!window.__renderEngine');
  await t.evaluate("window.__renderEngine.setEngine('cpu')"); // deterministic SwiftShader pixels

  // Clean slate + kill the floor grid/axes so the hole shows clean background.
  await t.evaluate(`(() => { const S = window.__app.scene; for (const o of [...S.objects]) S.remove(o.id); })()`);
  await t.key('Escape', 'Escape');
  await t.evaluate(`(async () => {
    const m = await import('/src/render/overlayPrefs.ts');
    m.overlays.grid = false;        // no floor grid / axis lines in the hole
    m.overlays.gizmo = false;       // no transform arrows at the origin (= hole center)
    m.overlays.originPoints = false; // no origin dot
  })()`);

  // ===== Add a flat 4×4 patch (XY, domain [0,1]²) with a circular hole =========
  // UV circle center (0.5,0.5) r=0.25 → world center origin, world radius 0.5 on
  // the 2×2 patch. Classic 9-pt rational four-arc circle in UV.
  await t.evaluate(`(() => {
    const S = window.__app.scene;
    const pts = [];
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++)
      pts.push({ co: [-1 + (2*i)/3, -1 + (2*j)/3, 0] });
    const s = Math.SQRT1_2, cu = 0.5, cv = 0.5, r = 0.25;
    const base = [[1,0,1],[1,1,s],[0,1,1],[-1,1,s],[-1,0,1],[-1,-1,s],[0,-1,1],[1,-1,s],[1,0,1]];
    const circle = {
      kind: 'nurbs', cyclic: false, resolution: 12, order: 3,
      knots: [0,0,0,0.25,0.25,0.5,0.5,0.75,0.75,1,1,1],
      points: base.map(([x,y,w]) => ({ co: [cu + x*r, cv + y*r, 0], w })),
    };
    const data = { degreeU: 3, degreeV: 3, pointsU: 4, pointsV: 4, points: pts,
      tess: { mode: 'spans', segsU: 8, segsV: 8, tol: 0.01 },
      trims: [{ hole: true, curve: circle }] };
    const o = S.addSurface('TrimPatch', data);
    S.selectOnly(o.id);
    window.__nsurf = o.id;
    window.__app.surface.sync();
  })()`);
  await t.until(`window.__app.scene.objects.some(o=>o.kind==='surface')`);
  await t.evaluate('window.__app.surface.sync()');

  const meshInfo = await t.evaluate(`(() => {
    const o = window.__app.scene.get(window.__nsurf);
    return { faces: o.mesh.faces.size, verts: o.mesh.verts.size };
  })()`);
  t.check('trimmed surface tessellated (non-empty mesh)', meshInfo.faces > 0 && meshInfo.verts > 0,
    JSON.stringify(meshInfo));

  // ===== Frame it top-down =====================================================
  const cam = await t.evaluate(`(() => {
    const c = window.__app.camera;
    c.target = window.__app.camera.target.constructor ? c.target : c.target;
    c.target.x = 0; c.target.y = 0; c.target.z = 0;
    c.yaw = 0;
    c.pitch = Math.PI/2 - 0.001;   // straight down
    c.distance = 3.4;
    return { fovY: c.fovY, distance: c.distance };
  })()`);

  // Render one frame + read the pixels. Flat patch top-down = a uniform orange
  // disc-with-hole; classify orange (r reddish & bright) vs everything else.
  const shot = await t.evaluate(`(() => {
    const app = window.__app, gl = app.renderer.ctx.gl, c = gl.canvas;
    app.renderer.render(app.scene, app.camera);
    const W = c.width, H = c.height;
    const buf = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const isOrange = (i) => { const r=buf[i], g=buf[i+1], b=buf[i+2];
      return r > 110 && r - b > 30 && r >= g - 10; };
    // Orange coverage + bounding box (the surface silhouette = the disc).
    let n = 0, minX = W, maxX = 0, minY = H, maxY = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (isOrange((y*W + x)*4)) { n++; if(x<minX)minX=x; if(x>maxX)maxX=x; if(y<minY)minY=y; if(y>maxY)maxY=y; }
    }
    // The disc is centered → hole center = bbox center; disc radius = half width.
    const hx = (minX + maxX) / 2, hy = (minY + maxY) / 2;
    const discR = Math.min(maxX - minX, maxY - minY) / 2;
    // Hole = NON-orange pixels ENCLOSED near the center (inner 70% of the disc),
    // excluding the background outside the disc silhouette.
    let hn = 0;
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      if (Math.hypot(x - hx, y - hy) < 0.7 * discR && !isOrange((y*W + x)*4)) hn++;
    }
    // 16 radial rays from the hole center: first orange pixel = the hole edge.
    const radii = [];
    for (let a = 0; a < 16; a++) {
      const ang = (a/16) * Math.PI*2, dx = Math.cos(ang), dy = Math.sin(ang);
      let hit = -1;
      for (let rr = 1; rr < Math.max(W,H); rr++) {
        const px = Math.round(hx + dx*rr), py = Math.round(hy + dy*rr);
        if (px < 0 || py < 0 || px >= W || py >= H) break;
        if (isOrange((py*W + px)*4)) { hit = rr; break; }
      }
      radii.push(hit);
    }
    // px-per-world at the z=0 target plane (perspective, on-axis).
    const pxPerWorld = H / (2 * app.camera.distance * Math.tan(app.camera.fovY/2));
    return { W, H, orange: n, bbox:[minX,minY,maxX,maxY], hole:[hx,hy], holeN: hn, radii, pxPerWorld };
  })()`);
  await t.screenshot('research/nurbs-trim.png');

  t.check('surface is rendered (orange coverage present)', shot.orange > 2000,
    `orange=${shot.orange}`);
  t.check('the hole is VISIBLE (background pixels inside the surface silhouette)',
    shot.holeN > 200, `holeInteriorPx=${shot.holeN} bbox=${JSON.stringify(shot.bbox)}`);

  // Roundness: all 16 edge radii found, low spread.
  const radii = shot.radii;
  const allHit = radii.every((r) => r > 3);
  t.check('all 16 radial rays cross the hole edge onto the surface', allHit,
    `radii=${JSON.stringify(radii)}`);
  const mean = radii.reduce((a, b) => a + b, 0) / radii.length;
  const variance = radii.reduce((a, b) => a + (b - mean) ** 2, 0) / radii.length;
  const stdev = Math.sqrt(variance);
  // One sub-cell = domain/8/8 in UV = 0.03125 world → px.
  const subCellPx = 0.03125 * shot.pxPerWorld;
  t.check('hole edge is round (radius stdev < one sub-cell)', stdev < subCellPx,
    `stdev=${stdev.toFixed(2)}px meanR=${mean.toFixed(1)}px subCell=${subCellPx.toFixed(2)}px`);

  // ===== Tracer (F12) doesn't crash on the trimmed mesh =======================
  const hasTracer = await t.evaluate('!!(window.__renderEngine && window.__renderEngine.start)');
  if (hasTracer) {
    await t.evaluate('window.__renderEngine.start()');
    const ok = await t.until('window.__renderEngine.sample() >= 2', 40000);
    const nonEmpty = await t.evaluate(`(() => {
      try {
        const cv = window.__renderEngine.canvas();
        return !!cv && cv.width > 0 && cv.height > 0;
      } catch (e) { return false; }
    })()`);
    t.check('path tracer renders the trimmed mesh without crashing', ok && nonEmpty,
      `sampled=${ok} canvas=${nonEmpty}`);
    await t.evaluate('window.__renderEngine.close()');
  } else {
    t.check('tracer helper not exposed — F12 snapshot skipped gracefully', true);
  }
});
