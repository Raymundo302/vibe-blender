/**
 * UR10-1 e2e — Area light. Covers: (1) Shift+A → Light ▸ Area adds an area light
 * and the Width/Height fields appear; (2) the F12 path tracer renders a PENUMBRA
 * under an area light (soft shadow edge ≥3 px wide) vs a point light's hard edge
 * (≤2 px) on the same scene; (3) one-sided emission — flipping the light 180°
 * darkens the floor; (4) the rectangle gizmo lines are drawn (pixel probe, icons
 * overlay on); (5) the Rendered viewport lights the floor (approximation active,
 * no crash) and an old (pre-area) scene still loads.
 *
 * Run with the dev server up:
 *   E2E_PORT=9581 flock /tmp/vibe-blender-e2e.lock node e2e/ur10-area-light.mjs
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  // Force the Layout workspace so the Properties panel + viewport are present.
  await t.evaluate(`document.querySelector('.wsp-tab[data-workspace="Layout"]')?.click()`);
  await t.sleep(150);

  // ---------------------------------------------------------------------------
  // (1) Shift+A → Light ▸ Area  — the real add-menu path; fields appear.
  // ---------------------------------------------------------------------------
  await t.evaluate(`(() => {
    const s = window.__app.scene;
    if (s.editMode) s.exitEditMode();
    for (const o of [...s.objects]) if (o.kind !== 'mesh') s.remove(o.id);
    s.cursor = s.cursor.constructor.ZERO; // add-at-origin
  })()`);
  await t.sleep(80);

  await t.key('a', 'KeyA', 8); // Shift+A
  await t.sleep(140);
  t.check('Shift+A opened the Add menu', await t.evaluate(`!!document.querySelector('.add-menu')`));
  // Open the Light category flyout, then click Area.
  await t.evaluate(`(() => {
    const cat = document.querySelector('.add-menu-category[data-category="Light"]');
    if (cat) cat.click();
  })()`);
  await t.sleep(140);
  await t.evaluate(`(() => {
    const btn = [...document.querySelectorAll('.add-menu-flyout .add-menu-item')]
      .find((b) => b.textContent.trim() === 'Area');
    if (btn) btn.click();
  })()`);
  await t.sleep(160);

  const added = await t.evaluate(`(() => {
    const s = window.__app.scene;
    const l = s.objects.find((o) => o.kind === 'light' && o.light.type === 'area');
    if (!l) return null;
    return { type: l.light.type, w: l.light.width, h: l.light.height, active: s.activeId === l.id };
  })()`);
  t.check('Shift+A ▸ Light ▸ Area added an area light (1×1), made active',
    added && added.type === 'area' && added.w === 1 && added.h === 1 && added.active,
    JSON.stringify(added));

  // The Light tab shows Width/Height and hides Radius + the Spot cone block.
  await t.evaluate(`document.querySelector('.properties-tab-btn[data-tab="light"]').click()`);
  await t.sleep(160);
  t.check('area light: Width/Height rows visible; Radius + Spot hidden',
    await t.evaluate(`(() => {
      const p = document.querySelector('.properties-pane[data-tab="light"]');
      const area = p.querySelector('.light-tab-area');
      const spot = p.querySelector('.light-tab-spot');
      const rad = [...p.querySelectorAll('.light-tab-row')].find((r) => r.querySelector('[data-field="radius"]'));
      return !!p.querySelector('[data-field="width"]') && !!p.querySelector('[data-field="height"]')
        && area && getComputedStyle(area).display !== 'none'
        && spot && getComputedStyle(spot).display === 'none'
        && rad && getComputedStyle(rad).display === 'none';
    })()`));

  // Editing Width writes the model (and clamps > 0.01).
  await t.evaluate(`(() => {
    const inp = document.querySelector('.properties-pane[data-tab="light"] [data-field="width"]');
    inp.value = '3'; inp.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(120);
  t.check('Width edit updates the light (1 → 3)',
    Math.abs((await t.evaluate(`window.__app.scene.objects.find((o)=>o.light&&o.light.type==='area').light.width`)) - 3) < 1e-6);

  // ---------------------------------------------------------------------------
  // Shared tracer helpers (F12 renders from the viewport OrbitCamera when there
  // is no active camera).
  // ---------------------------------------------------------------------------
  const RENDER_W = 400, RENDER_H = 300;

  // Build the half-plane shadow scene: a big floor, a horizontal panel covering
  // x<0 (its straight edge at x=0), and one overhead light centred above the
  // edge. Point vs area only differ in the light — a clean 1-D penumbra profile.
  const buildShadowScene = (lightType, sizeOrRadius) => t.evaluate(`(async () => {
    const S = window.__app.scene;
    const prim = await import('/src/core/mesh/primitives.ts');
    const V = (await import('/src/core/math/vec3.ts')).Vec3;
    const Q = (await import('/src/core/math/quat.ts')).Quat;
    if (S.editMode) S.exitEditMode();
    for (const o of [...S.objects]) S.remove(o.id);
    S.renderSettings = { width: ${RENDER_W}, height: ${RENDER_H} };
    // Flat black world → the umbra is dark (GI only), maximizing edge contrast.
    S.world.mode = 'flat'; S.world.color = [0, 0, 0]; S.world.strength = 1;
    // Floor.
    const floor = S.add('Floor', prim.makePlane(60));
    // Occluder panel covering x<0, edge at x=0, held 5 units above the floor.
    const panel = S.add('Panel', prim.makePlane(40));
    panel.transform = panel.transform.withPosition(new V(-20, 0, 5));
    // Light overhead, centred above the panel edge, aiming straight down (-Z).
    const l = S.addLight('L', '${lightType}');
    l.light.power = 60000;
    if ('${lightType}' === 'area') { l.light.width = ${sizeOrRadius}; l.light.height = ${sizeOrRadius}; }
    else { l.light.radius = ${sizeOrRadius}; }
    l.transform = l.transform.withPosition(new V(0, 0, 15));
    S.deselectAll();
    window.__ur10ready = true;
  })()`);

  // Reconstruct the tracer's world→pixel projection (mirrors buildCamera's
  // OrbitCamera basis + renderSample's ray math) and measure the shadow-edge
  // transition WIDTH IN PIXELS along the floor's X axis at y=0, z=0.
  const penumbraPx = () => t.evaluate(`(() => {
    const app = window.__app, cam = app.camera;
    const V = cam.eye.constructor;
    const eye = cam.eye, fwd = cam.forward;
    let right = fwd.cross(new V(0, 1, 0));
    right = right.lengthSq() < 1e-9 ? new V(1, 0, 0) : right.normalize();
    const up = right.cross(fwd).normalize();
    const cv = window.__renderEngine.canvas();
    const w = cv.width, h = cv.height, aspect = w / h, th = Math.tan(cam.fovY / 2);
    const img = cv.getContext('2d').getImageData(0, 0, w, h).data;
    const project = (P) => {
      const vx = P.x - eye.x, vy = P.y - eye.y, vz = P.z - eye.z;
      const cf = vx * fwd.x + vy * fwd.y + vz * fwd.z;
      if (cf <= 0) return null;
      const cr = vx * right.x + vy * right.y + vz * right.z;
      const cu = vx * up.x + vy * up.y + vz * up.z;
      const sx = (cr / cf) / (aspect * th), sy = (cu / cf) / th;
      const px = (sx * 0.5 + 0.5) * w - 0.5;
      const py = (1 - sy) / 2 * h - 0.5;
      return { px, py };
    };
    const lumAtPx = (px, py) => {
      const x = Math.round(px), y = Math.round(py);
      if (x < 0 || x >= w || y < 0 || y >= h) return null;
      const i = (y * w + x) * 4;
      return 0.2126 * img[i] + 0.7152 * img[i + 1] + 0.0722 * img[i + 2];
    };
    // Sample the floor line x ∈ [-6, 6] at y=0, z=0.
    const samples = [];
    for (let x = 6; x >= -6; x -= 0.03) {
      const sp = project(new V(x, 0, 0));
      if (!sp) continue;
      const L = lumAtPx(sp.px, sp.py);
      if (L == null) continue;
      samples.push({ x, px: sp.px, py: sp.py, L });
    }
    if (samples.length < 20) return { width: -1, lo: 0, hi: 0, n: samples.length };
    let lo = Infinity, hi = -Infinity;
    for (const s of samples) { if (s.L < lo) lo = s.L; if (s.L > hi) hi = s.L; }
    const range = hi - lo;
    if (range < 12) return { width: 0, lo, hi, n: samples.length };
    const mid = lo + 0.5 * range, t75 = lo + 0.75 * range, t25 = lo + 0.25 * range;
    // Localize the shadow edge: the descending mid-crossing with the steepest
    // drop (scan runs lit +X → umbra -X, so index increases toward the umbra).
    // This ignores the far-field 1/d² falloff and measures only the edge itself.
    let m = -1, steepest = 0;
    for (let i = 0; i + 1 < samples.length; i++) {
      if (samples[i].L >= mid && samples[i + 1].L < mid) {
        const drop = samples[i].L - samples[i + 1].L;
        if (m === -1 || drop > steepest) { m = i; steepest = drop; }
      }
    }
    if (m === -1) return { width: 0, lo, hi, n: samples.length };
    // Nearest lit sample (≥75%) walking back toward +X; nearest umbra (≤25%) forward.
    let a = null, b = null;
    for (let i = m; i >= 0; i--) { if (samples[i].L >= t75) { a = samples[i]; break; } }
    for (let i = m + 1; i < samples.length; i++) { if (samples[i].L <= t25) { b = samples[i]; break; } }
    if (!a || !b) return { width: 0, lo, hi, n: samples.length };
    const width = Math.hypot(a.px - b.px, a.py - b.py);
    return { width, lo, hi, n: samples.length };
  })()`);

  const renderAndWait = async (minSamples = 140, timeout = 60000) => {
    await t.evaluate('window.__renderEngine.start()');
    const ok = await t.until(`window.__renderEngine.sample() >= ${minSamples}`, timeout);
    return ok;
  };

  // --- Set a top-down-ish camera looking at the shadow edge from +X. ---
  const setShadowCamera = () => t.evaluate(`(() => {
    const c = window.__app.camera;
    c.target = c.target.constructor.ZERO;
    c.yaw = Math.PI / 2; c.pitch = 0.46; c.distance = 13.4;
  })()`);

  // ---------------------------------------------------------------------------
  // (2) Penumbra: area (8×8) soft edge vs point (radius 0) hard edge, same scene.
  // ---------------------------------------------------------------------------
  await buildShadowScene('area', 8);
  t.check('shadow scene (area) built', await t.until('window.__ur10ready === true'));
  await t.evaluate('window.__ur10ready = false');
  await setShadowCamera();
  await t.evaluate('window.__renderEngine.close()');
  t.check('area render reaches samples', await renderAndWait());
  await t.sleep(200);
  const areaEdge = await penumbraPx();
  await t.screenshot('research/ur10-area-penumbra.png');
  await t.evaluate('window.__renderEngine.close()');

  await buildShadowScene('point', 0);
  await t.until('window.__ur10ready === true');
  await t.evaluate('window.__ur10ready = false');
  await setShadowCamera();
  t.check('point render reaches samples', await renderAndWait());
  await t.sleep(200);
  const pointEdge = await penumbraPx();
  await t.evaluate('window.__renderEngine.close()');

  t.check('area light casts a PENUMBRA: shadow edge ≥ 3 px wide',
    areaEdge.width >= 3, `area width=${areaEdge.width?.toFixed?.(2)} (lo=${areaEdge.lo?.toFixed?.(1)} hi=${areaEdge.hi?.toFixed?.(1)} n=${areaEdge.n})`);
  t.check('point light edge is hard: ≤ 2 px',
    pointEdge.width >= 0 && pointEdge.width <= 2, `point width=${pointEdge.width?.toFixed?.(2)}`);
  t.check('area penumbra is markedly softer than the point edge',
    areaEdge.width >= pointEdge.width + 2, `area=${areaEdge.width?.toFixed?.(2)} point=${pointEdge.width?.toFixed?.(2)}`);

  // ---------------------------------------------------------------------------
  // (3) One-sided emission: an overhead area light lights the floor; flipping it
  //     180° (face now points UP) leaves the floor dark.
  // ---------------------------------------------------------------------------
  await t.evaluate(`(async () => {
    const S = window.__app.scene;
    const prim = await import('/src/core/mesh/primitives.ts');
    const V = (await import('/src/core/math/vec3.ts')).Vec3;
    if (S.editMode) S.exitEditMode();
    for (const o of [...S.objects]) S.remove(o.id);
    S.renderSettings = { width: 240, height: 200 };
    // Flat black world so a flipped (one-sided) light leaves the floor truly dark
    // (no sky illumination to wash the result).
    S.world.mode = 'flat'; S.world.color = [0, 0, 0]; S.world.strength = 1;
    S.add('Floor', prim.makePlane(60));
    const l = S.addLight('L', 'area');
    l.light.power = 40000; l.light.width = 6; l.light.height = 6;
    l.transform = l.transform.withPosition(new V(0, 0, 12));
    S.deselectAll();
    window.__ur10light = l.id;
    window.__ur10ready = true;
  })()`);
  await t.until('window.__ur10ready === true');
  await t.evaluate('window.__ur10ready = false');
  // Top-down-ish view of the floor centre.
  await t.evaluate(`(() => { const c = window.__app.camera; c.target = c.target.constructor.ZERO; c.yaw = 0; c.pitch = 1.15; c.distance = 12; })()`);
  await t.evaluate('window.__renderEngine.close()');

  // Read the floor's central luminance from the tracer canvas centre.
  const floorCenterLum = () => t.evaluate(`(() => {
    const cv = window.__renderEngine.canvas(), w = cv.width, h = cv.height;
    const d = cv.getContext('2d').getImageData(0, 0, w, h).data;
    // Average a small central patch (floor fills the frame from this view).
    let sum = 0, n = 0;
    for (let y = Math.floor(h*0.4); y < Math.floor(h*0.6); y++)
      for (let x = Math.floor(w*0.4); x < Math.floor(w*0.6); x++) {
        const i = (y*w+x)*4; sum += 0.2126*d[i]+0.7152*d[i+1]+0.0722*d[i+2]; n++;
      }
    return sum / n;
  })()`);

  t.check('one-sided: front render reaches samples', await renderAndWait(80));
  await t.sleep(150);
  const litFront = await floorCenterLum();
  await t.evaluate('window.__renderEngine.close()');

  // Flip the light 180° about X → its emitting -Z face now points UP.
  await t.evaluate(`(() => {
    const S = window.__app.scene, l = S.get(window.__ur10light);
    const Q = l.transform.rotation.constructor;
    l.transform = l.transform.withRotation(new Q(1, 0, 0, 0)); // 180° about X
  })()`);
  t.check('flipped render reaches samples', await renderAndWait(80));
  await t.sleep(150);
  const litFlipped = await floorCenterLum();
  await t.evaluate('window.__renderEngine.close()');

  t.check('overhead area light lights the floor (front face down)',
    litFront > 25, `front lum=${litFront?.toFixed?.(1)}`);
  t.check('one-sided: flipping 180° darkens the floor (emits away from it)',
    litFlipped < litFront * 0.3, `front=${litFront?.toFixed?.(1)} flipped=${litFlipped?.toFixed?.(1)}`);

  // ---------------------------------------------------------------------------
  // (4) Rectangle gizmo lines drawn in the viewport (pixel probe, icons ON).
  //     A single selected area light, identity rotation (rect in world XY). We
  //     probe the rect-edge screen positions with icons ON vs OFF.
  // ---------------------------------------------------------------------------
  await t.evaluate(`(async () => {
    const S = window.__app.scene;
    const V = (await import('/src/core/math/vec3.ts')).Vec3;
    if (S.editMode) S.exitEditMode();
    for (const o of [...S.objects]) S.remove(o.id);
    const l = S.addLight('Area', 'area');
    l.light.width = 8; l.light.height = 8;      // big rect, identity rotation
    S.selectOnly(l.id);                          // selected → orange gizmo tint
    window.__ur10ov = (await import('/src/render/overlayPrefs.ts')).overlays;
    window.__ur10ready = true;
  })()`);
  await t.until('window.__ur10ready === true');
  await t.evaluate('window.__ur10ready = false');
  await t.evaluate(`window.__app.renderer.shadingMode = 'matcap'`);
  // Oblique-but-high view so the horizontal rect reads as an outline (not nadir,
  // which is a degenerate look-at).
  await t.evaluate(`(() => { const c = window.__app.camera; c.target = c.target.constructor.ZERO; c.yaw = 0; c.pitch = 1.3; c.distance = 20; })()`);
  await t.sleep(120);

  // Probe: max luminance in a small box around a projected world point, from the
  // viewport GL canvas (mirrors shading.mjs pixelAt but returns a box max).
  const boxMaxLum = (wx, wy, wz) => t.evaluate(`(() => {
    const app = window.__app, gl = app.renderer.ctx.gl, c = gl.canvas;
    app.renderer.render(app.scene, app.camera);
    const vp = app.renderer.currentViewProj(app.scene, app.camera).m;
    const cx = vp[0]*${wx}+vp[4]*${wy}+vp[8]*${wz}+vp[12];
    const cy = vp[1]*${wx}+vp[5]*${wy}+vp[9]*${wz}+vp[13];
    const cw = vp[3]*${wx}+vp[7]*${wy}+vp[11]*${wz}+vp[15];
    const px = Math.round((cx/cw*0.5+0.5)*c.width);
    const py = Math.round((cy/cw*0.5+0.5)*c.height);
    const R = 4, sz = 2*R+1;
    const out = new Uint8Array(sz*sz*4);
    gl.readPixels(px-R, py-R, sz, sz, gl.RGBA, gl.UNSIGNED_BYTE, out);
    let max = 0, maxOrange = 0;
    for (let i = 0; i < out.length; i += 4) {
      const L = 0.2126*out[i]+0.7152*out[i+1]+0.0722*out[i+2];
      if (L > max) max = L;
      // orange gizmo tint: r>g>b, reddish
      if (out[i] > 120 && out[i] > out[i+2] + 30) maxOrange = Math.max(maxOrange, out[i]);
    }
    return { max, maxOrange };
  })()`);

  // Rect left/right edge midpoints in world (identity rotation → local XY = world XY).
  const probeEdges = async () => {
    const l = await boxMaxLum(-4, 0, 0);
    const r = await boxMaxLum(4, 0, 0);
    return { left: l, right: r };
  };

  await t.evaluate('window.__ur10ov.icons = true');
  await t.sleep(80);
  const gizmoOn = await probeEdges();
  await t.screenshot('research/ur10-rect-gizmo.png');
  await t.evaluate('window.__ur10ov.icons = false');
  await t.sleep(80);
  const gizmoOff = await probeEdges();
  await t.evaluate('window.__ur10ov.icons = true'); // restore

  t.check('rect gizmo: edge pixels brighter with icons ON than OFF (left edge)',
    gizmoOn.left.max > gizmoOff.left.max + 20,
    `on=${gizmoOn.left.max.toFixed(0)} off=${gizmoOff.left.max.toFixed(0)}`);
  t.check('rect gizmo: edge pixels brighter with icons ON than OFF (right edge)',
    gizmoOn.right.max > gizmoOff.right.max + 20,
    `on=${gizmoOn.right.max.toFixed(0)} off=${gizmoOff.right.max.toFixed(0)}`);
  t.check('rect gizmo: the line carries the selection (orange) tint',
    gizmoOn.left.maxOrange > 100 || gizmoOn.right.maxOrange > 100,
    `orange L=${gizmoOn.left.maxOrange.toFixed(0)} R=${gizmoOn.right.maxOrange.toFixed(0)}`);

  // ---------------------------------------------------------------------------
  // (5) Rendered viewport lights the floor (approximation, no crash) + old scenes
  //     still load.
  // ---------------------------------------------------------------------------
  await t.evaluate(`(async () => {
    const S = window.__app.scene;
    const prim = await import('/src/core/mesh/primitives.ts');
    const V = (await import('/src/core/math/vec3.ts')).Vec3;
    if (S.editMode) S.exitEditMode();
    for (const o of [...S.objects]) S.remove(o.id);
    S.add('Floor', prim.makePlane(30));
    const l = S.addLight('Area', 'area');
    l.light.power = 200000; l.light.width = 4; l.light.height = 4;
    l.transform = l.transform.withPosition(new V(0, 0, 8));
    S.deselectAll();
    window.__ur10lid = l.id;
    window.__ur10ready = true;
  })()`);
  await t.until('window.__ur10ready === true');
  await t.evaluate('window.__ur10ready = false');
  await t.evaluate(`window.__app.renderer.shadingMode = 'rendered'`);
  await t.evaluate(`(() => { const c = window.__app.camera; c.target = c.target.constructor.ZERO; c.yaw = 0; c.pitch = 1.1; c.distance = 12; })()`);
  await t.sleep(150);

  const floorLumRendered = (wx, wy) => t.evaluate(`(() => {
    const app = window.__app, gl = app.renderer.ctx.gl, c = gl.canvas;
    app.renderer.render(app.scene, app.camera);
    const vp = app.renderer.currentViewProj(app.scene, app.camera).m;
    const cx = vp[0]*${wx}+vp[4]*${wy}+vp[12];
    const cy = vp[1]*${wx}+vp[5]*${wy}+vp[13];
    const cw = vp[3]*${wx}+vp[7]*${wy}+vp[15];
    const px = Math.round((cx/cw*0.5+0.5)*c.width);
    const py = Math.round((cy/cw*0.5+0.5)*c.height);
    const out = new Uint8Array(4);
    gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return 0.2126*out[0]+0.7152*out[1]+0.0722*out[2];
  })()`);

  const litRenderedFloor = await floorLumRendered(0, 0);
  // Remove the light → the floor goes near-black (proves the light did the lighting).
  await t.evaluate(`(() => { const S = window.__app.scene; S.remove(window.__ur10lid); })()`);
  await t.sleep(80);
  const darkRenderedFloor = await floorLumRendered(0, 0);
  await t.screenshot('research/ur10-rendered-viewport.png');

  t.check('Rendered viewport: area light lights the floor (approximation active)',
    litRenderedFloor > darkRenderedFloor + 20,
    `lit=${litRenderedFloor.toFixed(1)} dark=${darkRenderedFloor.toFixed(1)}`);

  // Old scene load: a pre-area v3 scene (point light + cube) must still parse.
  const oldLoad = await t.evaluate(`(() => {
    try {
      const raw = JSON.stringify({
        format: 'vibe-blender-scene', version: 3,
        camera: { target: [0,0,0], distance: 8, yaw: 0, pitch: 0 },
        activeCameraId: null, materials: [],
        objects: [{
          id: 0, name: 'Cube', kind: 'mesh', visible: true, shadeSmooth: false,
          color: [0.8,0.8,0.8], materialId: null,
          transform: { position: [0,0,0], rotation: [0,0,0,1], scale: [1,1,1] },
          mesh: { verts: [[0,-1,-1,0],[1,1,-1,0],[2,1,1,0],[3,-1,1,0]], faces: [[0,[0,1,2,3]]] }, modifiers: [],
        }, {
          id: 1, name: 'Lamp', kind: 'light', visible: true, shadeSmooth: false,
          color: [0.8,0.8,0.8], materialId: null,
          transform: { position: [0,0,5], rotation: [0,0,0,1], scale: [1,1,1] },
          mesh: { verts: [], faces: [] }, modifiers: [],
          light: { type: 'point', color: [1,1,1], power: 100, spotAngle: 0.5, spotBlend: 0.1 },
        }],
      });
      window.__app.io.apply(raw);
      const s = window.__app.scene;
      const names = s.objects.map((o) => o.name).join(',');
      const lightOk = s.objects.some((o) => o.kind === 'light' && o.light.type === 'point');
      return { ok: true, names, lightOk };
    } catch (e) { return { ok: false, err: String(e && e.message || e) }; }
  })()`);
  t.check('old (pre-area, v3) scene loads without error',
    oldLoad.ok && oldLoad.lightOk, JSON.stringify(oldLoad));

  // ---------------------------------------------------------------------------
  // Eyes-on hero: a cube resting on a floor under a TILTED area light, path
  // traced — the soft shadow should be visibly gradient-edged.
  // ---------------------------------------------------------------------------
  await t.evaluate(`(async () => {
    const S = window.__app.scene;
    const prim = await import('/src/core/mesh/primitives.ts');
    const V = (await import('/src/core/math/vec3.ts')).Vec3;
    const Q = (await import('/src/core/math/quat.ts')).Quat;
    if (S.editMode) S.exitEditMode();
    for (const o of [...S.objects]) S.remove(o.id);
    S.renderSettings = { width: 480, height: 360 };
    S.world.mode = 'gradient';
    const floor = S.add('Floor', prim.makePlane(40));
    const cube = S.add('Cube', prim.makeCube(1));
    cube.transform = cube.transform.withPosition(new V(0, 0, 1)); // rests on floor
    const l = S.addLight('Area', 'area');
    l.light.power = 120000; l.light.width = 5; l.light.height = 5;
    // Tilt: sit up-and-back (-Y, +Z), aim -Z toward the cube by rotating ~40°
    // about X so the soft shadow rakes forward across the floor.
    l.transform = l.transform
      .withPosition(new V(0, -6, 9))
      .withRotation(Q.fromAxisAngle(new V(1, 0, 0), -0.7));
    S.deselectAll();
    // A pleasant 3/4 view.
    const c = window.__app.camera;
    c.target = new V(0, 0, 0.6); c.yaw = 0.7; c.pitch = 0.5; c.distance = 11;
    window.__ur10ready = true;
  })()`);
  await t.until('window.__ur10ready === true');
  await t.evaluate('window.__ur10ready = false');
  await t.evaluate('window.__renderEngine.close()');
  t.check('hero render reaches samples', await renderAndWait(90, 120000));
  await t.sleep(300);
  await t.screenshot('research/ur10-hero-cube-area-light.png');
  await t.evaluate('window.__renderEngine.close()');
});
