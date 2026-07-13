/**
 * UR16-4 — Textured emission: the emit shader's COLOR socket drives its light.
 *
 * (1) REGRESSION: an emit image plane (half-red / half-blue) renders its IMAGE
 *     again — not plain white — in Rendered-live AND the F12-CPU tracer AND the
 *     Raytraced-GPU tracer (pixel probes: left half red, right half blue).
 * (2) TV test: a dark room + an emit plane at strength 8 tints the floor red on
 *     the LEFT (under the image's red half) and blue on the RIGHT, on CPU AND GPU.
 * (3) strength 1 → the plane shows its pixels but the room is ~unlit (loose).
 * (4) a GRADIENT-driven emit surface also shows its color (one probe).
 * (5) a screenshot of the TV scene, looked at.
 *
 * Run on the real GPU (E2E_GPU=1) so the image atlas + GPU emitter NEE are exercised;
 * on SwiftShader the GPU probes still pass (float RGBA8 atlas is backend-agnostic).
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  await t.key('Escape', 'Escape', 0);

  // ---- shared setup: modules + a half-red/half-blue test PNG -------------------
  await t.evaluate(`window.__M = null; (async () => {
    const [ip, snap, tracer, gpu, prim, vec] = await Promise.all([
      import('/src/tools/imagePlane.ts'), import('/src/renderEngine/snapshot.ts'),
      import('/src/renderEngine/tracer.ts'), import('/src/renderEngine/gpu/gpuTracer.ts'),
      import('/src/core/mesh/primitives.ts'), import('/src/core/math/vec3.ts'),
    ]);
    const cvs = document.createElement('canvas'); cvs.width=16; cvs.height=16;
    const cx = cvs.getContext('2d');
    cx.fillStyle='rgb(230,20,20)'; cx.fillRect(0,0,8,16);   // left half red
    cx.fillStyle='rgb(20,20,230)'; cx.fillRect(8,0,8,16);   // right half blue
    window.__M = { ip, snap, tracer, gpu, prim, Vec3: vec.Vec3, url: cvs.toDataURL('image/png') };
  })()`);
  t.check('modules + test PNG ready', await t.until('!!window.__M'));

  // =============================================================================
  // (1) REGRESSION — Rendered-live raster shows the emit image (not white).
  // =============================================================================
  await t.evaluate(`(async () => {
    const S = window.__app.scene; if (S.editMode) S.exitEditMode();
    for (const o of [...S.objects]) S.remove(o.id);
    for (const m of [...S.materials]) S.removeMaterial(m.id);
    window.__app.undo.clear();
    const obj = window.__M.ip.createImagePlane(S, window.__app.undo, { dataUrl: window.__M.url, name:'tv', w:200, h:200, mode:'emit' });
    window.__reg = obj.id;
    for (let i=0;i<60 && !S.getMaterial(obj.materialId).texImage;i++) await new Promise(r=>setTimeout(r,20));
    const cam = window.__app.camera; cam.yaw=0; cam.pitch=1.4; cam.distance=5;
    window.__app.renderer.shadingMode = 'rendered';
    window.__app.shadePrefs.ao = false;
    S.deselectAll();
  })()`);
  await t.until('!!window.__reg');

  // Probe a plane point at object-normalized (sx in [-1,1], 0) in the live viewport.
  const liveProbe = (sx) => t.evaluate(`(() => {
    const app=window.__app, gl=app.renderer.ctx.gl, c=gl.canvas;
    app.renderer.render(app.scene, app.camera);
    const obj=app.scene.get(window.__reg);
    const xs=[...obj.mesh.verts.values()].map(v=>v.co.x);
    const halfW=Math.max(...xs);
    const w=app.scene.worldMatrix(obj).transformPoint({x:${sx}*halfW*0.7, y:0, z:0});
    const p=app.renderer.currentViewProj(app.scene, app.camera).transformPoint(w);
    const px=Math.round((p.x*0.5+0.5)*c.width), py=Math.round((p.y*0.5+0.5)*c.height);
    const out=new Uint8Array(4); gl.readPixels(px,py,1,1,gl.RGBA,gl.UNSIGNED_BYTE,out);
    return [out[0],out[1],out[2]];
  })()`);
  t.check('Rendered-live: texture uploaded (left half becomes red-dominant)',
    await t.until(`(() => {
      const app=window.__app, gl=app.renderer.ctx.gl, c=gl.canvas;
      app.renderer.render(app.scene, app.camera);
      const obj=app.scene.get(window.__reg);
      const xs=[...obj.mesh.verts.values()].map(v=>v.co.x), halfW=Math.max(...xs);
      const w=app.scene.worldMatrix(obj).transformPoint({x:-0.7*halfW, y:0, z:0});
      const p=app.renderer.currentViewProj(app.scene, app.camera).transformPoint(w);
      const px=Math.round((p.x*0.5+0.5)*c.width), py=Math.round((p.y*0.5+0.5)*c.height);
      const o=new Uint8Array(4); gl.readPixels(px,py,1,1,gl.RGBA,gl.UNSIGNED_BYTE,o);
      return o[0]>140 && o[0]>o[2]+50;
    })()`));
  const liveL = await liveProbe(-1), liveR = await liveProbe(1);
  t.check('Rendered-live: LEFT half red (not white): ' + JSON.stringify(liveL),
    liveL[0] > 140 && liveL[0] > liveL[2] + 50 && !(liveL[2] > 140));
  t.check('Rendered-live: RIGHT half blue (not white): ' + JSON.stringify(liveR),
    liveR[2] > 140 && liveR[2] > liveR[0] + 50 && !(liveR[0] > 140));

  // =============================================================================
  // (1b/2/3/4) tracer probes — computed off-thread into window.__R.
  // =============================================================================
  await t.evaluate(`window.__R=null; (async () => {
   try {
    const { ip, snap: snapMod, tracer, gpu: gpuMod, prim, Vec3 } = window.__M;
    const S = window.__app.scene;
    const sub=(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
    const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
    const norm=(a)=>{const l=Math.hypot(a[0],a[1],a[2])||1;return[a[0]/l,a[1]/l,a[2]/l];};
    const lookAt=(eye,target,fovY)=>{const f=norm(sub(target,eye));const up0=Math.abs(f[2])>0.98?[0,1,0]:[0,0,1];const r=norm(cross(f,up0));const u=norm(cross(r,f));return {position:eye,forward:f,right:r,up:u,fovY,aperture:0,focusDistance:Math.hypot(...sub(target,eye))};};
    const G=new gpuMod.GpuTracer();
    const W=48,H=48;
    function projPix(cam,wp){const d=sub(wp,cam.position);const zc=d[0]*cam.forward[0]+d[1]*cam.forward[1]+d[2]*cam.forward[2];const xc=d[0]*cam.right[0]+d[1]*cam.right[1]+d[2]*cam.right[2];const yc=d[0]*cam.up[0]+d[1]*cam.up[1]+d[2]*cam.up[2];const tanH=Math.tan(cam.fovY*0.5),aspect=W/H;const nx=(xc/zc)/(tanH*aspect),ny=(yc/zc)/tanH;return [Math.max(0,Math.min(W-1,Math.round((nx*0.5+0.5)*W))), Math.max(0,Math.min(H-1,Math.round((0.5-ny*0.5)*H)))];}
    function cpuShot(snap,spp){const sc=tracer.prepareScene(snap);const acc=new Float32Array(W*H*3);for(let i=0;i<spp;i++)tracer.renderSample(sc,acc,W,H,i,1);return (px,py)=>{const c=py*W+px;return [acc[c*3]/spp,acc[c*3+1]/spp,acc[c*3+2]/spp];};}
    function gpuShot(snap,spp){G.setSnapshot(snap);G.beginProgressive(W,H,1);while(G.accumulatedSamples<spp&&!G.contextLost)G.accumulate(8);const buf=G.readbackProgressive();return (px,py)=>{const c=py*W+px;return [buf[c*4],buf[c*4+1],buf[c*4+2]];};}
    const R={ gpuAvail:G.available };

    // --- helper: build a scene with a floor + an emit plane at (z, scale, strength)
    function buildTV(strength, opts={}) {
      if (S.editMode) S.exitEditMode();
      for (const o of [...S.objects]) S.remove(o.id);
      for (const m of [...S.materials]) S.removeMaterial(m.id);
      S.world.mode='flat'; S.world.color=[0,0,0]; S.world.strength=0;
      const fm=S.addMaterial('floor'); fm.shader='diffuse'; fm.baseColor=[0.8,0.8,0.8]; fm.roughness=1;
      S.add('Floor', prim.makePlane(12)).materialId=fm.id;
      const pl=ip.createImagePlane(S, window.__app.undo, { dataUrl: window.__M.url, name:'tv', w:200,h:200, mode:'emit' });
      const mat=S.getMaterial(pl.materialId);
      mat.emissiveStrength=strength;
      if (opts.gradient) { mat.texKind='none'; mat.texImage=undefined; mat.colorGradient={kind:'gradient',a:[1,0,0],b:[0,0,1],axis:'x',offset:0.5,scale:0.5}; }
      pl.transform = pl.transform.withPosition(new Vec3(0,0,3)).withScale(new Vec3(3,3,3));
      return pl;
    }
    async function ensureTex(){ for(let i=0;i<60 && !S.materials[1].texImage;i++) await new Promise(r=>setTimeout(r,20)); }

    // (1b) REGRESSION on the tracers: fresh emit plane facing the camera, strength 1.
    {
      if (S.editMode) S.exitEditMode();
      for (const o of [...S.objects]) S.remove(o.id);
      for (const m of [...S.materials]) S.removeMaterial(m.id);
      const pl=ip.createImagePlane(S, window.__app.undo, { dataUrl: window.__M.url, name:'tv', w:200,h:200, mode:'emit' });
      for(let i=0;i<60 && !S.getMaterial(pl.materialId).texImage;i++) await new Promise(r=>setTimeout(r,20));
      const snap=snapMod.buildSnapshot(S, window.__app.camera);
      snap.camera=lookAt([0,0,6],[0,0,0],0.7);
      // plane spans x∈[-1,1]; left point x=-0.6 (red), right x=0.6 (blue), z=0
      const lp=projPix(snap.camera,[-0.6,0,0]), rp=projPix(snap.camera,[0.6,0,0]);
      const cpu=cpuShot(snap,16), g=R.gpuAvail?gpuShot(snap,16):null;
      R.regCpuL=cpu(lp[0],lp[1]); R.regCpuR=cpu(rp[0],rp[1]);
      R.regGpuL=g?g(lp[0],lp[1]):null; R.regGpuR=g?g(rp[0],rp[1]):null;
    }

    // (2) TV test — strength 8, floor tinting.
    {
      buildTV(8); await ensureTex();
      const snap=snapMod.buildSnapshot(S, window.__app.camera);
      snap.camera=lookAt([0,-2,9],[0,0,0],0.7);
      const lp=projPix(snap.camera,[-2.2,0,0]), rp=projPix(snap.camera,[2.2,0,0]);
      const cpu=cpuShot(snap,64), g=R.gpuAvail?gpuShot(snap,64):null;
      R.tvCpuL=cpu(lp[0],lp[1]); R.tvCpuR=cpu(rp[0],rp[1]);
      R.tvGpuL=g?g(lp[0],lp[1]):null; R.tvGpuR=g?g(rp[0],rp[1]):null;
    }

    // (3) strength 1 → floor ~unlit (loose): probe the floor centre, compare to str8.
    {
      buildTV(1); await ensureTex();
      const snap=snapMod.buildSnapshot(S, window.__app.camera);
      snap.camera=lookAt([0,-2,9],[0,0,0],0.7);
      const cp=projPix(snap.camera,[-2.2,0,0]);
      const cpu=cpuShot(snap,64);
      R.dimFloor=cpu(cp[0],cp[1]);
    }

    // (4) gradient emit — camera hit shows the gradient (red left, blue right).
    {
      buildTV(1, {gradient:true});
      const snap=snapMod.buildSnapshot(S, window.__app.camera);
      snap.camera=lookAt([0,0,9],[0,0,3],0.7); // look straight at the plane
      // plane at z=3, scale 3 → spans x∈[-3,3]; left x=-1.8, right x=1.8, z=3.
      const lp=projPix(snap.camera,[-1.8,0,3]), rp=projPix(snap.camera,[1.8,0,3]);
      const cpu=cpuShot(snap,8), g=R.gpuAvail?gpuShot(snap,8):null;
      R.gradCpuL=cpu(lp[0],lp[1]); R.gradCpuR=cpu(rp[0],rp[1]);
      R.gradGpuL=g?g(lp[0],lp[1]):null; R.gradGpuR=g?g(rp[0],rp[1]):null;
    }
    window.__R=R;
   } catch(e){ window.__R={error:String(e&&e.stack||e)}; }
  })()`);
  t.check('tracer probes computed', await t.until('!!window.__R', 60000));
  const R = await t.evaluate('window.__R');
  if (R.error) { t.check('tracer probes ran without error: ' + R.error, false); return; }
  console.log('probes: ' + JSON.stringify(R));

  const redDom = (p) => p && p[0] > p[2] + 0.02 && p[0] > 0.05;
  const blueDom = (p) => p && p[2] > p[0] + 0.02 && p[2] > 0.05;

  // (1b) REGRESSION on tracers.
  t.check('F12-CPU: emit plane LEFT half red: ' + JSON.stringify(R.regCpuL), redDom(R.regCpuL));
  t.check('F12-CPU: emit plane RIGHT half blue: ' + JSON.stringify(R.regCpuR), blueDom(R.regCpuR));
  if (R.gpuAvail) {
    t.check('Raytraced-GPU: emit plane LEFT half red: ' + JSON.stringify(R.regGpuL), redDom(R.regGpuL));
    t.check('Raytraced-GPU: emit plane RIGHT half blue: ' + JSON.stringify(R.regGpuR), blueDom(R.regGpuR));
  }

  // (2) TV test — floor tinting.
  t.check('TV F12-CPU: floor LEFT red-dominant: ' + JSON.stringify(R.tvCpuL), redDom(R.tvCpuL));
  t.check('TV F12-CPU: floor RIGHT blue-dominant: ' + JSON.stringify(R.tvCpuR), blueDom(R.tvCpuR));
  if (R.gpuAvail) {
    t.check('TV GPU: floor LEFT red-dominant: ' + JSON.stringify(R.tvGpuL), redDom(R.tvGpuL));
    t.check('TV GPU: floor RIGHT blue-dominant: ' + JSON.stringify(R.tvGpuR), blueDom(R.tvGpuR));
  }

  // (3) strength 1 → room far dimmer than strength 8 (loose).
  const bright = (p) => Math.max(p[0], p[1], p[2]);
  t.check('strength 1 floor far dimmer than strength 8: dim=' + bright(R.dimFloor).toFixed(3) + ' tv=' + bright(R.tvCpuL).toFixed(3),
    bright(R.dimFloor) < bright(R.tvCpuL) * 0.4);

  // (4) gradient emit.
  t.check('gradient emit F12-CPU: LEFT red, RIGHT blue: L=' + JSON.stringify(R.gradCpuL) + ' R=' + JSON.stringify(R.gradCpuR),
    redDom(R.gradCpuL) && blueDom(R.gradCpuR));
  if (R.gpuAvail) {
    t.check('gradient emit GPU: LEFT red, RIGHT blue: L=' + JSON.stringify(R.gradGpuL) + ' R=' + JSON.stringify(R.gradGpuR),
      redDom(R.gradGpuL) && blueDom(R.gradGpuR));
  }

  // =============================================================================
  // (5) Screenshot the TV scene in the live Rendered viewport — a TV in a dark room.
  // =============================================================================
  await t.evaluate(`(async () => {
    const { ip, prim, Vec3 } = window.__M; const S = window.__app.scene;
    const { Quat } = await import('/src/core/math/quat.ts');
    if (S.editMode) S.exitEditMode();
    for (const o of [...S.objects]) S.remove(o.id);
    for (const m of [...S.materials]) S.removeMaterial(m.id);
    window.__app.undo.clear();
    S.world.mode='flat'; S.world.color=[0.01,0.01,0.02]; S.world.strength=1;
    const fm=S.addMaterial('floor'); fm.shader='diffuse'; fm.baseColor=[0.7,0.7,0.7]; fm.roughness=1;
    S.add('Floor', prim.makePlane(14)).materialId=fm.id;
    const pl=ip.createImagePlane(S, window.__app.undo, { dataUrl: window.__M.url, name:'tv', w:300,h:200, mode:'emit' });
    const mat=S.getMaterial(pl.materialId); mat.emissiveStrength=8;
    for(let i=0;i<60 && !mat.texImage;i++) await new Promise(r=>setTimeout(r,20));
    pl.transform = pl.transform.withPosition(new Vec3(0,0,2.4)).withScale(new Vec3(2,2,2)).withRotation(Quat.fromEulerXYZ(Math.PI/2,0,0));
    const cam=window.__app.camera; cam.yaw=0.35; cam.pitch=0.15; cam.distance=13; cam.target = new Vec3(0,0,1.5);
    window.__app.renderer.shadingMode='rendered';
    window.__app.shadePrefs.ao=false;
    S.deselectAll();
    window.__app.renderer.render(S, cam);
  })()`);
  await t.sleep(200);
  await t.evaluate(`window.__app.renderer.render(window.__app.scene, window.__app.camera)`);
  await t.screenshot('e2e/screenshots/ur16-4-tv-scene.png');
  t.check('TV scene screenshot saved', true);
});
