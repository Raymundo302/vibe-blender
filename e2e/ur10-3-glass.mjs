/**
 * UR10-3 e2e — GLASS (dielectric transmission) + METAL presets.
 * Run with the dev server up:
 *   flock /tmp/vibe-blender-e2e.lock node e2e/ur10-3-glass.mjs
 * Real GPU (the viewport blend pass): E2E_GPU=1 flock ... node e2e/ur10-3-glass.mjs
 *
 * Covers: (1) tracer glass sphere refracts the wall/floor behind it (see-through
 * center) with a brighter Fresnel rim, no black/NaN pixels; (2) metal preset
 * sphere reflects with a baseColor (gold) tint vs a white-plastic baseline;
 * (3) Rendered-viewport transmission blends the object behind through the glass;
 * (4) preset buttons set the field cluster in one click + one undo; plus the
 * eyes-on hero renders (glass + gold spheres, checker floor, area light).
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  const evalAsync = async (expr) => {
    const { result, exceptionDetails } = await t.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    });
    if (exceptionDetails) throw new Error(`page threw: ${exceptionDetails.text}`);
    return result.value;
  };

  // Projection world→render-canvas pixel via the active camera (from UR10-2).
  await t.evaluate(`window.__projRender = (wx, wy, wz) => {
    const s = window.__app.scene, cam = s.activeCamera;
    const m = s.cameraWorldMatrix(cam).m;
    const ex=m[12],ey=m[13],ez=m[14], rx=m[0],ry=m[1],rz=m[2], ux=m[4],uy=m[5],uz=m[6], fx=-m[8],fy=-m[9],fz=-m[10];
    const dx=wx-ex, dy=wy-ey, dz=wz-ez;
    const zc=dx*fx+dy*fy+dz*fz, xc=dx*rx+dy*ry+dz*rz, yc=dx*ux+dy*uy+dz*uz;
    const th=12/cam.camera.focalLength;
    const cvs=window.__renderEngine.canvas(), aspect=cvs.width/cvs.height;
    const ndcx=xc/zc/(aspect*th), ndcy=yc/zc/th;
    return { px: Math.round((ndcx+1)/2*cvs.width), py: Math.round((1-ndcy)/2*cvs.height) };
  }; true`);

  // Mean RGB of an N×N render-canvas patch around a world point.
  const patchRGB = (wx, wy, wz, half = 4) => t.evaluate(`(() => {
    const p = window.__projRender(${wx}, ${wy}, ${wz});
    const cvs = window.__renderEngine.canvas(), ctx = cvs.getContext('2d');
    const H = ${half};
    const x0 = Math.max(0, p.px-H), y0 = Math.max(0, p.py-H);
    const d = ctx.getImageData(x0, y0, 2*H+1, 2*H+1).data;
    let r=0,g=0,b=0,n=0;
    for (let i=0;i<d.length;i+=4){ r+=d[i]; g+=d[i+1]; b+=d[i+2]; n++; }
    return { r:r/n, g:g/n, b:b/n, lum:(0.2126*r+0.7152*g+0.0722*b)/n };
  })()`);

  const renderF12 = async (spp, timeout = 180000) => {
    await t.evaluate('window.__renderEngine.start()');
    await t.sleep(60);
    const ok = await t.until(`window.__renderEngine.sample() >= ${spp}`, timeout);
    t.check(`F12 reaches >= ${spp} samples`, ok);
  };

  // === (1) Tracer: glass sphere in front of a red wall on a checker floor =====
  const s1 = await evalAsync(`(async () => {
    const s = window.__app.scene;
    if (s.editMode) s.exitEditMode();
    for (const o of [...s.objects]) s.remove(o.id);
    const prim = await import('/src/core/mesh/primitives.ts');
    const Quat = (await import('/src/core/math/quat.ts')).Quat;
    const V = window.__app.camera.target.constructor;
    // Moderately bright gradient sky so the Fresnel rim reflects something bright.
    s.world = { mode:'gradient', color:[0,0,0], horizon:[0.55,0.62,0.78], zenith:[0.30,0.42,0.72], strength:1, hdri:null, hdriImage:null };
    // Checker floor at z=0.
    const floor = s.add('Floor', prim.makePlane(40));
    const fmat = s.addMaterial('Checker'); fmat.baseColor=[0.8,0.8,0.8]; fmat.roughness=0.9; fmat.texKind='checker';
    floor.materialId = fmat.id;
    // A big RED wall behind the sphere (shadeless → any ray that lands on it comes
    // back pure red, deterministic; NOT a mesh light, so it doesn't tint the room).
    const wall = s.add('Wall', prim.makePlane(24));
    wall.transform = wall.transform.withPosition(new V(0, 5, 3)).withRotation(Quat.fromAxisAngle(new V(1,0,0), -Math.PI/2));
    const wmat = s.addMaterial('RedWall'); wmat.baseColor=[0.85,0.02,0.02]; wmat.shadeless=true;
    wall.materialId = wmat.id;
    // Glass sphere between the camera and the wall.
    const ball = s.add('Glass', prim.makeUvSphere(1.3, 56, 28));
    ball.transform = ball.transform.withPosition(new V(0, 0, 2));
    const gmat = s.addMaterial('GlassMat');
    gmat.baseColor=[0.96,0.96,0.96]; gmat.metallic=0; gmat.roughness=0; gmat.transmission=1; gmat.ior=1.45;
    ball.materialId = gmat.id;
    s.addLight('Sun', 'sun');
    // Camera looking +Y at the sphere; wall fills the background behind it.
    const cam = s.addCamera('Camera');
    cam.transform = cam.transform.withPosition(new V(0, -7, 2.2));
    const tgt = s.addEmpty('T'); tgt.transform = tgt.transform.withPosition(new V(0,0,2));
    cam.camera.lookAtId = tgt.id; cam.camera.focalLength = 50;
    s.activeCameraId = cam.id;
    s.renderSettings = { width: 480, height: 400 };
    s.deselectAll();
    return { ballId: ball.id, gmat: gmat.id };
  })()`);
  t.check('glass scene built', typeof s1.gmat === 'number');

  await renderF12(64);
  // Center probe: THROUGH the glass we see the red wall (r ≫ g,b), NOT the
  // sphere's own near-white color (which would be r≈g≈b).
  const center = await patchRGB(0, 0, 2, 3);
  t.check('probe THROUGH the glass shows the red wall behind (red-dominant, not the sphere\'s own white)',
    center.r > center.g * 1.6 && center.r > center.b * 1.6,
    `center rgb=${center.r.toFixed(0)},${center.g.toFixed(0)},${center.b.toFixed(0)}`);

  // Rim probe: near the silhouette the Fresnel reflection of the bright sky
  // dominates → brighter than the transmitted (red wall) center.
  const rim = await t.evaluate(`(() => {
    const c = window.__projRender(0, 0, 2);        // sphere centre
    const e = window.__projRender(1.3, 0, 2);      // sphere +x edge
    const R = Math.abs(e.px - c.px);
    const rx = c.px + Math.round(0.86 * R), ry = c.py;
    const cvs = window.__renderEngine.canvas(), ctx = cvs.getContext('2d');
    const d = ctx.getImageData(rx-2, ry-2, 5, 5).data;
    let s=0,n=0; for (let i=0;i<d.length;i+=4){ s+=0.2126*d[i]+0.7152*d[i+1]+0.0722*d[i+2]; n++; }
    return s/n;
  })()`);
  t.check('probe at the rim shows a Fresnel reflection brighter than the transmitted centre',
    rim > center.lum + 6, `rim=${rim.toFixed(1)} center.lum=${center.lum.toFixed(1)}`);

  // TIR / NaN guard: no pure-black pixels inside the sphere's screen bbox (a NaN
  // direction would readPixels back as 0,0,0). The bright sky + red wall + checker
  // floor means nothing there is legitimately pure black.
  const blackCount = await t.evaluate(`(() => {
    const c = window.__projRender(0, 0, 2);
    const e = window.__projRender(1.3, 0, 2);
    const R = Math.abs(e.px - c.px);
    const cvs = window.__renderEngine.canvas(), ctx = cvs.getContext('2d');
    const x0 = Math.max(0, c.px-R), y0 = Math.max(0, c.py-R);
    const w = Math.min(cvs.width-x0, 2*R), h = Math.min(cvs.height-y0, 2*R);
    const d = ctx.getImageData(x0, y0, w, h).data;
    let black=0; for (let i=0;i<d.length;i+=4){ if (d[i]===0 && d[i+1]===0 && d[i+2]===0) black++; }
    return black;
  })()`);
  t.check('no black / NaN pixels in the glass sphere region (TIR handled)', blackCount === 0, `black=${blackCount}`);
  await t.evaluate('window.__renderEngine.close()');
  await t.sleep(120);

  // === (2) Metal preset sphere reflects with its baseColor tint ===============
  const s2 = await evalAsync(`(async () => {
    const s = window.__app.scene;
    for (const o of [...s.objects]) s.remove(o.id);
    const prim = await import('/src/core/mesh/primitives.ts');
    const V = window.__app.camera.target.constructor;
    s.world = { mode:'gradient', color:[0,0,0], horizon:[0.85,0.85,0.9], zenith:[0.7,0.72,0.82], strength:1.2, hdri:null, hdriImage:null };
    const floor = s.add('Floor', prim.makePlane(40));
    const fmat = s.addMaterial('Floor'); fmat.baseColor=[0.6,0.6,0.6]; floor.materialId=fmat.id;
    const ball = s.add('Ball', prim.makeUvSphere(1.3, 48, 24));
    ball.transform = ball.transform.withPosition(new V(0,0,1.6));
    const mat = s.addMaterial('Metal'); mat.baseColor=[1.0, 0.76, 0.33]; // gold albedo
    ball.materialId = mat.id;
    const sun = s.addLight('Sun','sun'); sun.light.power = 4;
    const cam = s.addCamera('Camera'); cam.transform = cam.transform.withPosition(new V(0,-7,2.2));
    const tgt = s.addEmpty('T'); tgt.transform = tgt.transform.withPosition(new V(0,0,1.6));
    cam.camera.lookAtId = tgt.id; cam.camera.focalLength = 50;
    s.activeCameraId = cam.id;
    s.renderSettings = { width: 420, height: 360 };
    s.deselectAll();
    return { ballId: ball.id, mat: mat.id };
  })()`);
  t.check('metal scene built', typeof s2.mat === 'number');

  // Apply the Metal preset directly to the gold material (metallic 1, rough 0.15).
  await t.evaluate(`(() => {
    const m = window.__app.scene.getMaterial(${s2.mat});
    m.metallic = 1; m.roughness = 0.15; m.transmission = 0; // == the Metal preset cluster
  })()`);
  await renderF12(48);
  const gold = await patchRGB(0, 0, 1.6, 4);
  await t.evaluate('window.__renderEngine.close()'); await t.sleep(120);

  // Baseline: same sphere as WHITE PLASTIC (metallic 0, neutral base).
  await t.evaluate(`(() => {
    const m = window.__app.scene.getMaterial(${s2.mat});
    m.metallic = 0; m.roughness = 0.5; m.baseColor = [0.8,0.8,0.8];
  })()`);
  await renderF12(48);
  const plastic = await patchRGB(0, 0, 1.6, 4);
  await t.evaluate('window.__renderEngine.close()'); await t.sleep(120);

  const goldRatio = gold.r / Math.max(1, gold.b);
  const plasticRatio = plastic.r / Math.max(1, plastic.b);
  t.check('metal preset sphere is gold-tinted (r/b) vs a neutral white-plastic baseline',
    goldRatio > plasticRatio * 1.25 && goldRatio > 1.25,
    `gold r/b=${goldRatio.toFixed(2)} plastic r/b=${plasticRatio.toFixed(2)}`);

  // === (3) Rendered viewport: transmission lets the object behind show through =
  await evalAsync(`(async () => {
    const s = window.__app.scene;
    for (const o of [...s.objects]) s.remove(o.id);
    const prim = await import('/src/core/mesh/primitives.ts');
    const V = window.__app.camera.target.constructor;
    s.world = { mode:'flat', color:[0.05,0.05,0.06], horizon:[0.05,0.05,0.06], zenith:[0.05,0.05,0.06], strength:1, hdri:null, hdriImage:null };
    const app = window.__app;
    app.camera.target = new V(0,0,0); app.camera.distance = 6;
    // A bright RED cube directly BEHIND the sphere along the view direction.
    const fwd = app.camera.forward;
    const cube = s.add('Behind', prim.makeCube(0.9));
    cube.transform = cube.transform.withPosition(new V(fwd.x*3.2, fwd.y*3.2, fwd.z*3.2));
    const cmat = s.addMaterial('Red'); cmat.baseColor=[1,0,0]; cmat.emissive=[1,0,0]; cmat.emissiveStrength=1; cube.materialId = cmat.id;
    const ball = s.add('Glass', prim.makeUvSphere(1, 32, 16));
    const gmat = s.addMaterial('Glass'); gmat.baseColor=[0.95,0.95,0.95]; gmat.transmission=1; gmat.ior=1.45; gmat.roughness=0;
    ball.materialId = gmat.id;
    s.addLight('Sun','sun');
    app.renderer.shadingMode = 'rendered';
    app.renderer.cameraViewId = null;
    s.deselectAll();
    window.__glassMat = gmat.id;
  })()`);
  await t.evaluate(`document.querySelector('.splash-overlay, [class*="splash"]')?.remove()`);
  await t.sleep(80);

  // Read the centre pixel (sphere centre = origin = screen centre) via GL.
  const vpCenter = () => t.evaluate(`(() => {
    const app = window.__app, gl = app.renderer.ctx.gl, c = gl.canvas;
    app.renderer.render(app.scene, app.camera);
    const buf = new Uint8Array(4);
    gl.readPixels((c.width>>1), (c.height>>1), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return { r: buf[0], g: buf[1], b: buf[2] };
  })()`);

  const glassPix = await vpCenter();
  // Flip to opaque and re-read: the red cube is now hidden.
  await t.evaluate(`window.__app.scene.getMaterial(window.__glassMat).transmission = 0`);
  await t.sleep(30);
  const opaquePix = await vpCenter();
  // Restore glass for the eyes-on shot.
  await t.evaluate(`window.__app.scene.getMaterial(window.__glassMat).transmission = 1`);

  t.check('Rendered viewport: glass sphere lets the red object behind bleed through (redder than opaque)',
    glassPix.r - glassPix.b > (opaquePix.r - opaquePix.b) + 12,
    `glass=${glassPix.r},${glassPix.g},${glassPix.b} opaque=${opaquePix.r},${opaquePix.g},${opaquePix.b}`);
  t.check('Rendered viewport: glass and opaque centre pixels differ (blend path active)',
    Math.abs(glassPix.r - opaquePix.r) + Math.abs(glassPix.b - opaquePix.b) > 10,
    `glass.r=${glassPix.r} opaque.r=${opaquePix.r}`);

  // === (4) Presets: one click sets the cluster, one undo reverts ==============
  const preset = await evalAsync(`(async () => {
    const s = window.__app.scene;
    for (const o of [...s.objects]) s.remove(o.id);
    const prim = await import('/src/core/mesh/primitives.ts');
    const cube = s.add('Cube', prim.makeCube(1));
    const mat = s.addMaterial('Mat');
    mat.baseColor=[0.3,0.5,0.9]; mat.metallic=0.5; mat.roughness=0.7; mat.transmission=0; mat.ior=1.45;
    cube.materialId = mat.id;
    s.selectOnly(cube.id);
    // Let the material tab pick up the active object.
    window.__app.propertiesEditor?.select?.('material');
    return { matId: mat.id, before: { metallic: mat.metallic, roughness: mat.roughness, transmission: mat.transmission, base: [...mat.baseColor] } };
  })()`);
  await t.sleep(60);
  const pushBefore = await t.evaluate('window.__app.undo.pushCount');
  // "One click" — drive the Glass preset button's handler.
  await t.evaluate(`window.__materialTab.applyPreset('glass')`);
  const afterGlass = await evalAsync(`(async () => {
    const m = window.__app.scene.getMaterial(${preset.matId});
    return { metallic: m.metallic, roughness: m.roughness, transmission: m.transmission, ior: m.ior, base: [...m.baseColor], pushed: window.__app.undo.pushCount };
  })()`);
  t.check('Glass preset sets the whole cluster (transmission 1, metallic 0, roughness 0)',
    afterGlass.transmission === 1 && afterGlass.metallic === 0 && afterGlass.roughness === 0 && afterGlass.base[0] > 0.9,
    JSON.stringify(afterGlass));
  t.check('Glass preset is exactly ONE undo entry', afterGlass.pushed === pushBefore + 1,
    `before=${pushBefore} after=${afterGlass.pushed}`);

  await t.evaluate('window.__app.undo.undo()');
  const reverted = await evalAsync(`(async () => {
    const m = window.__app.scene.getMaterial(${preset.matId});
    return { metallic: m.metallic, roughness: m.roughness, transmission: m.transmission };
  })()`);
  t.check('one undo reverts the whole preset cluster',
    reverted.transmission === 0 && Math.abs(reverted.metallic - 0.5) < 1e-9 && Math.abs(reverted.roughness - 0.7) < 1e-9,
    JSON.stringify(reverted));

  // Metal preset keeps the current base color as its tint.
  await t.evaluate(`window.__materialTab.applyPreset('metal')`);
  const afterMetal = await evalAsync(`(async () => {
    const m = window.__app.scene.getMaterial(${preset.matId});
    return { metallic: m.metallic, roughness: m.roughness, transmission: m.transmission, base: [...m.baseColor] };
  })()`);
  t.check('Metal preset: metallic 1, roughness 0.15, transmission 0, base color preserved',
    afterMetal.metallic === 1 && Math.abs(afterMetal.roughness - 0.15) < 1e-9 && afterMetal.transmission === 0
      && Math.abs(afterMetal.base[0] - 0.3) < 1e-9,
    JSON.stringify(afterMetal));

  // Preset buttons exist in the DOM (real one-click affordance).
  const buttonsExist = await t.evaluate(`!!window.__materialTab.presetButton('glass') && !!window.__materialTab.presetButton('metal')`);
  t.check('Glass + Metal preset buttons render in the Material tab', buttonsExist);

  // === Eyes-on hero: glass + gold spheres on a checker floor under an area light
  await evalAsync(`(async () => {
    const s = window.__app.scene;
    for (const o of [...s.objects]) s.remove(o.id);
    const prim = await import('/src/core/mesh/primitives.ts');
    const Quat = (await import('/src/core/math/quat.ts')).Quat;
    const V = window.__app.camera.target.constructor;
    s.world = { mode:'gradient', color:[0,0,0], horizon:[0.5,0.58,0.72], zenith:[0.22,0.32,0.6], strength:1, hdri:null, hdriImage:null };
    const floor = s.add('Floor', prim.makePlane(50));
    const fmat = s.addMaterial('Checker'); fmat.baseColor=[0.85,0.85,0.85]; fmat.roughness=0.85; fmat.texKind='checker'; floor.materialId=fmat.id;
    // Red back wall so the glass sphere clearly refracts a color.
    const wall = s.add('Wall', prim.makePlane(30));
    wall.transform = wall.transform.withPosition(new V(0,6,4)).withRotation(Quat.fromAxisAngle(new V(1,0,0), -Math.PI/2));
    const wmat = s.addMaterial('BackWall'); wmat.baseColor=[0.8,0.12,0.12]; wmat.roughness=0.9; wall.materialId=wmat.id;
    // Glass sphere (left) + gold metal sphere (right).
    const glass = s.add('Glass', prim.makeUvSphere(1.25, 44, 22));
    glass.transform = glass.transform.withPosition(new V(-1.6, 0, 1.3));
    const gm = s.addMaterial('Glass'); gm.baseColor=[0.97,0.97,0.98]; gm.transmission=1; gm.ior=1.45; gm.roughness=0; glass.materialId=gm.id;
    const gold = s.add('Gold', prim.makeUvSphere(1.25, 44, 22));
    gold.transform = gold.transform.withPosition(new V(1.6, 0.2, 1.3));
    const au = s.addMaterial('Gold'); au.baseColor=[1.0,0.76,0.33]; au.metallic=1; au.roughness=0.12; gold.materialId=au.id;
    // Area light overhead (UR10-1) for a soft key.
    const area = s.addLight('Area','area');
    area.transform = area.transform.withPosition(new V(0,-1,6)).withRotation(Quat.fromAxisAngle(new V(1,0,0), -Math.PI/2));
    area.light.power = 500; area.light.width = 5; area.light.height = 5;
    s.addLight('Sun','sun');
    const cam = s.addCamera('Camera'); cam.transform = cam.transform.withPosition(new V(0,-7.5,2.6));
    const tgt = s.addEmpty('T'); tgt.transform = tgt.transform.withPosition(new V(0,0,1.2));
    cam.camera.lookAtId = tgt.id; cam.camera.focalLength = 55;
    s.activeCameraId = cam.id;
    s.renderSettings = { width: 680, height: 460 };
    s.deselectAll();
  })()`);
  // Best-effort convergence for the eyes-on shot: poll for a decent sample count
  // but never FAIL the suite on the (slow, CPU-bound) hero — the screenshot is the
  // deliverable, not a numeric threshold.
  await t.evaluate('window.__renderEngine.start()');
  await t.sleep(60);
  const heroOk = await t.until('window.__renderEngine.sample() >= 40', 300000);
  await t.screenshot('research/ur10-3-glass-gold-hero.png');
  const heroSpp = await t.evaluate('window.__renderEngine.sample()');
  t.check('hero glass+gold render captured', true, `samples=${heroSpp}${heroOk ? '' : ' (did not reach 40 — screenshot still saved)'}`);
  await t.evaluate('window.__renderEngine.close()');
});
