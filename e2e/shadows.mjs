/**
 * Sun shadow-map verification: default cube over a plane, angled sun, Rendered
 * mode. Paired frames (cube visible vs hidden); a floor point inside the
 * expected shadow must darken when the cube is visible, a control floor point
 * far from the shadow must not change.
 */
import { inflateSync } from 'node:zlib';
import { runE2e } from './harness.mjs';

function decodePng(buf) {
  let p = 8;
  let width = 0, height = 0, colorType = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); colorType = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const rgba = new Uint8Array(width * height * 4);
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  let rp = 0;
  const paeth = (a, b, c) => {
    const pp = a + b - c;
    const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    for (let x = 0; x < stride; x++) {
      const rb = raw[rp++];
      const left = x >= channels ? cur[x - channels] : 0;
      const up = prev[x];
      const ul = x >= channels ? prev[x - channels] : 0;
      cur[x] = filter === 0 ? rb
        : filter === 1 ? rb + left
        : filter === 2 ? rb + up
        : filter === 3 ? rb + ((left + up) >> 1)
        : rb + paeth(left, up, ul);
    }
    for (let x = 0; x < width; x++) {
      rgba[(y * width + x) * 4] = cur[x * channels];
      rgba[(y * width + x) * 4 + 1] = cur[x * channels + 1];
      rgba[(y * width + x) * 4 + 2] = cur[x * channels + 2];
      rgba[(y * width + x) * 4 + 3] = 255;
    }
    prev.set(cur);
  }
  return { width, height, rgba };
}

