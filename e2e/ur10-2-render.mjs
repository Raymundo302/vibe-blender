/**
 * UR10-2 e2e — emissive MESH LIGHTS (NEE), camera GLARE (bloom), F-Stop DoF.
 * Run with the dev server up:
 *   flock /tmp/vibe-blender-e2e.lock node e2e/ur10-2-render.mjs
 * Real GPU (the glare GL pass): E2E_GPU=1 flock ... node e2e/ur10-2-render.mjs
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  // UR12-3: default render engine is GPU; these are CPU-path regression suites — pin CPU.
  await t.until('!!window.__renderEngine');
  await t.evaluate("window.__renderEngine.setEngine('cpu')");
  // evaluate() that awaits page promises (dynamic imports / async render()).
  const evalAsync = async (expr) => {
    const { result, exceptionDetails } = await t.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    });
    if (exceptionDetails) throw new Error(`page threw: ${exceptionDetails.text}`);
    return result.value;
  };

  // === (1) Emissive plane lights a dark room + casts a soft shadow ==========
  // A floor, a cube resting on it, and a glowing panel directly overhead in an
  // otherwise black world (no analytic lights). F12 render, then compare pixels
  // with the panel emitting (strength 10) vs a no-emitter baseline (strength 0).
  const s1 = await evalAsync(`(async () => {
    const s = window.__app.scene;
    if (s.editMode) s.exitEditMode();
    for (const o of [...s.objects]) s.remove(o.id);
    const prim = await import('/src/core/mesh/primitives.ts');
    const Quat = (await import('/src/core/math/quat.ts')).Quat;
    const V = window.__app.camera.target.constructor;
    s.world = { mode: 'flat', color: [0,0,0], horizon: [0,0,0], zenith: [0,0,0], strength: 1, hdri: null, hdriImage: null };
    const floor = s.add('Floor', prim.makePlane(30));      // XY plane at z=0
    const cube = s.add('Cube', prim.makeCube(1));           // half-extent 1
    cube.transform = cube.transform.withPosition(new V(0, 0, 1)); // rests on floor
    // Glowing WALL on the -X side (a plane rotated vertical, normal → +X toward the
    // cube). It lights the floor between it and the cube; the cube casts a shadow
    // toward +X (visible to the camera). Its far (+X) face is lit only indirectly.
    const panel = s.add('Panel', prim.makePlane(5));
    panel.transform = panel.transform.withPosition(new V(-4.5, 0, 2)).withRotation(Quat.fromAxisAngle(new V(0,1,0), Math.PI/2));
    const mat = s.addMaterial('Emit');
    mat.emissive = [1, 1, 1];
    mat.emissiveStrength = 10;
    panel.materialId = mat.id;
    // Camera on the +X / -Y corner, looking at the cube: sees the cube's +X face
    // (facing AWAY from the wall) and the shadow the cube casts toward +X.
    const cam = s.addCamera('Camera');
    cam.transform = cam.transform.withPosition(new V(8, -7, 4));
    const tgt = s.addEmpty('Target');
    tgt.transform = tgt.transform.withPosition(new V(0.5, 0, 1));
    cam.camera.lookAtId = tgt.id;
    cam.camera.focalLength = 35;
    s.activeCameraId = cam.id;
    s.renderSettings = { width: 420, height: 320 };
    s.deselectAll();
    return { panelMat: mat.id, camId: cam.id, cubeId: cube.id };
  })()`);
  t.check('emissive scene built', typeof s1.panelMat === 'number');

  // World→render-canvas pixel (top-left origin, for getImageData) via the active
  // camera at the render-window aspect. Mirrors empty-camera-targets' __projScreen.
  await t.evaluate(`window.__projRender = (wx, wy, wz) => {
    const s = window.__app.scene;
    const cam = s.activeCamera;
    const m = s.cameraWorldMatrix(cam).m;
    const ex=m[12],ey=m[13],ez=m[14], rx=m[0],ry=m[1],rz=m[2], ux=m[4],uy=m[5],uz=m[6], fx=-m[8],fy=-m[9],fz=-m[10];
    const dx=wx-ex, dy=wy-ey, dz=wz-ez;
    const zc=dx*fx+dy*fy+dz*fz, xc=dx*rx+dy*ry+dz*rz, yc=dx*ux+dy*uy+dz*uz;
    const th=12/cam.camera.focalLength;
    const cvs=window.__renderEngine.canvas();
    const aspect=cvs.width/cvs.height;
    const ndcx=xc/zc/(aspect*th), ndcy=yc/zc/th;
    return { px: Math.round((ndcx+1)/2*cvs.width), py: Math.round((1-ndcy)/2*cvs.height) };
  }; true`);

  // Mean luminance of an 11×11 patch of the render canvas around a world point.
  const patchLum = (wx, wy, wz) => t.evaluate(`(() => {
    const p = window.__projRender(${wx}, ${wy}, ${wz});
    const cvs = window.__renderEngine.canvas(), ctx = cvs.getContext('2d');
    const x0 = Math.max(0, p.px-5), y0 = Math.max(0, p.py-5);
    const d = ctx.getImageData(x0, y0, 11, 11).data;
    let s = 0, n = 0;
    for (let i=0;i<d.length;i+=4){ s += 0.2126*d[i]+0.7152*d[i+1]+0.0722*d[i+2]; n++; }
    return s/n;
  })()`);

  const renderF12 = async (spp) => {
    await t.evaluate('window.__renderEngine.start()');
    await t.sleep(60);
    const ok = await t.until(`window.__renderEngine.sample() >= ${spp}`, 120000);
    t.check(`F12 reaches >= ${spp} samples`, ok);
  };

  // Probe points: floor lit by the wall (between wall and cube), floor in the
  // cube's shadow (+X of the cube), and the cube's +X face (facing away from wall).
  const LIT = [-2, 0, 0], SHADOW = [2.4, 0, 0], SIDE = [1.02, 0, 1];

  // Baseline: wall not emitting → the whole dark room is black.
  await t.evaluate(`window.__app.scene.materials.find(m => m.id===${s1.panelMat}).emissiveStrength = 0`);
  await renderF12(24);
  const litOff = await patchLum(...LIT);
  const sideOff = await patchLum(...SIDE);
  await t.evaluate('window.__renderEngine.close()');
  await t.sleep(120);

  // Emitter on (strength 10).
  await t.evaluate(`window.__app.scene.materials.find(m => m.id===${s1.panelMat}).emissiveStrength = 10`);
  await renderF12(24);
  const litOn = await patchLum(...LIT);
  const sideOn = await patchLum(...SIDE);
  const shadowOn = await patchLum(...SHADOW);
  await t.evaluate('window.__renderEngine.close()');
  await t.sleep(120);

  t.check('emissive wall lights the floor (lit floor brighter than no-emitter baseline)',
    litOn > litOff + 15, `off=${litOff.toFixed(1)} on=${litOn.toFixed(1)}`);
  t.check('cube face NOT facing the wall is lit indirectly (brighter than baseline)',
    sideOn > sideOff + 4, `off=${sideOff.toFixed(1)} on=${sideOn.toFixed(1)}`);
  t.check('soft shadow: floor behind the cube is darker than the lit floor',
    shadowOn < litOn - 15, `shadow=${shadowOn.toFixed(1)} lit=${litOn.toFixed(1)}`);

  // === (2) Camera Glare (bloom) ============================================
  // A small emissive dot in a dark scene, an active camera facing it. F12 with
  // glare on grows a halo the bright-pass+blur produces; glare off has none.
  const s2 = await evalAsync(`(async () => {
    const s = window.__app.scene;
    for (const o of [...s.objects]) s.remove(o.id);
    const prim = await import('/src/core/mesh/primitives.ts');
    const V = window.__app.camera.target.constructor;
    s.world = { mode: 'flat', color: [0,0,0], horizon: [0,0,0], zenith: [0,0,0], strength: 1, hdri: null, hdriImage: null };
    const dot = s.add('Dot', prim.makeCube(0.02));   // tiny bright dot (few px)
    const mat = s.addMaterial('DotEmit');
    mat.emissive = [1, 1, 1]; mat.emissiveStrength = 40;
    dot.materialId = mat.id;
    const cam = s.addCamera('Camera');
    cam.transform = cam.transform.withPosition(new V(0, -14, 0));
    const tgt = s.addEmpty('T'); tgt.transform = tgt.transform.withPosition(new V(0,0,0));
    cam.camera.lookAtId = tgt.id;
    cam.camera.focalLength = 50;
    cam.camera.glare = { enabled: false, threshold: 1.0, strength: 1.5, radius: 0.06 };
    s.activeCameraId = cam.id;
    s.renderSettings = { width: 600, height: 600 };
    s.deselectAll();
    return { camId: cam.id, dotId: dot.id };
  })()`);
  t.check('glare scene built', typeof s2.camId === 'number');

  // Ring-halo metric: mean luminance of a ~7px-radius ring around the dot centre,
  // EXCLUDING the bright core (which saturates with/without glare).
  const ringLum = () => t.evaluate(`(() => {
    const p = window.__projRender(0, 0, 0);
    const cvs = window.__renderEngine.canvas(), ctx = cvs.getContext('2d');
    const R0 = 6, R1 = 9;
    let s = 0, n = 0;
    for (let dy=-R1; dy<=R1; dy++) for (let dx=-R1; dx<=R1; dx++) {
      const r = Math.hypot(dx, dy);
      if (r < R0 || r > R1) continue;
      const x = p.px+dx, y = p.py+dy;
      if (x<0||y<0||x>=cvs.width||y>=cvs.height) continue;
      const d = ctx.getImageData(x, y, 1, 1).data;
      s += 0.2126*d[0]+0.7152*d[1]+0.0722*d[2]; n++;
    }
    return n ? s/n : 0;
  })()`);

  const setGlare = (on) => t.evaluate(`window.__app.scene.get(${s2.camId}).camera.glare.enabled = ${on}`);

  await setGlare(false);
  await renderF12(24);
  const ringOff = await ringLum();
  await t.evaluate('window.__renderEngine.close()');
  await t.sleep(120);

  await setGlare(true);
  await renderF12(24);
  const ringOn = await ringLum();
  await t.evaluate('window.__renderEngine.close()');
  await t.sleep(120);

  t.check('F12 glare ON blooms a halo ring around the dot (≥5px out)',
    ringOn > ringOff + 8, `off=${ringOff.toFixed(1)} on=${ringOn.toFixed(1)}`);

  // Ctrl+F12 (anim render, path traced) carries the same halo: the SAME frame
  // rendered with glare on vs off produces different pixels (glare applied in the
  // animRender tonemap seam). Compare the single PNG's CRC.
  const frameCrc = async () => evalAsync(`(async () => {
    const blob = await window.__app.animRender.render({ mode: 'png', engine: 'pathtraced', start: 1, end: 2, samples: 16, width: 200, height: 200 });
    const buf = new Uint8Array(await blob.arrayBuffer());
    const dv = new DataView(buf.buffer);
    return dv.getUint32(14, true); // first local header CRC
  })()`);
  await setGlare(false);
  const crcOff = await frameCrc();
  await setGlare(true);
  const crcOn = await frameCrc();
  t.check('Ctrl+F12 path-traced frame changes with glare (halo applied in anim seam)',
    typeof crcOff === 'number' && crcOff !== crcOn, `off=${crcOff} on=${crcOn}`);

  // Rendered viewport THROUGH the camera shows the halo; free navigation does NOT.
  await t.evaluate(`(() => {
    const app = window.__app;
    app.renderer.shadingMode = 'rendered';
    app.renderer.cameraViewId = ${s2.camId};
  })()`);
  await t.sleep(80);
  // Viewport ring metric via the WebGL canvas (readPixels, GL bottom-up coords).
  const vpRing = () => t.evaluate(`(() => {
    const app = window.__app, gl = app.renderer.ctx.gl, c = gl.canvas;
    app.renderer.render(app.scene, app.camera);
    const vp = app.renderer.currentViewProj(app.scene, app.camera).m;
    const cw = vp[3]*0+vp[7]*0+vp[11]*0+vp[15];
    const px = Math.round((0*0.5+0.5)*c.width), py = Math.round((0*0.5+0.5)*c.height); // origin projects to centre (dot at 0,0,0)
    const R0=6,R1=10; let s=0,n=0;
    const buf = new Uint8Array(4);
    for (let dy=-R1; dy<=R1; dy++) for (let dx=-R1; dx<=R1; dx++) {
      const r=Math.hypot(dx,dy); if (r<R0||r>R1) continue;
      const x=px+dx, y=py+dy; if (x<0||y<0||x>=c.width||y>=c.height) continue;
      gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      s += 0.2126*buf[0]+0.7152*buf[1]+0.0722*buf[2]; n++;
    }
    return n ? s/n : 0;
  })()`);
  // The viewport glare is a GL float-capture pass — unavailable on SwiftShader
  // (no EXT_color_buffer_float). Run the through-camera checks only where it can
  // (real GPU, E2E_GPU=1); note-and-skip on the software backend.
  const glareAvail = await t.evaluate('window.__app.renderer.glareAvailable === true');
  await setGlare(true);
  await t.sleep(60);
  const vpThroughOn = await vpRing();
  await setGlare(false);
  await t.sleep(60);
  const vpThroughOff = await vpRing();
  // Free navigation (orbit camera): with the SAME orbit framing, toggling the
  // camera's glare must make NO difference — glare only applies through-camera.
  // (Comparing free-nav to through-camera directly would confound the different
  // framing, so we compare glare-on vs glare-off within free navigation.)
  await t.evaluate(`(() => { const app = window.__app; app.renderer.cameraViewId = null;
    app.camera.target = new (app.camera.target.constructor)(0,0,0); app.camera.distance = 6; })()`);
  await setGlare(true);
  await t.sleep(60);
  const vpFreeGlareOn = await vpRing();
  await setGlare(false);
  await t.sleep(60);
  const vpFreeGlareOff = await vpRing();
  if (glareAvail) {
    t.check('viewport THROUGH camera blooms a halo when glare on',
      vpThroughOn > vpThroughOff + 6, `off=${vpThroughOff.toFixed(1)} on=${vpThroughOn.toFixed(1)}`);
    t.check('free navigation shows NO halo (glare toggle has no effect off-camera)',
      Math.abs(vpFreeGlareOn - vpFreeGlareOff) < 3, `on=${vpFreeGlareOn.toFixed(1)} off=${vpFreeGlareOff.toFixed(1)}`);
  } else {
    console.log(`SKIP  viewport glare (no float-render target on this backend — run E2E_GPU=1)  (through on=${vpThroughOn.toFixed(1)} off=${vpThroughOff.toFixed(1)} free on=${vpFreeGlareOn.toFixed(1)} off=${vpFreeGlareOff.toFixed(1)})`);
  }

  // Screenshot for eyes-on: glowing panel scene with glare, through-camera.
  await evalAsync(`(async () => {
    const s = window.__app.scene;
    for (const o of [...s.objects]) s.remove(o.id);
    const prim = await import('/src/core/mesh/primitives.ts');
    const V = window.__app.camera.target.constructor;
    s.world = { mode: 'flat', color: [0.01,0.01,0.02], horizon: [0.01,0.01,0.02], zenith: [0.02,0.02,0.03], strength: 1, hdri: null, hdriImage: null };
    const floor = s.add('Floor', prim.makePlane(30));
    const cube = s.add('Cube', prim.makeCube(1)); cube.transform = cube.transform.withPosition(new V(2.2, 0, 1));
    const panel = s.add('Panel', prim.makePlane(3)); panel.transform = panel.transform.withPosition(new V(-2, 0, 2.5));
    const rot = (await import('/src/core/math/quat.ts')).Quat.fromAxisAngle(new V(0,1,0), Math.PI/2);
    panel.transform = panel.transform.withRotation(rot);
    const mat = s.addMaterial('Emit'); mat.emissive = [1,0.85,0.6]; mat.emissiveStrength = 14; panel.materialId = mat.id;
    const cam = s.addCamera('Camera'); cam.transform = cam.transform.withPosition(new V(6, -7, 4.5));
    const tgt = s.addEmpty('T'); tgt.transform = tgt.transform.withPosition(new V(0,0,1.2));
    cam.camera.lookAtId = tgt.id; cam.camera.focalLength = 40;
    cam.camera.glare = { enabled: true, threshold: 1.0, strength: 1.2, radius: 0.05 };
    s.activeCameraId = cam.id;
    s.renderSettings = { width: 900, height: 600 };
    window.__app.renderer.shadingMode = 'rendered';
    window.__app.renderer.cameraViewId = cam.id;
    s.deselectAll();
  })()`);
  // Dismiss the first-visit splash so it doesn't overlay the eyes-on shot.
  await t.evaluate(`document.querySelector('.splash-overlay, [class*="splash"]')?.remove()`);
  await t.sleep(200);
  await t.evaluate('window.__app.renderer.render(window.__app.scene, window.__app.camera)');
  await t.sleep(100);
  await t.screenshot('research/ur10-2-glare-panel.png');
  t.check('glare panel screenshot captured', true);

  // === (3) F-Stop drives DoF ===============================================
  // Two cubes at different depths; focus on the near cube. fStop 0.5 (wide) blurs
  // the FAR cube; fStop 16 is near-pinhole (far cube stays sharp). Reuses the
  // UR5-7 local-contrast (variance) sharpness metric.
  await t.evaluate('window.__app.renderer.shadingMode = "matcap"');
  await t.evaluate('window.__app.renderer.cameraViewId = null');
  await t.evaluate('window.__renderEngine.setAperture(0)'); // clear any manual aperture
  const dof = await evalAsync(`(async () => {
    const s = window.__app.scene;
    for (const o of [...s.objects]) s.remove(o.id);
    const prim = await import('/src/core/mesh/primitives.ts');
    const V = window.__app.camera.target.constructor;
    s.world = { mode: 'flat', color: [0.02,0.02,0.02], horizon: [0.02,0.02,0.02], zenith: [0.02,0.02,0.02], strength: 1, hdri: null, hdriImage: null };
    // Camera at +Z looking down -Z (identity rotation): the cubes' DEPTH is their
    // Z. Subjects kept CLOSE (depth ~3 vs ~10) — DoF is only shallow up close (a
    // far subject has a naturally deep field even at f/0.5, just like a real lens).
    // Screen sizes matched (scale ∝ depth).
    const near = s.add('Near', prim.makeCube(1));
    near.transform = near.transform.withPosition(new V(-2.4, 0, 4)).withScale(new V(0.55,0.55,0.55)); // depth ~3
    const far = s.add('Far', prim.makeCube(1));
    far.transform = far.transform.withPosition(new V(2.4, 0, -3)).withScale(new V(1.4,1.4,1.4));       // depth ~10
    s.addLight('Sun', 'sun');
    const cam = s.addCamera('Camera'); cam.transform = cam.transform.withPosition(new V(0, 0, 7));
    cam.camera.focalLength = 35; // subjects fill more of the frame
    cam.camera.focusObjectId = near.id; // focus on the near cube
    cam.camera.dof = true;
    s.activeCameraId = cam.id;
    s.renderSettings = { width: 800, height: 600 };
    s.deselectAll();
    return { nearId: near.id, farId: far.id, camId: cam.id };
  })()`);
  t.check('DoF two-depth scene built', typeof dof.camId === 'number');

  await t.evaluate(`window.__sharp = (x0f, x1f, y0f, y1f) => {
    const cvs = window.__renderEngine.canvas(), ctx = cvs.getContext('2d');
    const w=cvs.width,h=cvs.height;
    const x0=Math.floor(w*x0f),x1=Math.floor(w*x1f),y0=Math.floor(h*y0f),y1=Math.floor(h*y1f);
    const pw=x1-x0,ph=y1-y0,n=pw*ph;
    const d=ctx.getImageData(x0,y0,pw,ph).data;
    let s=0,s2=0;
    for (let i=0;i<d.length;i+=4){ const L=0.2126*d[i]+0.7152*d[i+1]+0.0722*d[i+2]; s+=L; s2+=L*L; }
    const m=s/n; return s2/n-m*m;
  }; true`);

  const farC = await t.evaluate(`(() => {
    const s=window.__app.scene, cam=s.activeCamera, m=s.cameraWorldMatrix(cam).m;
    const ex=m[12],ey=m[13],ez=m[14], rx=m[0],ry=m[1],rz=m[2], ux=m[4],uy=m[5],uz=m[6], fx=-m[8],fy=-m[9],fz=-m[10];
    const p=s.worldTransformOf(s.get(${dof.farId})).position;
    const dx=p.x-ex,dy=p.y-ey,dz=p.z-ez;
    const zc=dx*fx+dy*fy+dz*fz, xc=dx*rx+dy*ry+dz*rz, yc=dx*ux+dy*uy+dz*uz;
    const th=12/cam.camera.focalLength, cvs=window.__renderEngine.canvas(), aspect=cvs.width/cvs.height;
    return { sx:(xc/zc/(aspect*th)+1)/2, sy:(1-yc/zc/th)/2 };
  })()`);
  t.check('far DoF cube projects on-screen',
    farC.sx > 0.05 && farC.sx < 0.95, `far.sx=${farC.sx.toFixed(2)}`);
  const fp = [Math.max(0, farC.sx-0.14), Math.min(1, farC.sx+0.14), Math.max(0, farC.sy-0.18), Math.min(1, farC.sy+0.18)];

  const renderFarSharp = async (fStop, spp) => {
    await t.evaluate(`window.__app.scene.get(${dof.camId}).camera.fStop = ${fStop}`);
    await t.evaluate('window.__renderEngine.start()');
    await t.sleep(60);
    const ok = await t.until(`window.__renderEngine.sample() >= ${spp}`, 120000);
    t.check(`fStop ${fStop}: render reaches >= ${spp} samples`, ok);
    const v = await t.evaluate(`window.__sharp(${fp[0]}, ${fp[1]}, ${fp[2]}, ${fp[3]})`);
    await t.evaluate('window.__renderEngine.close()');
    await t.sleep(120);
    return v;
  };

  const farWide = await renderFarSharp(0.5, 40);  // wide aperture → far blurry
  const farNarrow = await renderFarSharp(16, 40); // near-pinhole → far sharp
  t.check('fStop 0.5 blurs the far (out-of-focus) cube vs fStop 16',
    farNarrow > farWide * 1.15, `f0.5=${farWide.toFixed(1)} f16=${farNarrow.toFixed(1)}`);

  // === (4) Migration: an old scene storing raw `aperture` loads + renders ===
  const mig = await evalAsync(`(async () => {
    const json = JSON.parse(window.__app.io.serialize());
    const camObj = json.objects.find((o) => o.kind === 'camera');
    delete camObj.camera.fStop; delete camObj.camera.dof;
    const focal = camObj.camera.focalLength;
    camObj.camera.aperture = 0.01; // legacy raw aperture radius
    window.__app.io.apply(JSON.stringify(json));
    const cam = window.__app.scene.objects.find((o) => o.kind === 'camera');
    return { dof: cam.camera.dof, fStop: cam.camera.fStop, expected: focal / (2000 * 0.01) };
  })()`);
  t.check('legacy aperture migrates to DoF-on with a derived fStop = focal/(2000·aperture)',
    mig.dof === true && Math.abs(mig.fStop - mig.expected) < 0.01 && mig.fStop >= 0.5 && mig.fStop <= 22,
    `dof=${mig.dof} fStop=${mig.fStop} expected=${mig.expected}`);
  await t.evaluate('window.__renderEngine.start()');
  await t.sleep(60);
  const migOk = await t.until('window.__renderEngine.sample() >= 4', 60000);
  t.check('migrated scene renders (F12 accumulates samples)', migOk);
  await t.evaluate('window.__renderEngine.close()');
});
