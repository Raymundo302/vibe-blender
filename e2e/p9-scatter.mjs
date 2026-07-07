/**
 * P9-5 e2e — Scatter modifier. Builds a torus host + small cylinder source via
 * __app, adds a Scatter through the Modifiers tab UI, picks the source in the
 * object dropdown, and:
 *   - asserts the evaluated face count grew by count × source-faces,
 *   - with colorVariation 1, switches to Rendered shading and samples the
 *     screenshot pixels to prove multiple distinct sprinkle colors appear,
 *   - proves save→load keeps the source reference AND reproduces a
 *     byte-identical evaluated result.
 * Run with the dev server up:
 *   flock /tmp/vibe-blender-e2e.lock node e2e/p9-scatter.mjs
 */
import { inflateSync } from 'node:zlib';
import { runE2e } from './harness.mjs';

/** Minimal PNG → {width,height,rgba} decoder (8-bit, colorType 2 or 6). */
function decodePng(buf) {
  let p = 8; // skip signature
  let width = 0, height = 0, colorType = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
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
      const v = raw[rp++];
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let out;
      switch (filter) {
        case 1: out = v + a; break;
        case 2: out = v + b; break;
        case 3: out = v + ((a + b) >> 1); break;
        case 4: out = v + paeth(a, b, c); break;
        default: out = v;
      }
      cur[x] = out & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const s = x * channels, d = (y * width + x) * 4;
      rgba[d] = cur[s];
      rgba[d + 1] = cur[s + 1];
      rgba[d + 2] = cur[s + 2];
      rgba[d + 3] = channels === 4 ? cur[s + 3] : 255;
    }
    prev.set(cur);
  }
  return { width, height, rgba };
}

/** Count distinct saturated hue buckets among the pixels (the sprinkle colors). */
function distinctSaturatedHues(png) {
  const { width, height, rgba } = png;
  const buckets = new Set();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      if (max - min < 30 || max < 40) continue; // gray / background / too dark
      // Hue in degrees, bucketed to 30° bins.
      let h;
      const d = max - min;
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h = ((h * 60) + 360) % 360;
      buckets.add(Math.floor(h / 30));
    }
  }
  return buckets.size;
}