runE2e(async (t) => {
  await t.key('Escape', 'Escape', 0); // dismiss splash
  // Build the scene (Z-up world): keep the default cube, add a big floor plane
  // below it and a sun tilted 30° off straight-down (aim swings toward +Y).
  await t.evaluate(`(async () => {
    const S = window.__app.scene;
    const prim = await import('/src/core/mesh/primitives.ts');
    const V = (await import('/src/core/math/vec3.ts')).Vec3;
    const Q = (await import('/src/core/math/quat.ts')).Quat;
    const floor = S.add('Floor', prim.makePlane(30));
    floor.transform = floor.transform.withPosition(new V(0, 0, -1.01));
    const sun = S.addLight('Sun', 'sun');
    sun.light.power = 3;
    sun.transform = sun.transform
      .withPosition(new V(0, -4, 6))
      .withRotation(Q.fromEulerXYZ(Math.PI / 6, 0, 0));
    window.__app.renderer.shadingMode = 'rendered';
  })()`);
  await t.sleep(400);

  // Project two floor points to screen: one inside the cube's expected shadow
  // (cube center cast along the sun dir onto y=-1.01) and one control far away.
  const pts = await t.evaluate(`(() => {
    const app = window.__app;
    const vp = app.renderer.currentViewProj(app.scene, app.camera);
    const canvas = document.querySelector('canvas');
    const r = canvas.getBoundingClientRect();
    const proj = (x, y, z) => {
      const m = vp.m;
      const cx = m[0]*x + m[4]*y + m[8]*z + m[12];
      const cy = m[1]*x + m[5]*y + m[9]*z + m[13];
      const cw = m[3]*x + m[7]*y + m[11]*z + m[15];
      return { x: r.left + (cx/cw*0.5+0.5)*r.width, y: r.top + (0.5-cy/cw*0.5)*r.height };
    };
    // Sun dir after Rx(30°): (0, sin30, -cos30) = (0, 0.5, -0.866).
    // Cube center (0,0,0) hits the floor at y = 0.5*(1.01/0.866) ≈ 0.58.
    return { shadow: proj(0, 0.58, -1.01), control: proj(2.5, -1.5, -1.01) };
  })()`);

  const grab = async () => {
    const shot = await t.send('Page.captureScreenshot', { format: 'png' });
    const png = decodePng(Buffer.from(shot.data, 'base64'));
    const dpr = png.width / await t.evaluate('window.innerWidth');
    const lum = (pt) => {
      // 3×3 average around the point (device pixels).
      let sum = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const x = Math.round(pt.x * dpr) + dx, y = Math.round(pt.y * dpr) + dy;
        const i = (y * png.width + x) * 4;
        sum += 0.2126 * png.rgba[i] + 0.7152 * png.rgba[i + 1] + 0.0722 * png.rgba[i + 2];
        n++;
      }
      return sum / n;
    };
    return { shadow: lum(pts.shadow), control: lum(pts.control) };
  };

  const withCube = await grab();
  await t.evaluate(`(() => {
    const S = window.__app.scene;
    S.objects.find((o) => o.name === 'Cube').visible = false;
  })()`);
  await t.sleep(300);
  const noCube = await grab();

  t.check('SUN: floor point under the cube darkens when the cube casts',
    noCube.shadow - withCube.shadow > 20,
    `withCube=${withCube.shadow.toFixed(1)} noCube=${noCube.shadow.toFixed(1)}`);
  t.check('SUN: control floor point is unaffected by the cube',
    Math.abs(noCube.control - withCube.control) < 8,
    `withCube=${withCube.control.toFixed(1)} noCube=${noCube.control.toFixed(1)}`);
  t.check('SUN: shadowed floor is darker than lit floor in the same frame',
    withCube.control - withCube.shadow > 20,
    `shadow=${withCube.shadow.toFixed(1)} lit=${withCube.control.toFixed(1)}`);

  // ---- SPOT: swap the sun for a wide spot straight above the cube. --------
  // Straight-down cone (identity rotation aims -Z in the Z-up world) → the cast
  // shadow is exactly the cube footprint, so the same floor sample points
  // serve: `shadow` sits inside it, `control` outside but within the wide cone.
  await t.evaluate(`(async () => {
    const S = window.__app.scene;
    const V = (await import('/src/core/math/vec3.ts')).Vec3;
    S.objects.find((o) => o.name === 'Sun').visible = false;
    S.objects.find((o) => o.name === 'Cube').visible = true;
    const spot = S.addLight('Spot', 'spot');
    spot.light.power = 600;
    spot.light.spotAngle = 1.6; // ~92° cone: both sample points inside
    spot.transform = spot.transform.withPosition(new V(0, 0, 5));
  })()`);
  await t.sleep(300);
  const spotCube = await grab();
  await t.evaluate(`window.__app.scene.objects.find((o) => o.name === 'Cube').visible = false`);
  await t.sleep(300);
  const spotNoCube = await grab();

  t.check('SPOT: floor point under the cube darkens when the cube casts',
    spotNoCube.shadow - spotCube.shadow > 20,
    `withCube=${spotCube.shadow.toFixed(1)} noCube=${spotNoCube.shadow.toFixed(1)}`);
  t.check('SPOT: shadowed floor is darker than cone-lit floor in the same frame',
    spotCube.control - spotCube.shadow > 20,
    `shadow=${spotCube.shadow.toFixed(1)} lit=${spotCube.control.toFixed(1)}`);

  // ---- POINT: swap the spot for a bare point light above the cube. --------
  // Point lights shadow through cube maps; straight overhead the cast shadow is
  // again the cube footprint, and a point light illuminates the whole floor
  // (no cone), so both sample points stay valid.
  await t.evaluate(`(async () => {
    const S = window.__app.scene;
    const V = (await import('/src/core/math/vec3.ts')).Vec3;
    S.objects.find((o) => o.name === 'Spot').visible = false;
    S.objects.find((o) => o.name === 'Cube').visible = true;
    const point = S.addLight('Point', 'point');
    point.light.power = 700;
    point.transform = point.transform.withPosition(new V(0, 0, 5));
  })()`);
  await t.sleep(300);
  const pointCube = await grab();
  await t.evaluate(`window.__app.scene.objects.find((o) => o.name === 'Cube').visible = false`);
  await t.sleep(300);
  const pointNoCube = await grab();

  t.check('POINT: floor point under the cube darkens when the cube casts',
    pointNoCube.shadow - pointCube.shadow > 20,
    `withCube=${pointCube.shadow.toFixed(1)} noCube=${pointNoCube.shadow.toFixed(1)}`);
  t.check('POINT: shadowed floor is darker than lit floor in the same frame',
    pointCube.control - pointCube.shadow > 20,
    `shadow=${pointCube.shadow.toFixed(1)} lit=${pointCube.control.toFixed(1)}`);

  // ---- Locked-axis indicator plumbing: G then X mirrors onto the renderer. --
  await t.evaluate(`(() => {
    const S = window.__app.scene;
    const cube = S.objects.find((o) => o.name === 'Cube');
    cube.visible = true;
    S.selectOnly(cube.id);
  })()`);
  await t.sleep(100);
  t.check('no axis indicator while idle',
    (await t.evaluate('window.__app.renderer.axisIndicator')) === null);
  await t.key('g', 'KeyG', 0);
  await t.sleep(80);
  t.check('no axis indicator on unconstrained G',
    (await t.evaluate('window.__app.renderer.axisIndicator')) === null);
  await t.key('x', 'KeyX', 0);
  await t.sleep(80);
  const ind = await t.evaluate('window.__app.renderer.axisIndicator?.axis ?? null');
  t.check('G then X shows the X axis indicator', ind === 'x', `got ${ind}`);
  await t.key('y', 'KeyY', 0);
  await t.sleep(80);
  t.check('switching to Y updates the indicator',
    (await t.evaluate('window.__app.renderer.axisIndicator?.axis ?? null')) === 'y');
  await t.key('Escape', 'Escape', 0);
  await t.sleep(80);
  t.check('Esc clears the axis indicator',
    (await t.evaluate('window.__app.renderer.axisIndicator')) === null);
});
