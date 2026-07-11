/**
 * Viewport shading dropdown + options (header dropdown, AO, wireframe overlay,
 * hidden-line wireframe). Pixel checks read the GL canvas directly after a
 * forced render, so they measure the actual framebuffer.
 */
import { runE2e } from './harness.mjs';

runE2e(async (t) => {
  await t.key('Escape', 'Escape', 0); // dismiss splash

  // --- The dropdown lives in the viewport area header, right side. ---------
  t.check('shading button is inside the viewport area header',
    await t.evaluate(`(() => {
      const btn = document.querySelector('.shading-menu-btn');
      return !!btn && !!btn.closest('.wsp-area-header') && !!btn.closest('.wsp-area-header-extra');
    })()`));
  t.check('old topbar shading chip is gone',
    await t.evaluate(`!document.querySelector('.topbar-btn[data-action="shading-mode"]')`));

  // Open the menu: 4 mode rows + 3 option checkboxes.
  await t.evaluate(`document.querySelector('.shading-menu-btn').click()`);
  await t.sleep(80);
  t.check('menu shows 4 shading modes',
    (await t.evaluate(`document.querySelectorAll('.shading-menu-mode').length`)) === 4);
  t.check('menu shows AO / wireframe / intersections / hidden-line checkboxes',
    await t.evaluate(`(() => {
      const keys = [...document.querySelectorAll('[data-shade-pref]')].map((r) => r.dataset.shadePref);
      return keys.join(',') === 'ao,wireOverlay,intersections,hiddenLine';
    })()`));
  await t.key('Escape', 'Escape', 0);
  await t.sleep(60);
  t.check('Escape closes the menu',
    await t.evaluate(`!document.querySelector('.shading-menu-pop')`));

  // Z-cycle keeps the button label in sync.
  await t.key('z', 'KeyZ', 0);
  await t.sleep(80);
  t.check('Z cycle re-labels the header button',
    (await t.evaluate(`document.querySelector('.shading-menu-btn').textContent`)).includes('Wireframe'));
  await t.evaluate(`window.__app.renderer.shadingMode = 'matcap'`);

  // --- Scene for the pixel checks: cube resting ON a floor (crease at z=-1).
  await t.evaluate(`(async () => {
    const S = window.__app.scene;
    const prim = await import('/src/core/mesh/primitives.ts');
    const V = (await import('/src/core/math/vec3.ts')).Vec3;
    const floor = S.add('Floor', prim.makePlane(30));
    floor.transform = floor.transform.withPosition(new V(0, 0, -1.001));
    S.deselectAll(); // no gizmo/outline near the sampled pixels
  })()`);
  // t.evaluate does NOT await async IIFEs — the floor lands after the dynamic
  // imports resolve. Poll for it, or the first pixel probe races the setup
  // (flaked as off=58: the crease pixel read background before the floor hit).
  t.check('pixel-check scene: floor landed',
    await t.until(`window.__app.scene.objects.some((o) => o.name === 'Floor')`));
  await t.sleep(120);

  // Sample helper: force a render, read one pixel (GL coords, bottom-up).
  const pixelAt = (wx, wy, wz) => t.evaluate(`(() => {
    const app = window.__app, gl = app.renderer.ctx.gl, c = gl.canvas;
    app.renderer.render(app.scene, app.camera);
    const vp = app.renderer.currentViewProj(app.scene, app.camera);
    const m = vp.m;
    const cx = m[0]*${wx} + m[4]*${wy} + m[8]*${wz} + m[12];
    const cy = m[1]*${wx} + m[5]*${wy} + m[9]*${wz} + m[13];
    const cw = m[3]*${wx} + m[7]*${wy} + m[11]*${wz} + m[15];
    const px = Math.round((cx/cw*0.5+0.5) * c.width);
    const py = Math.round((cy/cw*0.5+0.5) * c.height);
    const out = new Uint8Array(4);
    gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return [out[0], out[1], out[2]];
  })()`);
  const lum = (p) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];

  // --- AO: the floor right at the cube's base darkens; open floor doesn't. --
  const setPref = (key, val) => t.evaluate(`window.__app.shadePrefs.${key} = ${val}`);
  // Everything through the diamond checks regression-tests the SCREEN (GTAO)
  // estimator specifically — pin the mode (the app default is 'object' since
  // 2026-07-09). The Object AO section further down sets its own mode.
  await t.evaluate(`window.__app.shadePrefs.aoMode = 'screen'`);
  // Contact crease: floor point hugging the cube's front (-Y) face — the
  // camera-visible side; open floor far away as the control.
  const creaseNoAo = lum(await pixelAt(0.2, -1.12, -1.0));
  const openNoAo = lum(await pixelAt(-2.5, -1.5, -1.0));
  await setPref('ao', true);
  await t.sleep(60);
  const creaseAo = lum(await pixelAt(0.2, -1.12, -1.0));
  const openAo = lum(await pixelAt(-2.5, -1.5, -1.0));
  await setPref('ao', false);
  t.check('AO darkens the cube-floor contact crease',
    creaseNoAo - creaseAo > 8,
    `off=${creaseNoAo.toFixed(1)} on=${creaseAo.toFixed(1)}`);
  t.check('AO leaves open floor nearly untouched',
    Math.abs(openNoAo - openAo) < 8,
    `off=${openNoAo.toFixed(1)} on=${openAo.toFixed(1)}`);

  // --- AO tuner: strength scales the darkening; sliders live in the menu. ---
  await setPref('ao', true);
  await setPref('aoStrength', 2);
  await t.sleep(60);
  const creaseStrong = lum(await pixelAt(0.2, -1.12, -1.0));
  await setPref('aoStrength', 0.15);
  await t.sleep(60);
  const creaseWeak = lum(await pixelAt(0.2, -1.12, -1.0));
  await setPref('aoStrength', 1);
  await setPref('ao', false);
  t.check('AO strength 2 darkens more than strength 1',
    creaseStrong < creaseAo - 5,
    `s1=${creaseAo.toFixed(1)} s2=${creaseStrong.toFixed(1)}`);
  t.check('AO strength 0.15 barely darkens',
    creaseWeak > creaseAo + 5,
    `s1=${creaseAo.toFixed(1)} s0.15=${creaseWeak.toFixed(1)}`);

  // Slider rows exist in the dropdown, indented under AO, and write the prefs.
  await t.evaluate(`document.querySelector('.shading-menu-btn').click()`);
  await t.sleep(80);
  t.check('AO radius + strength + samples sliders present in the menu',
    await t.evaluate(`(() => {
      const keys = [...document.querySelectorAll('[data-shade-slider]')].map((r) => r.dataset.shadeSlider);
      return keys.join(',') === 'aoRadius,aoStrength,aoSamples';
    })()`));
  t.check('sliders are greyed out while AO is off',
    await t.evaluate(`[...document.querySelectorAll('[data-shade-slider] input')].every((i) => i.disabled)`));
  const sliderWrites = await t.evaluate(`(() => {
    const aoBox = document.querySelector('[data-shade-pref="ao"] input');
    aoBox.click(); // enables AO → sliders wake up
    const r = document.querySelector('[data-shade-slider="aoRadius"] input');
    if (r.disabled) return 'still disabled';
    r.value = '1.5';
    r.dispatchEvent(new Event('input'));
    const got = window.__app.shadePrefs.aoRadius;
    aoBox.click(); // AO back off
    window.__app.shadePrefs.aoRadius = 0.55;
    return got;
  })()`);
  t.check('dragging the radius slider writes the pref', sliderWrites === 1.5, `got ${sliderWrites}`);
  await t.key('Escape', 'Escape', 0);
  await t.sleep(60);

  // --- Wireframe overlay: a cube top edge darkens in matcap mode. ----------
  // Sample the DARKEST pixel in a short vertical strip crossing the top-front
  // edge: the wire is 1px, and a single projected pixel rounds off the line
  // whenever the canvas geometry changes (it broke when the default Layout
  // docked a Timeline pane and shortened the viewport).
  const darkestAt = (wx, wy, wz) => t.evaluate(`(() => {
    const app = window.__app, gl = app.renderer.ctx.gl, c = gl.canvas;
    app.renderer.render(app.scene, app.camera);
    const vp = app.renderer.currentViewProj(app.scene, app.camera);
    const m = vp.m;
    const cx = m[0]*${wx} + m[4]*${wy} + m[8]*${wz} + m[12];
    const cy = m[1]*${wx} + m[5]*${wy} + m[9]*${wz} + m[13];
    const cw = m[3]*${wx} + m[7]*${wy} + m[11]*${wz} + m[15];
    const px = Math.round((cx/cw*0.5+0.5) * c.width);
    const py = Math.round((cy/cw*0.5+0.5) * c.height);
    const out = new Uint8Array(4);
    let best = 1e9, bestPx = [255,255,255];
    for (let dy = -3; dy <= 3; dy++) {
      gl.readPixels(px, py + dy, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
      const l = 0.2126*out[0] + 0.7152*out[1] + 0.0722*out[2];
      if (l < best) { best = l; bestPx = [out[0], out[1], out[2]]; }
    }
    return bestPx;
  })()`);
  const edgeNoWire = lum(await darkestAt(0.5, -0.999, 0.999));
  await setPref('wireOverlay', true);
  await t.sleep(60);
  const edgeWire = lum(await darkestAt(0.5, -0.999, 0.999));
  await setPref('wireOverlay', false);
  t.check('wireframe overlay darkens a cube edge in matcap mode',
    edgeNoWire - edgeWire > 40,
    `off=${edgeNoWire.toFixed(1)} on=${edgeWire.toFixed(1)}`);

  // --- Hidden line: back edges disappear in wireframe mode. ----------------
  // Single-pixel probes are dark-on-dark ambiguous here (a wire and the
  // background+gridline blend to similar luminance), so count DARK WIRE
  // PIXELS across the cube's screen bbox instead: from the default view 3 of
  // the cube's 12 edges are fully occluded, so hidden-line must remove a
  // measurable slice of wire pixels while keeping most of them.
  await t.evaluate(`window.__app.renderer.shadingMode = 'wireframe'`);
  await t.sleep(60);
  const countWirePixels = () => t.evaluate(`(() => {
    const app = window.__app, gl = app.renderer.ctx.gl, c = gl.canvas;
    app.renderer.render(app.scene, app.camera);
    const vp = app.renderer.currentViewProj(app.scene, app.camera).m;
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (let i = 0; i < 8; i++) {
      const x = i & 1 ? 1 : -1, y = i & 2 ? 1 : -1, z = i & 4 ? 1 : -1;
      const cx = vp[0]*x + vp[4]*y + vp[8]*z + vp[12];
      const cy = vp[1]*x + vp[5]*y + vp[9]*z + vp[13];
      const cw = vp[3]*x + vp[7]*y + vp[11]*z + vp[15];
      const px = (cx/cw*0.5+0.5) * c.width, py = (cy/cw*0.5+0.5) * c.height;
      x0 = Math.min(x0, px); x1 = Math.max(x1, px);
      y0 = Math.min(y0, py); y1 = Math.max(y1, py);
    }
    const w = Math.round(x1 - x0), h = Math.round(y1 - y0);
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(Math.round(x0), Math.round(y0), w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let dark = 0;
    for (let i = 0; i < w * h; i++) {
      const l = 0.2126*buf[i*4] + 0.7152*buf[i*4+1] + 0.0722*buf[i*4+2];
      if (l < 20) dark++;
    }
    return dark;
  })()`);
  const classicWires = await countWirePixels();
  await setPref('hiddenLine.wireframe', true);
  const hiddenWires = await countWirePixels();
  await setPref('hiddenLine.wireframe', false);
  t.check('classic wireframe draws a full wire set', classicWires > 200, `pixels=${classicWires}`);
  // Absolute-drop threshold, not a ratio: UR6-1's proximity-thickened AA ribbons
  // make each edge many px wide, so the 3 occluded edges are a smaller FRACTION
  // of the (now much fatter) total than they were for 1px lines — but they are
  // still measurably removed. Require a clear pixel drop and most wires kept.
  t.check('hidden-line removes the occluded edges',
    hiddenWires < classicWires - 20,
    `classic=${classicWires} hidden=${hiddenWires}`);
  t.check('hidden-line keeps the visible edges',
    hiddenWires > classicWires * 0.5,
    `classic=${classicWires} hidden=${hiddenWires}`);

  await t.evaluate(`window.__app.renderer.shadingMode = 'matcap'`);

  // ===================================================================
  // Rebuilt-SSAO quality regressions. The v1 pass passed the crease/strength
  // numbers above yet still looked bad — a dark, moire-banded floor and stripey
  // cube faces. These checks pin the LOOK: flat surfaces stay clean, and AO
  // reads on real contact/self-occlusion, not on noise.
  // ===================================================================

  // Region stats: force a render, read a size×size device-pixel block centered
  // on a projected world point, return mean + population stddev of per-pixel
  // luminance (bottom-up GL block, clamped to the canvas).
  const regionStats = (wx, wy, wz, size) => t.evaluate(`(() => {
    const app = window.__app, gl = app.renderer.ctx.gl, c = gl.canvas;
    app.renderer.render(app.scene, app.camera);
    const m = app.renderer.currentViewProj(app.scene, app.camera).m;
    const cw = m[3]*${wx} + m[7]*${wy} + m[11]*${wz} + m[15];
    const cx = m[0]*${wx} + m[4]*${wy} + m[8]*${wz} + m[12];
    const cy = m[1]*${wx} + m[5]*${wy} + m[9]*${wz} + m[13];
    const px = Math.round((cx/cw*0.5+0.5) * c.width);
    const py = Math.round((cy/cw*0.5+0.5) * c.height);
    const s = ${size};
    const x0 = Math.max(0, Math.min(px - (s>>1), c.width - s));
    const y0 = Math.max(0, Math.min(py - (s>>1), c.height - s));
    const buf = new Uint8Array(s*s*4);
    gl.readPixels(x0, y0, s, s, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let sum = 0, sum2 = 0;
    for (let i = 0; i < s*s; i++) {
      const l = 0.2126*buf[i*4] + 0.7152*buf[i*4+1] + 0.0722*buf[i*4+2];
      sum += l; sum2 += l*l;
    }
    const n = s*s, mean = sum/n;
    return { mean, std: Math.sqrt(Math.max(0, sum2/n - mean*mean)) };
  })()`);

  // (a) Flat-floor cleanliness — the anti-banding regression. A 100×100 block of
  // OPEN floor must keep BOTH its mean luminance and its per-pixel stddev when AO
  // turns on (v1 dropped the mean hard and injected structured moire noise).
  await setPref('aoRadius', 0.55);
  await setPref('aoStrength', 1);
  await setPref('ao', false);
  await t.sleep(40);
  const floorOff = await regionStats(-4, 2, -1, 100);
  await setPref('ao', true);
  await t.sleep(40);
  const floorOn = await regionStats(-4, 2, -1, 100);
  await setPref('ao', false);
  t.check('AO keeps open-floor mean luminance stable (no dark band)',
    Math.abs(floorOn.mean - floorOff.mean) < 6,
    `off=${floorOff.mean.toFixed(1)} on=${floorOn.mean.toFixed(1)}`);
  t.check('AO keeps open-floor texture stable (no structured noise)',
    Math.abs(floorOn.std - floorOff.std) < 3,
    `off=${floorOff.std.toFixed(2)} on=${floorOn.std.toFixed(2)}`);

  // (b) Object-to-object contact. A small block set against the cube's +X wall
  // makes an exposed concave seam; the wall pixels just above the block's top
  // must darken with AO on, while the same wall high up (away from contact) is
  // left alone.
  await t.evaluate(`(async () => {
    const S = window.__app.scene;
    const prim = await import('/src/core/mesh/primitives.ts');
    const V = (await import('/src/core/math/vec3.ts')).Vec3;
    const b = S.add('Block', prim.makeCube(0.5));
    b.transform = b.transform.withPosition(new V(1.5, 0, -0.5)); // x[1,2] y[-.5,.5] z[-1,0]
    S.deselectAll();
  })()`);
  await t.sleep(120);
  const seamOff = lum(await pixelAt(0.999, 0.0, 0.1)); // cube +X wall just above block top
  const wallOff = lum(await pixelAt(0.999, 0.0, 0.8)); // same wall, away from contact
  await setPref('ao', true);
  await t.sleep(40);
  const seamOn = lum(await pixelAt(0.999, 0.0, 0.1));
  const wallOn = lum(await pixelAt(0.999, 0.0, 0.8));
  await setPref('ao', false);
  t.check('AO darkens the cube-to-cube contact seam',
    seamOff - seamOn > 8, `off=${seamOff.toFixed(1)} on=${seamOn.toFixed(1)}`);
  t.check('AO barely touches the wall away from the contact',
    Math.abs(wallOff - wallOn) < 8, `off=${wallOff.toFixed(1)} on=${wallOn.toFixed(1)}`);

  // (c) Self-occlusion. A torus (lies flat in XY, Z-up) placed on its own: the
  // inner-hole rim must come out darker than the outer top ridge with AO on —
  // the ring occludes itself across the hole.
  await t.evaluate(`(async () => {
    const S = window.__app.scene;
    const prim = await import('/src/core/mesh/primitives.ts');
    const V = (await import('/src/core/math/vec3.ts')).Vec3;
    const tr = S.add('Torus', prim.makeTorus(1, 0.35, 48, 16));
    tr.transform = tr.transform.withPosition(new V(-4, 0, 0.5));
    S.deselectAll();
  })()`);
  await t.sleep(120);
  await setPref('aoRadius', 1.6);
  await setPref('aoStrength', 2);
  await setPref('ao', true);
  await t.sleep(40);
  // u=0 cross-section (torus +X extent): inner-upper rim r≈0.75 vs outer-upper ridge r≈1.25, both z≈0.25.
  const innerAo = lum(await pixelAt(-4 + 0.753, 0, 0.5 + 0.247));
  const outerAo = lum(await pixelAt(-4 + 1.247, 0, 0.5 + 0.247));
  await setPref('ao', false);
  await setPref('aoRadius', 0.55);
  await setPref('aoStrength', 1);
  t.check('AO makes the torus inner hole darker than the outer top (self-occlusion)',
    innerAo < outerAo - 5, `inner=${innerAo.toFixed(1)} outer=${outerAo.toFixed(1)}`);

  // ===================================================================
  // (d) BANDING DETECTOR — the metric v2 fails and GTAO must pass.
  //
  // v2's checks above all read discrete points and passed, yet the floor still
  // showed dark gradient WAVES: too few discrete AO levels (k/16) stepping a
  // smooth ramp. This detector samples the cube's contact-shadow gradient as a
  // ramp of world points receding from the cube base, isolates the AO DARKENING
  // (lum_off - lum_on, which cancels the static grid/matcap so ONLY the AO field
  // is measured), and asserts the ramp is SMOOTH: a banded ramp collapses onto a
  // few luminance levels with long plateaus (runs); a continuous / dithered ramp
  // spreads over many closely-spaced levels with short runs.
  //
  // Force the AO output target to R8 so the detector exercises the 8-bit + IGN
  // dither path that ships as the Vega fallback — the worst case for banding
  // (R16F, used on real Vega, is strictly smoother).
  // ===================================================================
  await t.evaluate(`window.__app.renderer.aoPass.overrideFormatForTest && window.__app.renderer.aoPass.overrideFormatForTest('r8')`);
  // Read a 48-sample strip along a SCREEN-SPACE line over the floor contact
  // gradient (distinct pixels guaranteed), returning per-sample luminance. World
  // endpoints: cube front base (strong AO) → ~1.5u out (AO faded). Clear of the
  // block (x=1.5) and torus (x=-4).
  const rampLum = () => t.evaluate(`(() => {
    const app = window.__app, gl = app.renderer.ctx.gl, c = gl.canvas;
    app.renderer.render(app.scene, app.camera);
    const m = app.renderer.currentViewProj(app.scene, app.camera).m;
    const proj = (wx, wy, wz) => {
      const cw = m[3]*wx + m[7]*wy + m[11]*wz + m[15];
      const cx = m[0]*wx + m[4]*wy + m[8]*wz + m[12];
      const cy = m[1]*wx + m[5]*wy + m[9]*wz + m[13];
      return [(cx/cw*0.5+0.5)*c.width, (cy/cw*0.5+0.5)*c.height];
    };
    const a = proj(-0.5, -1.04, -1.0), b = proj(-0.5, -4.2, -1.0);
    const N = 90, arr = [], px = new Uint8Array(4);
    for (let i = 0; i < N; i++) {
      const f = i / (N - 1);
      const x = Math.round(a[0] + (b[0]-a[0])*f), y = Math.round(a[1] + (b[1]-a[1])*f);
      gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      arr.push(0.2126*px[0] + 0.7152*px[1] + 0.0722*px[2]);
    }
    return arr;
  })()`);
  await setPref('aoRadius', 2.0);
  await setPref('aoStrength', 2.0);
  await setPref('ao', false);
  await t.sleep(40);
  const rampOff = await rampLum();
  await setPref('ao', true);
  await t.sleep(40);
  const rampOn = await rampLum();
  await setPref('ao', false);
  await setPref('aoRadius', 0.55);
  await setPref('aoStrength', 1);
  // AO darkening per sample (>=0), quantized to integer luminance. Measure ONLY
  // the samples with meaningful darkening (>1): the flat no-AO regions (correct
  // for any algorithm) are excluded so the metric captures the ACTIVE gradient,
  // where banding lives. A broad radius makes this gradient shallow and long, so
  // a STEPPED field parks many adjacent pixels on one quantized level (long runs,
  // few distinct); a CONTINUOUS + dithered field spreads over many levels with
  // short runs.
  const darkFull = rampOff.map((o, i) => Math.round(Math.max(0, o - rampOn[i])));
  const dark = darkFull.filter((d) => d > 1);
  const distinct = new Set(dark).size;
  let maxRun = 1, run = 1;
  for (let i = 1; i < darkFull.length; i++) {
    if (darkFull[i] > 1 && darkFull[i] === darkFull[i - 1]) { run++; if (run > maxRun) maxRun = run; } else run = 1;
  }
  console.log(`      [banding] active=${dark.length}/${darkFull.length} distinct=${distinct} maxRun=${maxRun}`);
  console.log(`      [banding] darkFull=[${darkFull.join(',')}]`);
  // A smooth active ramp hits a distinct darkening level at almost every active
  // sample and never plateaus on one value for long. v2 (17 raw AO levels,
  // un-dithered, blur dead on the grazing floor) collapses MANY active samples
  // onto a few long plateaus — a low distinct/active ratio. Ratio-based so the
  // check survives look retunes that change how far the ramp reaches (the
  // 2026-07-08 half-res rebuild shortened the active ramp; smoothness is what
  // this check pins, not reach).
  t.check('banding detector: contact ramp spreads over many distinct AO levels',
    dark.length >= 8 && distinct >= Math.max(8, Math.floor(dark.length * 0.8)),
    `distinct=${distinct} (of ${dark.length} active samples)`);
  t.check('banding detector: contact ramp has no long same-value plateaus (bands)',
    maxRun <= 6, `maxRun=${maxRun}`);

  // ===================================================================
  // (e) GRAZING-ANGLE FLAT-FLOOR REGRESSION — the hole in the net.
  //
  // Every check above uses the DEFAULT steep camera. The v3 GTAO passed all of
  // them yet showed heavy FALSE self-occlusion at GRAZING view angles: viewed
  // shallowly, the horizon march reads the floor's OWN plane through quantized
  // depth and raises false horizons across the WHOLE floor — a fine stipple on
  // SwiftShader here, the regular parallel STRIPES the user saw on his Vega 7.
  // A flat floor away from any occluder must read AO ~ 1 everywhere, at EVERY
  // angle. The cure (aoPass ray-relative coplanarity gate) makes the darkening
  // field collapse to ~0 on open floor; before it, meanD/p95/row-oscillation
  // all sit well above these thresholds. Contact shadows (checked above) stay.
  //
  // Drop the Block/Torus so the floor is open, lower the camera to grazing
  // pitches, and read a large OPEN-floor screen block with AO off then on. The
  // darkening field (off - on) cancels the static grid/matcap, isolating AO.
  // ===================================================================
  await t.evaluate(`(() => {
    const S = window.__app.scene;
    for (const o of [...S.objects]) if (o.name === 'Block' || o.name === 'Torus') S.remove(o.id);
    S.deselectAll();
  })()`);
  // Read a fixed canvas-relative screen block (bottom-up GL rect), return the
  // per-pixel luminance grid + dims. Fractions, so it is resolution-independent.
  const floorRect = (fx, fy, fw, fh) => t.evaluate(`(() => {
    const app = window.__app, gl = app.renderer.ctx.gl, c = gl.canvas;
    app.renderer.render(app.scene, app.camera);
    const x0 = Math.round(${fx} * c.width), y0 = Math.round(${fy} * c.height);
    const W = Math.round(${fw} * c.width), H = Math.round(${fh} * c.height);
    const buf = new Uint8Array(W * H * 4);
    gl.readPixels(x0, y0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const out = [];
    for (let i = 0; i < W * H; i++) out.push(0.2126*buf[i*4] + 0.7152*buf[i*4+1] + 0.0722*buf[i*4+2]);
    return { out, W, H };
  })()`);
  const setCam = (pitch) => t.evaluate(`(() => {
    const cam = window.__app.camera; cam.pitch = ${pitch}; cam.distance = 12; return cam.pitch;
  })()`);
  // Mean absolute successive difference of per-row means AFTER removing the
  // linear trend — a flat AO field gives ~0; iso-depth stripes make it spike.
  const rowOscillation = (D, W, H) => {
    const rm = [];
    for (let y = 0; y < H; y++) { let s = 0; for (let x = 0; x < W; x++) s += D[y*W + x]; rm.push(s / W); }
    const n = rm.length, mx = (n - 1) / 2, my = rm.reduce((a, b) => a + b, 0) / n;
    let sxy = 0, sxx = 0;
    for (let i = 0; i < n; i++) { sxy += (i - mx) * (rm[i] - my); sxx += (i - mx) ** 2; }
    const slope = sxy / sxx;
    const res = rm.map((v, i) => v - (my + slope * (i - mx)));
    let d = 0; for (let i = 1; i < n; i++) d += Math.abs(res[i] - res[i - 1]);
    return d / (n - 1);
  };
  await setPref('aoRadius', 0.9);
  await setPref('aoStrength', 1.6);
  // Two open-floor blocks (bottom-left, bottom-right foreground) at each grazing
  // pitch. Foreground floor, clear of the centered cube.
  for (const [pitch, fx] of [[0.45, 0.03], [0.45, 0.74], [0.25, 0.03], [0.25, 0.74]]) {
    await setCam(pitch);
    await setPref('ao', false);
    await t.sleep(40);
    const off = await floorRect(fx, 0.05, 0.22, 0.30);
    await setPref('ao', true);
    await t.sleep(40);
    const on = await floorRect(fx, 0.05, 0.22, 0.30);
    await setPref('ao', false);
    const offMean = off.out.reduce((a, b) => a + b, 0) / off.out.length;
    const D = off.out.map((v, i) => v - on.out[i]);
    const meanD = D.reduce((a, b) => a + b, 0) / D.length;
    const p95 = [...D.map(Math.abs)].sort((a, b) => a - b)[Math.floor(0.95 * D.length)];
    const osc = rowOscillation(D, off.W, off.H);
    const side = fx < 0.5 ? 'L' : 'R';
    console.log(`      [grazing] pitch=${pitch} ${side} offMean=${offMean.toFixed(0)} meanD=${meanD.toFixed(2)} p95=${p95.toFixed(1)} rowOsc=${osc.toFixed(3)}`);
    // Sanity: the block really is lit floor (not background/cube), so the
    // darkening field is meaningful.
    t.check(`grazing pitch=${pitch} ${side}: sampled block is open floor`,
      offMean > 100, `offMean=${offMean.toFixed(0)}`);
    // Whole-floor darkening guard: a flat floor must keep its brightness.
    t.check(`grazing pitch=${pitch} ${side}: AO leaves open floor mean unchanged`,
      meanD < 3.5, `meanD=${meanD.toFixed(2)}`);
    // The hard fail-before/pass-after check: v3 spiked to p95 ~5-7 here; the
    // coplanarity gate drops it to ~0.
    t.check(`grazing pitch=${pitch} ${side}: no false-occlusion spikes (p95 tiny)`,
      p95 < 3.0, `p95=${p95.toFixed(1)}`);
    // Horizontal-stripe detector: v3 failed this (rowOsc ~0.05-0.08 from the
    // iso-depth stipple); a clean floor is flat (rowOsc ~0).
    t.check(`grazing pitch=${pitch} ${side}: no horizontal stripes (row oscillation flat)`,
      osc < 0.03, `rowOsc=${osc.toFixed(3)}`);
  }
  await setPref('aoRadius', 0.55);
  await setPref('aoStrength', 1);

  await t.evaluate(`window.__app.renderer.shadingMode = 'matcap'`);

  // ===================================================================
  // (f) FAR-CORNER DIAMOND REGRESSION — screen-space blind spot.
  //
  // A cube's ambient shadow must ring ALL four base edges (a diamond), not
  // just the camera-facing ones (a boomerang). Two historical failure modes:
  // the Jimenez slice arc unnormalized at grazing gamma (open-slice arc grows
  // to pi/2, burying occlusion before the clamp), and back-facing walls simply
  // absent from the depth buffer (fixed by the radius-deep slab thickness in
  // horizonTap). Probe the crease just outside the near AND far corners at a
  // low pitch; both must darken with AO on.
  // ===================================================================
  await t.evaluate(`(async () => {
    const S = window.__app.scene;
    const prim = await import('/src/core/mesh/primitives.ts');
    S.add('Diamond', prim.makeCube(1));
    S.deselectAll();
  })()`);
  t.check('diamond scene: cube landed',
    await t.until(`window.__app.scene.objects.some((o) => o.name === 'Diamond')`));
  await t.evaluate(`(() => {
    const cam = window.__app.camera;
    cam.pitch = 0.22; cam.distance = 9; return cam.pitch;
  })()`);
  await setPref('aoRadius', 1.2);
  await setPref('aoStrength', 1);
  await t.sleep(60);
  // camera sits in the (+x, -y) quadrant (yaw pi/4): near corner (+1,-1),
  // far corner (-1,+1); cube spans +-1 with its base on the z=-1.001 floor.
  // Far probe sits DIAGONALLY outside the far-right corner — the floor beyond
  // the corner itself is hidden behind the cube at this pitch.
  const offNear = lum(await pixelAt(1.12, -1.12, -1.0));
  const offFar = lum(await pixelAt(1.18, 1.18, -1.0));
  await setPref('ao', true);
  await t.sleep(60);
  const onNear = lum(await pixelAt(1.12, -1.12, -1.0));
  const onFar = lum(await pixelAt(1.18, 1.18, -1.0));
  await setPref('ao', false);
  t.check('grazing diamond: near-corner crease darkens',
    offNear - onNear > 8, `off=${offNear.toFixed(1)} on=${onNear.toFixed(1)}`);
  t.check('grazing diamond: FAR-corner crease darkens',
    offFar - onFar > 8, `off=${offFar.toFixed(1)} on=${onFar.toFixed(1)}`);

  // ===================================================================
  // OBJECT AO — the world-space per-object voxel-SDF march (aoMode='object').
  // Camera-independent by construction, unlike the screen-space GTAO above.
  // Adapted from the verified /tmp .../scratchpad/objao-smoke.mjs: fixed
  // framing (yaw 0.785, pitch 0.9), world-space crease/open probes, SUM-of-RGB
  // reads. Appended after the GTAO checks; restores the camera pose, shadePrefs
  // (ao/aoMode/aoMethod/aoRadius/aoStrength) and shading mode at the end.
  // ===================================================================
  const sumRGB = (p) => p[0] + p[1] + p[2];

  // Clean single-cube-on-floor rig: drop the (f) Diamond cube so only the
  // default cube + Floor remain (the smoke's rig). Deselect so no gizmo/outline
  // sits under the probes.
  await t.evaluate(`(() => {
    const S = window.__app.scene;
    for (const o of [...S.objects]) if (o.name === 'Diamond') S.remove(o.id);
    S.deselectAll();
  })()`);
  // Fixed framing helper: default yaw / raised pitch / default distance. The
  // suite left the camera at pitch 0.22 & distance 9, so reset all three.
  const objFrame = (yaw) => t.evaluate(`(() => {
    const cam = window.__app.camera; cam.yaw = ${yaw}; cam.pitch = 0.9; cam.distance = 8;
  })()`);
  await objFrame(0.785);
  await t.sleep(60);

  const OBJ_CREASE = [1.08, 0, -0.98]; // floor hugging the cube's +x face (in view)
  const OBJ_OPEN = [3.5, 0, -0.98];    // open floor, far from the cube — the control

  // (1) Baseline (ao off) vs Object AO at the fixed framing.
  await setPref('ao', false);
  await t.sleep(40);
  const objCreaseOff = sumRGB(await pixelAt(...OBJ_CREASE));
  const objOpenOff = sumRGB(await pixelAt(...OBJ_OPEN));
  await t.evaluate(`(() => {
    const p = window.__app.shadePrefs;
    p.ao = true; p.aoMode = 'object'; p.aoMethod = 0; p.aoRadius = 1.2; p.aoStrength = 0.9;
  })()`);
  await t.sleep(60);
  const objCreaseOn = sumRGB(await pixelAt(...OBJ_CREASE));
  const objOpenOn = sumRGB(await pixelAt(...OBJ_OPEN));
  const objGlErr = await t.evaluate(`window.__app.renderer.ctx.gl.getError()`);
  t.check('Object AO: probes are on-screen lit floor',
    objCreaseOff > 100 && objOpenOff > 100, `crease=${objCreaseOff} open=${objOpenOff}`);
  t.check('Object AO: no GL error', objGlErr === 0, `err=${objGlErr}`);
  t.check('Object AO darkens the contact crease (sum RGB)',
    objCreaseOn < objCreaseOff - 12, `off=${objCreaseOff} on=${objCreaseOn}`);
  t.check('Object AO leaves open floor nearly untouched',
    Math.abs(objOpenOn - objOpenOff) < 20, `off=${objOpenOff} on=${objOpenOn}`);

  // (2) Camera-independence — the mode's selling point. Same WORLD-SPACE crease
  // point read at three yaws; the readings must barely move.
  const yawReadings = [];
  for (const yaw of [0.5, 1.1, 1.7]) {
    await objFrame(yaw);
    await t.sleep(40);
    yawReadings.push(sumRGB(await pixelAt(...OBJ_CREASE)));
  }
  const yawSpread = Math.max(...yawReadings) - Math.min(...yawReadings);
  t.check('Object AO crease is stable across yaws (camera-independent)',
    yawSpread < 40, `readings=[${yawReadings.join(',')}] spread=${yawSpread}`);

  // (3) All three estimator methods (0..2 — Baseline/Hemisphere/Exp-weighted;
  // menu trimmed + gain-calibrated 2026-07-09) at the fixed framing: no GL
  // error and each still occludes the crease below the ao-off baseline.
  await objFrame(0.785);
  await t.sleep(40);
  const methodCrease = [];
  for (let m = 0; m < 3; m++) {
    await t.evaluate(`window.__app.shadePrefs.aoMethod = ${m}`);
    await t.sleep(40);
    const v = sumRGB(await pixelAt(...OBJ_CREASE));
    methodCrease.push(v);
    const err = await t.evaluate(`window.__app.renderer.ctx.gl.getError()`);
    t.check(`Object AO method ${m}: clean render + occludes crease`,
      err === 0 && v < objCreaseOff - 8, `crease=${v} baseline=${objCreaseOff} err=${err}`);
  }
  // Gain calibration pin: the three methods AND Screen (GTAO) anchor the
  // contact crease at the same darkness for identical slider settings.
  await t.evaluate(`window.__app.shadePrefs.aoMode = 'screen'`);
  await t.sleep(40);
  methodCrease.push(sumRGB(await pixelAt(...OBJ_CREASE)));
  await t.evaluate(`window.__app.shadePrefs.aoMode = 'object'`);
  {
    const spread = Math.max(...methodCrease) - Math.min(...methodCrease);
    t.check('Object AO methods + GTAO agree at the crease (calibrated gains)',
      spread < 30, `crease=[${methodCrease.join(',')}] spread=${spread}`);
  }

  // (4) UI — parallel worker's contract: Mode + Method selects in the shading
  // menu; the Method row hides for 'screen' and shows for 'object'. Reset aoMode
  // to 'screen' first so the menu opens with the Method row hidden.
  await t.evaluate(`(() => { const p = window.__app.shadePrefs; p.aoMode = 'screen'; p.aoMethod = 0; })()`);
  await t.evaluate(`document.querySelector('.shading-menu-btn').click()`);
  await t.sleep(80);
  // UR9-1: AO controls now live under a collapsible section — expand it so the
  // Method row's own display:none (vs section-collapsed) is what's measured.
  await t.evaluate(`(() => {
    const b = document.querySelector('.shading-section[data-section="ao"] .shading-section-body');
    if (b && getComputedStyle(b).display === 'none') document.querySelector('.shading-section[data-section="ao"] .shading-disc').click();
  })()`);
  await t.sleep(40);
  const ui = await t.evaluate(`(() => {
    const modeSel = document.querySelector('select[data-shade-mode]');
    const methodSel = document.querySelector('select[data-shade-method]');
    if (!modeSel || !methodSel) return { present: false, hasMode: !!modeSel, hasMethod: !!methodSel };
    const methodRow = methodSel.closest('.shading-menu-select-row') || methodSel.parentElement;
    const hidden = (el) => getComputedStyle(el).display === 'none' || el.offsetParent === null;
    modeSel.value = 'screen'; modeSel.dispatchEvent(new Event('change'));
    const hiddenWhenScreen = hidden(methodRow);
    const aoModeScreen = window.__app.shadePrefs.aoMode;
    modeSel.value = 'object'; modeSel.dispatchEvent(new Event('change'));
    const visibleWhenObject = !hidden(methodRow);
    const aoModeObject = window.__app.shadePrefs.aoMode;
    return {
      present: true,
      modeOptions: [...modeSel.options].map((o) => o.value).join(','),
      methodCount: methodSel.options.length,
      hiddenWhenScreen, visibleWhenObject, aoModeScreen, aoModeObject,
    };
  })()`);
  t.check('UI: Mode + Method selects exist in the shading menu',
    ui.present, `hasMode=${ui.hasMode} hasMethod=${ui.hasMethod}`);
  if (ui.present) {
    t.check('UI: Mode select offers screen + object', ui.modeOptions === 'screen,object', `got ${ui.modeOptions}`);
    t.check('UI: Method select has 3 options', ui.methodCount === 3, `got ${ui.methodCount}`);
    t.check('UI: Method row hidden when aoMode = screen', ui.hiddenWhenScreen);
    t.check('UI: Method row visible after switching Mode to object', ui.visibleWhenObject);
    t.check('UI: shadePrefs.aoMode tracks the Mode select',
      ui.aoModeScreen === 'screen' && ui.aoModeObject === 'object',
      `screen->${ui.aoModeScreen} object->${ui.aoModeObject}`);
  }

  // (5) Persistence — driving the selects (object, method 4) fires their change
  // handlers which saveShadePrefs() to localStorage 'vibe-shading-v5' (UR9-1
  // bumped the storage key from v4).
  const persisted = await t.evaluate(`(() => {
    const modeSel = document.querySelector('select[data-shade-mode]');
    const methodSel = document.querySelector('select[data-shade-method]');
    if (modeSel && methodSel) {
      modeSel.value = 'object'; modeSel.dispatchEvent(new Event('change'));
      methodSel.value = '2'; methodSel.dispatchEvent(new Event('change'));
    }
    return localStorage.getItem('vibe-shading-v5') || '';
  })()`);
  t.check('Object AO persists aoMode=object to localStorage (vibe-shading-v5)',
    persisted.includes('"aoMode":"object"'), `stored=${persisted.slice(0, 90)}`);

  // Restore global state: close menu, revert selects to screen (re-persists),
  // reset prefs + camera + shading so nothing downstream inherits object mode.
  await t.evaluate(`(() => {
    const modeSel = document.querySelector('select[data-shade-mode]');
    if (modeSel) { modeSel.value = 'screen'; modeSel.dispatchEvent(new Event('change')); }
  })()`);
  await t.key('Escape', 'Escape', 0);
  await t.evaluate(`(() => {
    const p = window.__app.shadePrefs;
    p.ao = false; p.aoMode = 'object'; p.aoMethod = 0; p.aoRadius = 0.3; p.aoStrength = 1;
    window.__app.renderer.shadingMode = 'matcap';
  })()`);

  // ===================================================================
  // INTERSECTIONS — light grey lines where two meshes pass through each other.
  // A plane scaled 3x cuts horizontally through the default cube at z=0.3; the
  // cross-section is the 2x2 square at that height, so on a visible cube SIDE
  // face the intersection curve draws as a lighter grey line (~rgb 158,158,168).
  // Works in EVERY shading mode (matcap..rendered AND wireframe).
  // ===================================================================
  await t.evaluate(`(async () => {
    const S = window.__app.scene;
    const prim = await import('/src/core/mesh/primitives.ts');
    const V = (await import('/src/core/math/vec3.ts')).Vec3;
    const pl = S.add('CutPlane', prim.makePlane(3));           // spans +-1.5, wider than the cube
    pl.transform = pl.transform.withPosition(new V(0, 0, 0.3)); // slices the cube at z=0.3
    S.deselectAll();
  })()`);
  t.check('intersections scene: cut plane landed',
    await t.until(`window.__app.scene.objects.some((o) => o.name === 'CutPlane')`));
  // Fixed framing: look at the cube's front/right side faces from the +x,-y
  // quadrant at a moderate downward pitch so the z=0.3 cut line is well-exposed.
  await t.evaluate(`(() => {
    const cam = window.__app.camera; cam.yaw = 0.785; cam.pitch = 0.5; cam.distance = 7;
  })()`);
  await t.sleep(160); // let the throttled intersection rebuild settle
  await t.evaluate(`window.__app.renderer.shadingMode = 'matcap'`);

  // The matcap cube grey happens to sit very close to the line grey, so an
  // absolute colour match can't tell them apart. Instead read a small 2D block
  // centred on the cut line and DIFF off-vs-on: the line curve overwrites a
  // band of face pixels, turning them the line colours. The ribbon has a light
  // grey core (~115,115,122) and a soft dark rim; count pixels that both
  // CHANGED (luminance) and landed on either — unambiguous even when the
  // matcap under it is a similar grey.
  const faceBlock = (wx, wy, wz, half) => t.evaluate(`(() => {
    const app = window.__app, gl = app.renderer.ctx.gl, c = gl.canvas;
    app.renderer.render(app.scene, app.camera);
    const m = app.renderer.currentViewProj(app.scene, app.camera).m;
    const cw = m[3]*${wx} + m[7]*${wy} + m[11]*${wz} + m[15];
    const cx = m[0]*${wx} + m[4]*${wy} + m[8]*${wz} + m[12];
    const cy = m[1]*${wx} + m[5]*${wy} + m[9]*${wz} + m[13];
    const px = Math.round((cx/cw*0.5+0.5) * c.width);
    const py = Math.round((cy/cw*0.5+0.5) * c.height);
    const h = ${half}, s = 2*h + 1;
    const x0 = Math.max(0, Math.min(px - h, c.width - s));
    const y0 = Math.max(0, Math.min(py - h, c.height - s));
    const buf = new Uint8Array(s * s * 4);
    gl.readPixels(x0, y0, s, s, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    return Array.from(buf);
  })()`);
  // Count pixels that turned line-coloured between two block captures: a real
  // luminance change AND a colour close to the ribbon core (115,115,122) or
  // its soft dark rim.
  const lineAppeared = (off, on) => {
    let n = 0;
    for (let i = 0; i < on.length; i += 4) {
      const lOff = 0.2126*off[i] + 0.7152*off[i+1] + 0.0722*off[i+2];
      const lOn  = 0.2126*on[i]  + 0.7152*on[i+1]  + 0.0722*on[i+2];
      const dCore = Math.abs(on[i]-115) + Math.abs(on[i+1]-115) + Math.abs(on[i+2]-122);
      const dRim  = Math.abs(on[i]-31)  + Math.abs(on[i+1]-31)  + Math.abs(on[i+2]-36);
      if (Math.abs(lOn - lOff) > 12 && (dCore < 45 || dRim < 45)) n++;
    }
    return n;
  };

  const IPROBE = [0.2, -1.0, 0.3]; // on the cube -Y face, at the cut height
  await setPref('intersections', false);
  await t.sleep(40);
  const blkOff = await faceBlock(...IPROBE, 12);
  await setPref('intersections', true);
  await t.sleep(160);
  const blkOn = await faceBlock(...IPROBE, 12);
  await setPref('intersections', false);
  await t.sleep(40);
  const blkOffAgain = await faceBlock(...IPROBE, 12);
  const appeared = lineAppeared(blkOff, blkOn);
  const reverted = lineAppeared(blkOff, blkOffAgain);
  console.log(`      [intersect] matcap appeared=${appeared} reverted=${reverted}`);
  t.check('intersections ON: light-grey line pixels appear on the cube face',
    appeared >= 5, `appeared=${appeared}`);
  t.check('intersections OFF again: those line pixels are gone',
    reverted <= 1, `still=${reverted}`);

  // Works in wireframe mode too (spec: all shading modes).
  await t.evaluate(`window.__app.renderer.shadingMode = 'wireframe'`);
  await setPref('intersections', false);
  await t.sleep(60);
  const wireOff = await faceBlock(...IPROBE, 12);
  await setPref('intersections', true);
  await t.sleep(160);
  const wireOn = await faceBlock(...IPROBE, 12);
  await setPref('intersections', false);
  await t.evaluate(`window.__app.renderer.shadingMode = 'matcap'`);
  const wireAppeared = lineAppeared(wireOff, wireOn);
  console.log(`      [intersect] wireframe appeared=${wireAppeared}`);
  t.check('intersections draw in wireframe mode too',
    wireAppeared >= 5, `appeared=${wireAppeared}`);

  // Checkbox row exists in the shading dropdown.
  await t.evaluate(`document.querySelector('.shading-menu-btn').click()`);
  await t.sleep(80);
  t.check('intersections checkbox row exists in the shading dropdown',
    await t.evaluate(`!!document.querySelector('[data-shade-pref="intersections"] input[type=checkbox]')`));
  await t.key('Escape', 'Escape', 0);

  // Cleanup: drop the cut plane, clear the pref + shading mode.
  await t.evaluate(`(() => {
    const S = window.__app.scene;
    for (const o of [...S.objects]) if (o.name === 'CutPlane') S.remove(o.id);
    S.deselectAll();
    window.__app.shadePrefs.intersections = false;
    window.__app.renderer.shadingMode = 'matcap';
  })()`);

  // ===================================================================
  // UR5-1: unified per-mode Hidden Line — the cage-over-wires bug fix,
  // the see-through cage, object select-through, and the dropdown follow.
  // ===================================================================

  // Enter edit mode on a cube and select ALL its edges (whole cage orange).
  // Use the first non-Floor mesh (the boot Cube). Direct scene API — rendering
  // only reads scene.editMode, so this drives the same cage the UI would.
  await t.evaluate(`(() => {
    const S = window.__app.scene;
    const cube = S.objects.find((o) => o.kind === 'mesh' && o.name !== 'Floor');
    S.enterEditMode(cube.id);
    const e = S.editMode;
    e.elementMode = 'edge';
    e.edges.clear();
    for (const k of cube.mesh.edges().keys()) e.edges.add(k);
    e.touch();
    S.deselectAll ? null : null; // keep the cube active/edited
  })()`);
  t.check('UR5: edit mode entered with all edges selected',
    await t.until(`(() => { const e = window.__app.scene.editMode; return !!e && e.edges.size >= 12; })()`));

  // Orange pixels around the cube's NEAREST-to-camera edge midpoint — that edge
  // is guaranteed unoccluded (nothing is in front of the closest edge), so it
  // stays orange even with Hidden Line ON. Counts a REGION so a single rounded
  // pixel can't decide the check.
  const orangeOnNearestEdge = (r) => t.evaluate(`(() => {
    const app = window.__app, gl = app.renderer.ctx.gl, c = gl.canvas, S = app.scene;
    const obj = S.editObject;
    app.renderer.render(S, app.camera);
    const wm = S.worldMatrix(obj).m, m = app.renderer.currentViewProj(S, app.camera).m;
    let best = null, bestW = 1e9;
    for (const e of obj.mesh.edges().values()) {
      const a = obj.mesh.verts.get(e.v0).co, b = obj.mesh.verts.get(e.v1).co;
      const lx = (a.x+b.x)/2, ly = (a.y+b.y)/2, lz = (a.z+b.z)/2;
      const wx = wm[0]*lx+wm[4]*ly+wm[8]*lz+wm[12];
      const wy = wm[1]*lx+wm[5]*ly+wm[9]*lz+wm[13];
      const wz = wm[2]*lx+wm[6]*ly+wm[10]*lz+wm[15];
      const cx = m[0]*wx+m[4]*wy+m[8]*wz+m[12];
      const cy = m[1]*wx+m[5]*wy+m[9]*wz+m[13];
      const cw = m[3]*wx+m[7]*wy+m[11]*wz+m[15];
      if (cw > 0 && cw < bestW) {
        bestW = cw;
        best = [(cx/cw*0.5+0.5)*c.width, (cy/cw*0.5+0.5)*c.height];
      }
    }
    if (!best) return -1;
    const px = Math.round(best[0]), py = Math.round(best[1]);
    const rr = ${r}, s = 2*rr+1;
    const x0 = Math.max(0, Math.min(px-rr, c.width-s));
    const y0 = Math.max(0, Math.min(py-rr, c.height-s));
    const buf = new Uint8Array(s*s*4);
    gl.readPixels(x0, y0, s, s, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let orange = 0;
    for (let i = 0; i < s*s; i++) {
      const R = buf[i*4], G = buf[i*4+1], B = buf[i*4+2];
      if (R > 150 && G > 40 && G < 190 && B < 90 && (R - B) > 90) orange++;
    }
    return orange;
  })()`);

  // Orange pixels across the WHOLE edit-object screen bbox (all 8 world corners).
  const orangeInEditBBox = () => t.evaluate(`(() => {
    const app = window.__app, gl = app.renderer.ctx.gl, c = gl.canvas, S = app.scene;
    const obj = S.editObject;
    let mn = [1e9,1e9,1e9], mx = [-1e9,-1e9,-1e9];
    for (const v of obj.mesh.verts.values()) {
      mn[0]=Math.min(mn[0],v.co.x); mn[1]=Math.min(mn[1],v.co.y); mn[2]=Math.min(mn[2],v.co.z);
      mx[0]=Math.max(mx[0],v.co.x); mx[1]=Math.max(mx[1],v.co.y); mx[2]=Math.max(mx[2],v.co.z);
    }
    app.renderer.render(S, app.camera);
    const wm = S.worldMatrix(obj).m, m = app.renderer.currentViewProj(S, app.camera).m;
    let x0=1e9,x1=-1e9,y0=1e9,y1=-1e9;
    for (let i = 0; i < 8; i++) {
      const lx = i&1?mx[0]:mn[0], ly = i&2?mx[1]:mn[1], lz = i&4?mx[2]:mn[2];
      const wx = wm[0]*lx+wm[4]*ly+wm[8]*lz+wm[12];
      const wy = wm[1]*lx+wm[5]*ly+wm[9]*lz+wm[13];
      const wz = wm[2]*lx+wm[6]*ly+wm[10]*lz+wm[15];
      const cx = m[0]*wx+m[4]*wy+m[8]*wz+m[12];
      const cy = m[1]*wx+m[5]*wy+m[9]*wz+m[13];
      const cw = m[3]*wx+m[7]*wy+m[11]*wz+m[15];
      const px = (cx/cw*0.5+0.5)*c.width, py = (cy/cw*0.5+0.5)*c.height;
      x0=Math.min(x0,px); x1=Math.max(x1,px); y0=Math.min(y0,py); y1=Math.max(y1,py);
    }
    x0=Math.max(0,Math.floor(x0)); y0=Math.max(0,Math.floor(y0));
    const w=Math.min(c.width-x0,Math.ceil(x1-x0)), h=Math.min(c.height-y0,Math.ceil(y1-y0));
    const buf = new Uint8Array(w*h*4);
    gl.readPixels(x0, y0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let orange = 0;
    for (let i = 0; i < w*h; i++) {
      const R = buf[i*4], G = buf[i*4+1], B = buf[i*4+2];
      if (R > 150 && G > 40 && G < 190 && B < 90 && (R - B) > 90) orange++;
    }
    return orange;
  })()`);

  // --- Criterion 1: THE BUG. matcap + wireOverlay ON + hiddenLine.matcap ON
  // → the selected edge's ORANGE survives (the grey overlay no longer covers
  // the cage, because the edit object's wirePass edges are skipped). ---------
  await t.evaluate(`window.__app.renderer.shadingMode = 'matcap'`);
  await setPref('wireOverlay', true);
  await setPref('hiddenLine.matcap', true);
  await t.sleep(60);
  const orangeMatcapHL = await orangeOnNearestEdge(10);
  await t.screenshot('research/ur5-bug-cage.png');
  t.check('THE BUG: orange cage survives over wireOverlay+hiddenLine (matcap)',
    orangeMatcapHL > 8, `orange=${orangeMatcapHL}`);

  // Same in wireframe mode with hiddenLine ON.
  await t.evaluate(`window.__app.renderer.shadingMode = 'wireframe'`);
  await setPref('hiddenLine.wireframe', true);
  await t.sleep(60);
  const orangeWireHL = await orangeOnNearestEdge(10);
  t.check('THE BUG: orange cage survives in wireframe + hiddenLine ON',
    orangeWireHL > 8, `orange=${orangeWireHL}`);
  await t.evaluate(`window.__app.renderer.shadingMode = 'matcap'`);

  // --- Criterion 2: hiddenLine.matcap OFF → a BACK-side cage edge contributes
  // visible pixels (see-through cage): total orange in the bbox jumps because
  // the occluded back edges now draw. --------------------------------------
  await setPref('hiddenLine.matcap', true);
  await t.sleep(60);
  const bboxOrangeHL = await orangeInEditBBox();
  await setPref('hiddenLine.matcap', false);
  await t.sleep(60);
  const bboxOrangeSee = await orangeInEditBBox();
  await t.screenshot('research/ur5-seethrough-cage.png');
  t.check('see-through cage: hiddenLine OFF reveals back-side cage edges',
    bboxOrangeSee > bboxOrangeHL + 20 && bboxOrangeSee > 40,
    `hiddenLine=${bboxOrangeHL} seeThrough=${bboxOrangeSee}`);

  // Reset + leave edit mode.
  await setPref('wireOverlay', false);
  await setPref('hiddenLine.matcap', true);
  await t.evaluate(`window.__app.scene.exitEditMode()`);

  // --- Criterion 4: dropdown checkbox follows the mode. --------------------
  await t.evaluate(`(() => {
    const p = window.__app.shadePrefs;
    p.hiddenLine = { matcap: true, studio: true, rendered: true, wireframe: false };
  })()`);
  await t.evaluate(`document.querySelector('.shading-menu-btn').click()`);
  await t.sleep(80);
  const followsMode = await t.evaluate(`(() => {
    const box = document.querySelector('[data-shade-pref="hiddenLine"] input');
    const p = window.__app.shadePrefs;
    document.querySelector('.shading-menu-mode[data-mode="matcap"]').click();
    const matcapChecked = box.checked, matcapPref = p.hiddenLine.matcap;
    document.querySelector('.shading-menu-mode[data-mode="wireframe"]').click();
    const wireChecked = box.checked, wirePref = p.hiddenLine.wireframe;
    return { matcapChecked, matcapPref, wireChecked, wirePref };
  })()`);
  t.check('dropdown: Hidden Line checkbox reflects matcap mode (on)',
    followsMode.matcapChecked === true && followsMode.matcapPref === true,
    JSON.stringify(followsMode));
  t.check('dropdown: Hidden Line checkbox follows to wireframe mode (off)',
    followsMode.wireChecked === false && followsMode.wirePref === false,
    JSON.stringify(followsMode));
  t.check('dropdown: checkbox actually CHANGED with the mode',
    followsMode.matcapChecked !== followsMode.wireChecked);
  await t.key('Escape', 'Escape', 0);
  await t.evaluate(`window.__app.renderer.shadingMode = 'matcap'`);

  // --- Criterion 3: OBJECT select-through. Two cubes, one fully behind the
  // other; wireframe mode. hiddenLine OFF → clicking the back cube's wire
  // (visible through the front) selects the BACK cube; ON → selects the front.
  await t.evaluate(`(async () => {
    const app = window.__app, S = app.scene;
    const prim = await import('/src/core/mesh/primitives.ts');
    const V = (await import('/src/core/math/vec3.ts')).Vec3;
    S.exitEditMode();
    for (const o of [...S.objects]) S.remove(o.id);
    const front = S.add('FrontCube', prim.makeCube(1));
    const e = app.camera.eye;
    const len = Math.hypot(e.x, e.y, e.z) || 1;
    // origin + (direction from eye toward origin)*3 → 3 units PAST origin,
    // i.e. behind the front cube from the camera's viewpoint.
    const bx = -e.x/len*3, by = -e.y/len*3, bz = -e.z/len*3;
    const back = S.add('BackCube', prim.makeCube(0.5));
    back.transform = back.transform.withPosition(new V(bx, by, bz));
    S.deselectAll();
    window.__ur5 = { frontId: front.id, backId: back.id, bx, by, bz };
  })()`);
  t.check('select-through scene: two cubes placed',
    await t.until(`window.__ur5 && window.__app.scene.objects.length === 2`));
  await t.sleep(120);

  // Call pick() directly at the back cube's top-front edge midpoint (world).
  const pickAt = (wx, wy, wz) => t.evaluate(`(() => {
    const app = window.__app, c = app.renderer.ctx.gl.canvas;
    const dpr = window.devicePixelRatio || 1;
    const m = app.renderer.currentViewProj(app.scene, app.camera).m;
    const cx = m[0]*${wx}+m[4]*${wy}+m[8]*${wz}+m[12];
    const cy = m[1]*${wx}+m[5]*${wy}+m[9]*${wz}+m[13];
    const cw = m[3]*${wx}+m[7]*${wy}+m[11]*${wz}+m[15];
    const devX = (cx/cw*0.5+0.5)*c.width;
    const devYbottom = (cy/cw*0.5+0.5)*c.height;
    const cssX = devX/dpr, cssY = (c.height - devYbottom)/dpr;
    return app.renderer.pick(app.scene, app.camera, cssX, cssY);
  })()`);
  const ur5 = await t.evaluate(`window.__ur5`);
  const edgeWx = ur5.bx, edgeWy = ur5.by - 0.5, edgeWz = ur5.bz + 0.5;

  await t.evaluate(`window.__app.renderer.shadingMode = 'wireframe'`);
  await setPref('hiddenLine.wireframe', false);
  await t.sleep(60);
  const pickOff = await pickAt(edgeWx, edgeWy, edgeWz);
  t.check('select-through: click a back-cube wire → back cube selected (hiddenLine off)',
    pickOff && pickOff.kind === 'object' && pickOff.id === ur5.backId,
    JSON.stringify(pickOff) + ` back=${ur5.backId} front=${ur5.frontId}`);

  await setPref('hiddenLine.wireframe', true);
  await t.sleep(60);
  const pickOn = await pickAt(edgeWx, edgeWy, edgeWz);
  t.check('select-through OFF: same click → front cube selected (hiddenLine on)',
    pickOn && pickOn.kind === 'object' && pickOn.id === ur5.frontId,
    JSON.stringify(pickOn) + ` back=${ur5.backId} front=${ur5.frontId}`);

  // Cleanup.
  await t.evaluate(`(() => {
    const p = window.__app.shadePrefs;
    p.hiddenLine = { matcap: true, studio: true, rendered: true, wireframe: false };
    p.wireOverlay = false;
    window.__app.renderer.shadingMode = 'matcap';
    window.__app.scene.deselectAll();
  })()`);

  // ===================================================================
  // UR6-1: proximity-scaled wire thickness + anti-aliased wire ribbons
  // (the mesh wireframe is now screen-space ribbons, not 1px gl.LINES),
  // and a thicker/smoother selection outline.
  // ===================================================================

  // Single cube filling the frame, close camera so near/far vertical edges sit
  // at clearly different depths. Wireframe mode, classic (no hidden line) so the
  // BACK (far) vertical edge draws too.
  await t.evaluate(`(async () => {
    const S = window.__app.scene;
    for (const o of [...S.objects]) S.remove(o.id);
    const prim = await import('/src/core/mesh/primitives.ts');
    S.add('WCube', prim.makeCube(1));
    S.deselectAll();
    const cam = window.__app.camera;
    cam.yaw = 0.5; cam.pitch = 0.4; cam.distance = 3;
    window.__app.renderer.shadingMode = 'wireframe';
    window.__app.shadePrefs.wireOverlay = false;
    window.__app.shadePrefs.hiddenLine = { matcap:true, studio:true, rendered:true, wireframe:false };
    window.__wcube = true;
  })()`);
  t.check('UR6 wire scene ready',
    await t.until(`window.__wcube && window.__app.scene.objects.length === 1`));
  await t.sleep(120);

  // Probe the 4 vertical (z-varying) cube edges; measure the longest horizontal
  // DARK run (ribbon width in px) through the nearest and farthest ones, plus
  // the per-pixel luminance strip across the near edge (for the AA check).
  const wireProbe = await t.evaluate(`(() => {
    const app = window.__app, gl = app.renderer.ctx.gl, c = gl.canvas, S = app.scene;
    app.renderer.render(S, app.camera);
    const obj = S.objects[0];
    const wm = S.worldMatrix(obj).m, m = app.renderer.currentViewProj(S, app.camera).m;
    const corners = [[1,1],[1,-1],[-1,1],[-1,-1]]; // (x,y) of the 4 z-edges; z=0 mid
    const edges = corners.map(([x,y]) => {
      const wx=wm[0]*x+wm[4]*y+wm[12], wy=wm[1]*x+wm[5]*y+wm[13], wz=wm[2]*x+wm[6]*y+wm[14];
      const cx=m[0]*wx+m[4]*wy+m[8]*wz+m[12];
      const cy=m[1]*wx+m[5]*wy+m[9]*wz+m[13];
      const cw=m[3]*wx+m[7]*wy+m[11]*wz+m[15];
      return { px:(cx/cw*0.5+0.5)*c.width, py:(cy/cw*0.5+0.5)*c.height, depth:cw };
    }).sort((a,b)=>a.depth-b.depth);
    const runAt = (e) => {
      const py = Math.round(e.py);
      const x0 = Math.max(0, Math.round(e.px)-16);
      const W = Math.min(c.width-x0, 33);
      const buf = new Uint8Array(W*4);
      gl.readPixels(x0, py, W, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      let best=0, run=0; const levels=[];
      for (let i=0;i<W;i++){
        const l=0.2126*buf[i*4]+0.7152*buf[i*4+1]+0.0722*buf[i*4+2];
        levels.push(Math.round(l));
        if (l<40){run++; if(run>best)best=run;} else run=0;
      }
      return { width: best, levels };
    };
    const near = edges[0], far = edges[edges.length-1];
    return { near: runAt(near), far: runAt(far), nearDepth: near.depth, farDepth: far.depth };
  })()`);
  await t.screenshot('research/ur6-wire-proximity.png');
  console.log(`      [UR6] nearW=${wireProbe.near.width}@d${wireProbe.nearDepth.toFixed(2)} farW=${wireProbe.far.width}@d${wireProbe.farDepth.toFixed(2)}`);
  console.log(`      [UR6] near strip levels=[${wireProbe.near.levels.join(',')}]`);

  // (1) Proximity: the nearer vertical edge's wire is measurably wider.
  t.check('UR6 (1) proximity: near vertical edge wire wider than far edge',
    wireProbe.near.width > wireProbe.far.width + 1,
    `nearW=${wireProbe.near.width} farW=${wireProbe.far.width}`);

  // (2) AA: the near wire's luminance strip has >=2 intermediate levels between
  // the dark core and the background (a soft ramp, not a binary edge).
  {
    const lv = wireProbe.near.levels;
    const core = Math.min(...lv), bg = Math.max(...lv);
    const inter = new Set(lv.filter((l) => l > core + 4 && l < bg - 4));
    t.check('UR6 (2) AA: near wire has >=2 intermediate luminance levels',
      inter.size >= 2, `core=${core} bg=${bg} intermediates=[${[...inter].sort((a,b)=>a-b)}]`);
  }

  // (4) Selection outline: thicker + smoother. Select the cube (matcap), hide
  // the gizmo so the center column reads only the outline, and probe a vertical
  // column at the cube's screen center through the TOP silhouette: the orange
  // outline band is >=3px and its blended-orange R values span >=2 levels (AA).
  await t.evaluate(`(() => {
    const app = window.__app, S = app.scene;
    app.renderer.shadingMode = 'matcap';
    app.renderer.gizmoVisible = false;
    app.camera.distance = 5; // whole cube + its outline on-screen with margin
    S.selectOnly(S.objects[0].id);
  })()`);
  await t.sleep(80);
  const outline = await t.evaluate(`(() => {
    const app = window.__app, gl = app.renderer.ctx.gl, c = gl.canvas, S = app.scene;
    app.renderer.render(S, app.camera);
    const obj = S.objects[0];
    const wm = S.worldMatrix(obj).m, m = app.renderer.currentViewProj(S, app.camera).m;
    // Screen bbox of the cube; scan a horizontal row at mid-height across the
    // full width + margin — it crosses the LEFT and RIGHT silhouette outlines
    // (vertical orange bands), so the longest orange run is the outline width.
    let minX=1e9,maxX=-1e9,minY=1e9,maxY=-1e9;
    for (let i=0;i<8;i++){
      const lx=i&1?1:-1, ly=i&2?1:-1, lz=i&4?1:-1;
      const wx=wm[0]*lx+wm[4]*ly+wm[8]*lz+wm[12];
      const wy=wm[1]*lx+wm[5]*ly+wm[9]*lz+wm[13];
      const wz=wm[2]*lx+wm[6]*ly+wm[10]*lz+wm[15];
      const cx=m[0]*wx+m[4]*wy+m[8]*wz+m[12];
      const cy=m[1]*wx+m[5]*wy+m[9]*wz+m[13];
      const cw=m[3]*wx+m[7]*wy+m[11]*wz+m[15];
      const px=(cx/cw*0.5+0.5)*c.width, py=(cy/cw*0.5+0.5)*c.height;
      minX=Math.min(minX,px); maxX=Math.max(maxX,px);
      minY=Math.min(minY,py); maxY=Math.max(maxY,py);
    }
    const rowY = Math.max(0, Math.min(Math.round((minY+maxY)/2), c.height-1));
    const x0 = Math.max(0, Math.round(minX)-8);
    const W = Math.min(c.width-x0, Math.round(maxX-minX)+16);
    const buf = new Uint8Array(W*4);
    gl.readPixels(x0, rowY, W, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    // Orange TINT test (catches faint low-alpha AA pixels too): blended
    // selection orange keeps R > G > B with a clear red-over-blue bias even at
    // low coverage, while the grey background/matcap has R ≈ G ≈ B.
    let run=0, best=0; const rVals=[];
    for (let i=0;i<W;i++){
      const R=buf[i*4],G=buf[i*4+1],B=buf[i*4+2];
      const tinted = (R-B) > 15 && R >= G && G >= B;
      if (tinted){run++; if(run>best)best=run; rVals.push(R);} else run=0;
    }
    return { width: best, rLevels: new Set(rVals).size, rVals };
  })()`);
  await t.screenshot('research/ur6-outline.png');
  console.log(`      [UR6] outline width=${outline.width}px rLevels=${outline.rLevels} rVals=[${outline.rVals.join(',')}]`);
  t.check('UR6 (4) outline: selected object outline band is >=3px thick',
    outline.width >= 3, `width=${outline.width}`);
  t.check('UR6 (4) outline: outline has intermediate alpha levels (smooth AA)',
    outline.rLevels >= 2, `distinctR=${outline.rLevels}`);

  // Cleanup: restore defaults for any later suite reuse.
  await t.evaluate(`(() => {
    const app = window.__app;
    app.renderer.gizmoVisible = true;
    app.renderer.shadingMode = 'matcap';
    app.scene.deselectAll();
  })()`);

  // ===================================================================
  // UR9-1: collapsible AO/Wireframe/Intersections sections + wire color,
  // proximity toggle, Thin/Thick width, and intersection color.
  // ===================================================================

  // (1) DISCLOSURE — AO controls hidden until the section is expanded, and the
  // expanded state persists across a reload (shadePrefs.sections).
  await t.evaluate(`window.__app.renderer.shadingMode = 'matcap'`);
  // Earlier blocks may have expanded the AO section; reset to the collapsed
  // default before the fresh menu is built so the default-collapsed check holds.
  await t.evaluate(`window.__app.shadePrefs.sections = { ao: false, wire: false, intersect: false }`);
  await t.evaluate(`document.querySelector('.shading-menu-btn').click()`);
  await t.sleep(80);
  const bodyDisplay = (sec) => t.evaluate(`(() => {
    const b = document.querySelector('.shading-section[data-section="${sec}"] .shading-section-body');
    return b ? getComputedStyle(b).display : 'no-body';
  })()`);
  t.check('UR9 (1) three disclosure sections exist (ao/wire/intersect)',
    (await t.evaluate(`[...document.querySelectorAll('.shading-section')].map((s)=>s.dataset.section).join(',')`)) === 'ao,wire,intersect');
  t.check('UR9 (1) AO section controls hidden while collapsed (default)',
    (await bodyDisplay('ao')) === 'none');
  t.check('UR9 (1) AO radius slider not visible while collapsed',
    await t.evaluate(`(() => { const s = document.querySelector('[data-shade-slider="aoRadius"]'); return s ? s.offsetParent === null : 'no-slider'; })()`) === true);
  // Expand by clicking the disclosure caret (NOT the enable checkbox).
  await t.evaluate(`document.querySelector('.shading-section[data-section="ao"] .shading-disc').click()`);
  await t.sleep(60);
  t.check('UR9 (1) expanding the AO section reveals its controls',
    (await bodyDisplay('ao')) !== 'none');
  t.check('UR9 (1) expanded state written to prefs',
    await t.evaluate(`window.__app.shadePrefs.sections.ao === true`));
  await t.key('Escape', 'Escape', 0);
  await t.sleep(40);

  // Persistence across reload.
  await t.reload();
  await t.sleep(200);
  await t.key('Escape', 'Escape', 0); // dismiss splash
  t.check('UR9 (1) sections.ao persisted across reload',
    await t.until(`window.__app && window.__app.shadePrefs.sections.ao === true`));
  await t.evaluate(`document.querySelector('.shading-menu-btn').click()`);
  await t.sleep(80);
  t.check('UR9 (1) AO section reopens EXPANDED after reload',
    (await t.evaluate(`(() => { const b = document.querySelector('.shading-section[data-section="ao"] .shading-section-body'); return b ? getComputedStyle(b).display : 'no-body'; })()`)) !== 'none');
  await t.key('Escape', 'Escape', 0);
  // Collapse it again so nothing downstream depends on the expanded state.
  await t.evaluate(`window.__app.shadePrefs.sections.ao = false`);

  // --- Wire scene: single cube, wireframe mode, distance-3 framing (the UR6
  // probe proves both the near and far vertical edges stay on-screen here). The
  // wire is driven bright RED so the width probe detects it by COLOR (a red run),
  // independent of the dark wireframe background. Reused for (2)-(4). -----------
  await t.evaluate(`(async () => {
    const S = window.__app.scene;
    for (const o of [...S.objects]) { if (S.editMode) S.exitEditMode(); S.remove(o.id); }
    const prim = await import('/src/core/mesh/primitives.ts');
    S.add('U9Cube', prim.makeCube(1));
    S.deselectAll();
    const cam = window.__app.camera;
    cam.yaw = 0.5; cam.pitch = 0.4; cam.distance = 3;
    const app = window.__app;
    app.renderer.shadingMode = 'wireframe';
    app.shadePrefs.wireOverlay = false;
    app.shadePrefs.hiddenLine = { matcap:true, studio:true, rendered:true, wireframe:false };
    app.shadePrefs.wireProximity = true;
    app.shadePrefs.wireMinPx = 0.6; app.shadePrefs.wireMaxPx = 3.5;
    app.shadePrefs.wireColor = [1, 0, 0];   // bright red for the color + width probes
    window.__u9cube = true;
  })()`);
  t.check('UR9 wire scene ready',
    await t.until(`window.__u9cube && window.__app.scene.objects.length === 1`));
  await t.sleep(120);

  // Probe the 4 vertical (z-varying) cube edges: sort by depth, scan a horizontal
  // strip across the nearest + farthest one. Returns the longest RED run (px
  // width) and the peak red channel.
  const wireRedProbe = () => t.evaluate(`(() => {
    const app = window.__app, gl = app.renderer.ctx.gl, c = gl.canvas, S = app.scene;
    app.renderer.render(S, app.camera);
    const obj = S.objects[0];
    const wm = S.worldMatrix(obj).m, m = app.renderer.currentViewProj(S, app.camera).m;
    const corners = [[1,1],[1,-1],[-1,1],[-1,-1]];
    const edges = corners.map(([x,y]) => {
      const wx=wm[0]*x+wm[4]*y+wm[12], wy=wm[1]*x+wm[5]*y+wm[13], wz=wm[2]*x+wm[6]*y+wm[14];
      const cx=m[0]*wx+m[4]*wy+m[8]*wz+m[12];
      const cy=m[1]*wx+m[5]*wy+m[9]*wz+m[13];
      const cw=m[3]*wx+m[7]*wy+m[11]*wz+m[15];
      return { px:(cx/cw*0.5+0.5)*c.width, py:(cy/cw*0.5+0.5)*c.height, depth:cw };
    }).sort((a,b)=>a.depth-b.depth);
    const scan = (e) => {
      const py = Math.round(e.py);
      const x0 = Math.max(0, Math.round(e.px)-16);
      const W = Math.min(c.width-x0, 33);
      const buf = new Uint8Array(W*4);
      gl.readPixels(x0, py, W, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      let best=0, run=0, redMax=0;
      for (let i=0;i<W;i++){
        const R=buf[i*4],G=buf[i*4+1],B=buf[i*4+2];
        const isRed = R>110 && (R-G)>70 && (R-B)>70;
        if (isRed){run++; if(run>best)best=run;} else run=0;
        if (isRed && R>redMax) redMax=R;
      }
      return { width: best, redMax };
    };
    return { near: scan(edges[0]), far: scan(edges[edges.length-1]) };
  })()`);

  // (2) wireColor bright red → wireframe-mode wire pixels are red.
  await t.sleep(60);
  const redProbe = await wireRedProbe();
  await t.screenshot('research/ur9-red-wires.png');
  console.log(`      [UR9] red wire near.redMax=${redProbe.near.redMax} far.redMax=${redProbe.far.redMax} nearW=${redProbe.near.width}`);
  t.check('UR9 (2) wireColor red → wireframe wire pixels are red',
    redProbe.near.redMax > 150, `near.redMax=${redProbe.near.redMax}`);

  // Cage colors unchanged: enter edit mode with red wireColor still set, select
  // all edges — the cage stays ORANGE (its own color), not red (orangeInEditBBox
  // rejects red because red's G≈0 fails the orange test).
  await t.evaluate(`(() => {
    const S = window.__app.scene;
    const cube = S.objects[0];
    S.enterEditMode(cube.id);
    const e = S.editMode; e.elementMode = 'edge'; e.edges.clear();
    for (const k of cube.mesh.edges().keys()) e.edges.add(k);
    e.touch();
  })()`);
  await t.until(`(() => { const e = window.__app.scene.editMode; return !!e && e.edges.size >= 12; })()`);
  await t.sleep(60);
  const cageOrange = await orangeInEditBBox();
  console.log(`      [UR9] cage orange pixels (red wireColor set) = ${cageOrange}`);
  t.check('UR9 (2) edit cage keeps its own orange color (not driven by wireColor)',
    cageOrange > 10, `orange=${cageOrange}`);
  await t.evaluate(`(() => { const S = window.__app.scene; if (S.editMode) S.exitEditMode(); S.deselectAll(); })()`);
  await t.sleep(60);

  // (3) wireProximity OFF → near and far edge widths EQUAL (both clamp bounds =
  // wireMaxPx, so every edge is a constant width regardless of depth).
  await t.evaluate(`(() => { const p = window.__app.shadePrefs; p.wireProximity = false; p.wireMaxPx = 3.5; })()`);
  await t.sleep(60);
  const eqProbe = await wireRedProbe();
  console.log(`      [UR9] proximity OFF: nearW=${eqProbe.near.width} farW=${eqProbe.far.width}`);
  t.check('UR9 (3) proximity off → near and far edge widths are equal',
    Math.abs(eqProbe.near.width - eqProbe.far.width) <= 1,
    `nearW=${eqProbe.near.width} farW=${eqProbe.far.width}`);

  // (4) wireMaxPx 6 → the (capped) near edge grows. Baseline cap 1 clamps the
  // near edge hard; raising the cap to 6 lets its proximity width through.
  await t.evaluate(`(() => { const p = window.__app.shadePrefs; p.wireProximity = true; p.wireMinPx = 0.6; p.wireMaxPx = 1; })()`);
  await t.sleep(60);
  const capLow = await wireRedProbe();
  await t.evaluate(`window.__app.shadePrefs.wireMaxPx = 6`);
  await t.sleep(60);
  const capHigh = await wireRedProbe();
  console.log(`      [UR9] near width cap1=${capLow.near.width} cap6=${capHigh.near.width}`);
  t.check('UR9 (4) raising wireMaxPx to 6 widens the near edge wire',
    capHigh.near.width > capLow.near.width + 1,
    `cap1=${capLow.near.width} cap6=${capHigh.near.width}`);

  // Restore wire defaults.
  await t.evaluate(`(() => { const p = window.__app.shadePrefs; p.wireProximity = true; p.wireMinPx = 0.6; p.wireMaxPx = 3.5; p.wireColor = [0.05,0.05,0.06]; })()`);

  // (5) intersectColor CYAN → the intersection ribbon draws cyan. Plane-through-
  // cube scene, matcap; count cyan pixels appearing on the cut line.
  await t.evaluate(`(async () => {
    const S = window.__app.scene;
    for (const o of [...S.objects]) { if (S.editMode) S.exitEditMode(); S.remove(o.id); }
    const prim = await import('/src/core/mesh/primitives.ts');
    const V = (await import('/src/core/math/vec3.ts')).Vec3;
    const cube = S.add('U9Cube', prim.makeCube(1));
    const pl = S.add('U9CutPlane', prim.makePlane(3));
    pl.transform = pl.transform.withPosition(new V(0, 0, 0.3));
    S.deselectAll();
    const cam = window.__app.camera; cam.yaw = 0.785; cam.pitch = 0.5; cam.distance = 7;
    window.__app.renderer.shadingMode = 'matcap';
  })()`);
  t.check('UR9 (5) intersect scene: cut plane landed',
    await t.until(`window.__app.scene.objects.some((o) => o.name === 'U9CutPlane')`));
  await t.sleep(160);
  await t.evaluate(`(() => { const p = window.__app.shadePrefs; p.intersectColor = [0,1,1]; p.intersections = true; })()`);
  await t.sleep(180);
  const cyanBlk = await faceBlock(0.2, -1.0, 0.3, 12);
  let cyanN = 0;
  for (let i = 0; i < cyanBlk.length; i += 4) {
    const R = cyanBlk[i], G = cyanBlk[i + 1], B = cyanBlk[i + 2];
    if (G > 140 && B > 140 && R < 120 && (G - R) > 50 && (B - R) > 50) cyanN++;
  }
  await t.screenshot('research/ur9-cyan-intersect.png');
  console.log(`      [UR9] cyan intersection pixels = ${cyanN}`);
  t.check('UR9 (5) intersectColor cyan → intersection ribbon pixels are cyan',
    cyanN >= 5, `cyan=${cyanN}`);

  // Cleanup.
  await t.evaluate(`(() => {
    const S = window.__app.scene;
    for (const o of [...S.objects]) { if (S.editMode) S.exitEditMode(); S.remove(o.id); }
    const p = window.__app.shadePrefs;
    p.intersections = false; p.intersectColor = [0.45,0.45,0.48];
    window.__app.renderer.shadingMode = 'matcap';
  })()`);
});