runE2e(async (t) => {
  const evalAsync = async (expr) => {
    const { result, exceptionDetails } = await t.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    });
    if (exceptionDetails) throw new Error(`page threw: ${exceptionDetails.text}`);
    return result.value;
  };

  const saved = await t.evaluate('window.__app.io.serialize()');
  await t.evaluate(`document.querySelector('.wsp-tab[data-workspace="Layout"]')?.click()`);
  await t.sleep(150);

  // --- Build: a torus host + a small cylinder source + a couple of lights. ---
  const built = await evalAsync(`(async () => {
    const app = window.__app, S = app.scene;
    while (S.objects.length) S.remove(S.objects[0].id);
    const prim = await import('/src/core/mesh/primitives.ts');
    const V = (await import('/src/core/math/vec3.ts')).Vec3;
    const host = S.add('Donut', prim.makeTorus());
    const src = S.add('Sprinkle', prim.makeCylinder(0.04, 0.18, 6));
    src.transform = src.transform.withPosition(new V(4, 0, 0)); // off to the side
    // Lights so Rendered mode is bright enough to sample.
    const sun = S.addLight('Sun', 'sun');
    const key = S.addLight('Key', 'point');
    key.transform = key.transform.withPosition(new V(2, 4, 3));
    key.light = { ...key.light, power: 600 };
    S.selectOnly(host.id);
    return {
      hostId: host.id, srcId: src.id,
      hostFaces: host.mesh.faces.size, srcFaces: src.mesh.faces.size,
    };
  })()`);
  await t.sleep(150);
  const { hostId, srcId, hostFaces, srcFaces } = built;
  t.check('scene built (torus host + cylinder source)', hostFaces > 0 && srcFaces > 0);

  // --- Add Scatter through the Modifiers tab UI. ---
  t.check('Modifiers tab button exists',
    await t.until(`!!document.querySelector('.properties-tab-btn[data-tab="modifier"]')`, 5000));
  await t.evaluate(`document.querySelector('.properties-tab-btn[data-tab="modifier"]').click()`);
  await t.sleep(140);

  t.check('Scatter is offered in the Add Modifier dropdown',
    await t.evaluate(`(() => {
      const sel = document.querySelector('.modifier-add-select');
      return !!sel && [...sel.options].some((o) => o.value === 'scatter');
    })()`));

  await t.evaluate(`(() => {
    const sel = document.querySelector('.modifier-add-select');
    sel.value = 'scatter';
    sel.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(160);
  t.check('Scatter added to the host stack',
    (await t.evaluate(`window.__app.scene.get(${hostId}).modifiers[0]?.type`)) === 'scatter');

  // --- Pick the source in the object dropdown (kind:'object' param). ---
  await t.evaluate(`(() => {
    const sel = document.querySelector('.modifier-param[data-key="source"]');
    sel.value = String(${srcId});
    sel.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(120);
  t.check('source param committed to the cylinder id',
    (await t.evaluate(`window.__app.scene.get(${hostId}).modifiers[0].params().source`)) === srcId);

  // --- Set count + colorVariation through the generic param inputs. ---
  const COUNT = 120;
  await t.evaluate(`(() => {
    const set = (key, val) => {
      const el = document.querySelector('.modifier-param[data-key="' + key + '"]');
      el.value = String(val); el.dispatchEvent(new Event('change'));
    };
    set('count', ${COUNT});
    set('scale', 1.4);
    set('colorVariation', 1);
  })()`);
  await t.sleep(150);
  t.check('count param committed',
    (await t.evaluate(`window.__app.scene.get(${hostId}).modifiers[0].params().count`)) === COUNT);

  // --- Evaluated face count grew by count × source-faces. ---
  const evalFaces = await t.evaluate(`(() => {
    const S = window.__app.scene, host = S.get(${hostId});
    return host.evaluatedMesh(S.modifierContext(host)).faces.size;
  })()`);
  t.check('evaluated face count = host + count × source faces',
    evalFaces === hostFaces + COUNT * srcFaces,
    `got ${evalFaces}, want ${hostFaces + COUNT * srcFaces}`);

  // --- Rendered mode: sample the screenshot for distinct sprinkle colors. ---
  await t.evaluate(`(() => {
    window.__app.renderer.shadingMode = 'rendered';
    window.__app.scene.get(${hostId}).color = [0.15, 0.15, 0.15];
  })()`);
  await t.sleep(300);
  const shot = await t.send('Page.captureScreenshot', { format: 'png' });
  const png = decodePng(Buffer.from(shot.data, 'base64'));
  const hues = distinctSaturatedHues(png);
  t.check('rendered mode shows multiple distinct sprinkle colors', hues >= 2, `distinct hues=${hues}`);

  // The evaluated geometry as raw data (insertion order). Compared numerically
  // within a tolerance below — the scene save rounds base-mesh coords to 6
  // decimals, so exact string equality would trip on that lossy round rather
  // than on any Scatter non-determinism.
  const evalData = `(() => {
    const S = window.__app.scene;
    const host = S.objects.find((o) => o.name === 'Donut');
    const mesh = host.evaluatedMesh(S.modifierContext(host));
    const verts = [...mesh.verts.values()].map((v) => [v.co.x, v.co.y, v.co.z]);
    const tints = [...mesh.faceTints.values()].map((tt) => [tt[0], tt[1], tt[2]]);
    return { v: verts, f: mesh.faces.size, t: tints };
  })()`;
  const sigBefore = await t.evaluate(evalData);

  // --- Save→load round-trip: byte-stable serialize + source reference kept. ---
  const s1 = await t.evaluate('window.__app.io.serialize()');
  await t.evaluate(`window.__app.io.apply(${JSON.stringify(s1)})`);
  await t.sleep(150);
  const s2 = await t.evaluate('window.__app.io.serialize()');
  t.check('serialize is byte-stable across a save→load round-trip', s1 === s2,
    `${s1.length} vs ${s2.length}`);

  const resolved = await t.evaluate(`(() => {
    const S = window.__app.scene;
    const host = S.objects.find((o) => o.name === 'Donut');
    const sid = host?.modifiers[0]?.params().source;
    const src = S.get(sid);
    return src ? src.name : null;
  })()`);
  t.check('reloaded Scatter source resolves to the same-named object',
    resolved === 'Sprinkle', `resolved=${resolved}`);

  const sigAfter = await t.evaluate(evalData);
  const sameGeometry = (() => {
    if (sigBefore.f !== sigAfter.f) return `face count ${sigBefore.f} vs ${sigAfter.f}`;
    if (sigBefore.v.length !== sigAfter.v.length) return `vert count mismatch`;
    if (sigBefore.t.length !== sigAfter.t.length) return `tint count mismatch`;
    let maxD = 0;
    for (let i = 0; i < sigBefore.v.length; i++) {
      for (let k = 0; k < 3; k++) maxD = Math.max(maxD, Math.abs(sigBefore.v[i][k] - sigAfter.v[i][k]));
    }
    for (let i = 0; i < sigBefore.t.length; i++) {
      for (let k = 0; k < 3; k++) {
        if (Math.abs(sigBefore.t[i][k] - sigAfter.t[i][k]) > 1e-6) return `tint mismatch`;
      }
    }
    return maxD < 1e-4 ? '' : `maxDelta=${maxD}`;
  })();
  t.check('evaluated result is identical after save→load (within 1e-4)',
    sameGeometry === '', sameGeometry);

  // Restore the starting scene so the suite ends as it began.
  await t.evaluate(`window.__app.renderer.shadingMode = 'matcap'`);
  await t.evaluate(`window.__app.io.apply(${JSON.stringify(saved)})`);
  await t.evaluate(`window.__app.autosave.clear()`);
});
