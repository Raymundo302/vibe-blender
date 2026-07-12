/**
 * P16-2 e2e — GENERATED texture coordinates close the NODES-RUN gap: a
 * procedural material varies across the surface WITHOUT a UV unwrap.
 *
 * Loads the frozen donut fixture, gives the icing (NO UV map — the frozen
 * icing has none, and we deliberately never unwrap) a node material:
 *   texCoord.generated → noise.uv → colorRamp → baseColor  (useNodes).
 * Because the icing has no UVs, ctx.u/ctx.v collapse to (0,0) everywhere, so a
 * uv-driven noise would be flat. The Texture Coordinate node's GENERATED output
 * (ctx.gen, filled per-hit by the tracer from triGen) varies over the surface,
 * so a low-spp F12 trace of the node icing DIFFERS from a flat-material trace —
 * the exact gap NODES-RUN found, now closed.
 *
 * Run with the dev server up:
 *   flock /tmp/vibe-blender-e2e.lock node e2e/p16-texcoord.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runE2e } from './harness.mjs';

const SHOTS = '/tmp/p16-texcoord';
mkdirSync(SHOTS, { recursive: true });

runE2e(async (t) => {
  // UR12-3: default render engine is GPU; these are CPU-path regression suites — pin CPU.
  await t.until('!!window.__renderEngine');
  await t.evaluate("window.__renderEngine.setEngine('cpu')");
  await t.reload();
  const evalAsync = async (expr) => {
    const { result, exceptionDetails } = await t.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    });
    if (exceptionDetails) throw new Error(`page threw: ${exceptionDetails.text}`);
    return result.value;
  };

  await t.evaluate(`document.querySelector('.wsp-tab[data-workspace="Layout"]')?.click()`);
  await t.sleep(150);
  await t.key('Escape', 'Escape', 0);
  await t.sleep(80);

  const rect = await t.evaluate(`(() => {
    const c = document.querySelector('#viewport-wrap canvas') || document.querySelector('canvas');
    const r = c.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  })()`);
  const cx = Math.round(rect.x + rect.w / 2);
  const cy = Math.round(rect.y + rect.h / 2);

  // --- STAGE 1: load the frozen donut; identify the icing + its material. ---
  const load = await evalAsync(`(async () => {
    const txt = await fetch('/e2e/fixtures/donut-p9-frozen.vibe.json').then((r) => r.text());
    window.__app.io.apply(txt);
    const S = window.__app.scene;
    if (S.editMode) S.exitEditMode();
    const icing = S.objects.find((o) => o.name === 'Icing');
    return {
      objects: S.objects.length,
      icing: icing ? icing.id : null,
      matId: icing ? icing.materialId : null,
      uvFaces: icing ? icing.mesh.uvs.size : -1,
    };
  })()`);
  t.check('S1: frozen donut loaded (9 objects)', load.objects === 9, `objects=${load.objects}`);
  t.check('S1: icing + its material present', load.icing != null && load.matId != null,
    `icing=${load.icing} matId=${load.matId}`);
  t.check('S1: icing carries NO UV map (the whole point)', load.uvFaces === 0, `uvFaces=${load.uvFaces}`);
  const icingId = load.icing;
  const matId = load.matId;

  // Select the icing (default orbit camera sees the whole donut, icing
  // included — enough for a surface-variance comparison; numpad framing during
  // a headless run can wedge the tracer worker, so we keep the default view).
  await t.evaluate(`window.__app.scene.selectOnly(${icingId})`);

  const readTraceSample = () => t.evaluate(`(() => {
    const cv = window.__renderEngine.canvas(), c2 = cv.getContext('2d');
    const d = c2.getImageData(0, 0, cv.width, cv.height).data;
    const out = [];
    for (let i = 0; i < d.length; i += 16) out.push(d[i], d[i + 1], d[i + 2]);
    return out;
  })()`);
  const LOW_SPP = 4;
  const traceTo = async (label) => {
    await t.evaluate('window.__renderEngine.start()');
    const ok = await t.until(`window.__renderEngine.sample() >= ${LOW_SPP}`, 600000);
    t.check(`S: F12 ${label} trace reaches >= ${LOW_SPP} samples`, ok);
    const sample = await readTraceSample();
    const png = await t.evaluate(`window.__renderEngine.canvas().toDataURL('image/png')`);
    await t.evaluate('window.__renderEngine.close()');
    await t.sleep(150);
    return { sample, png };
  };

  // --- STAGE 2: FLAT baseline F12 trace of the un-noded icing. ---
  const flatTrace = await traceTo('flat');
  writeFileSync(join(SHOTS, '02-trace-flat.png'), Buffer.from(flatTrace.png.split(',')[1], 'base64'));
  t.check('S2: flat trace frame is non-empty',
    Array.isArray(flatTrace.sample) && flatTrace.sample.length > 100);

  // --- STAGE 3: build the generated → noise → colorRamp node graph. ---
  const built = await t.evaluate(`(() => {
    const mat = window.__app.scene.getMaterial(${matId});
    mat.nodeGraph = {
      nodes: [
        { id: 0, type: 'principled', x: 640, y: 150, params: {} },
        { id: 1, type: 'texCoord', x: 40, y: 140, params: {} },
        { id: 2, type: 'noise', x: 260, y: 140, params: { scale: 6, octaves: 4, contrast: 0.6 } },
        { id: 3, type: 'colorRamp', x: 440, y: 120, params: {
            ramp: { stops: [ { pos: 0, color: [0.9, 0.2, 0.5] }, { pos: 1, color: [1, 1, 1] } ] } } },
      ],
      links: [
        { fromNode: 1, fromSocket: 'generated', toNode: 2, toSocket: 'uv' },
        { fromNode: 2, fromSocket: 'value', toNode: 3, toSocket: 'fac' },
        { fromNode: 3, fromSocket: 'color', toNode: 0, toSocket: 'baseColor' },
      ],
      nextNodeId: 4,
    };
    mat.useNodes = true;
    mat.nodeGraphVersion = (mat.nodeGraphVersion || 0) + 1;
    return { useNodes: mat.useNodes, nodes: mat.nodeGraph.nodes.length, links: mat.nodeGraph.links.length };
  })()`);
  t.check('S3: generated→noise→ramp graph built (4 nodes, 3 links, useNodes on)',
    built.useNodes === true && built.nodes === 4 && built.links === 3, JSON.stringify(built));

  // --- STAGE 4: F12 trace of the node icing; must DIFFER from the flat trace.
  const nodeTrace = await traceTo('nodes');
  writeFileSync(join(SHOTS, '04-trace-nodes.png'), Buffer.from(nodeTrace.png.split(',')[1], 'base64'));
  let diff = 0, n = Math.min(flatTrace.sample.length, nodeTrace.sample.length);
  for (let i = 0; i < n; i++) diff += Math.abs(flatTrace.sample[i] - nodeTrace.sample[i]);
  const meanDiff = diff / n;
  t.check('S4: node F12 trace DIFFERS from the flat trace (generated coords vary WITHOUT UVs)',
    meanDiff > 1.0, `meanAbsDiff(0-255)=${meanDiff.toFixed(3)}`);

  // --- STAGE 5: prove the variation comes from GENERATED, not UV. With no UV
  // map, swapping the noise input to texCoord.uv makes it flat (ctx.u/v = 0 →
  // constant noise), so that trace should be ~indistinguishable from flat. ---
  await t.evaluate(`(() => {
    const mat = window.__app.scene.getMaterial(${matId});
    // Re-point the noise uv input from generated → uv.
    mat.nodeGraph.links = mat.nodeGraph.links.map((l) =>
      (l.toNode === 2 && l.toSocket === 'uv') ? { ...l, fromSocket: 'uv' } : l);
    mat.nodeGraphVersion = (mat.nodeGraphVersion || 0) + 1;
  })()`);
  const uvTrace = await traceTo('uv-driven');
  let diffUv = 0, m = Math.min(flatTrace.sample.length, uvTrace.sample.length);
  for (let i = 0; i < m; i++) diffUv += Math.abs(flatTrace.sample[i] - uvTrace.sample[i]);
  const meanDiffUv = diffUv / m;
  t.check('S5: uv-driven noise (no UV map) is ~flat vs generated (control)',
    meanDiffUv < meanDiff, `uvDiff=${meanDiffUv.toFixed(3)} < genDiff=${meanDiff.toFixed(3)}`);

  // --- STAGE 6: the BAKE path now honors GENERATED coords (the P16 gap this
  // suite documented). Earlier the Rendered-viewport bake had no surface
  // positions, so texCoord.generated collapsed to (u,v,0) and a generated-driven
  // material baked IDENTICALLY to a uv-driven one. Now the bake CPU-rasterizes
  // the mesh's generated coords into UV space, so on a UV-unwrapped cube (whose
  // cross layout differs from its normalized 3D position) the generated bake
  // VARIES and DIFFERS from the uv bake. ---
  const bakeSetup = await evalAsync(`(async () => {
    const prim = await import('/src/core/mesh/primitives.ts');
    const S = window.__app.scene;
    const cube = S.add('BakeCube', prim.makeCube(1)); // ships a default unwrap
    const mat = S.addMaterial('BakeMat');
    cube.materialId = mat.id;
    S.selectOnly(cube.id);
    window.__bakeMatId = mat.id;
    window.__bakeCubeId = cube.id;
    return { uvFaces: cube.mesh.uvs.size, matId: mat.id };
  })()`);
  t.check('S6: bake cube ships a default UV unwrap (bake can rasterize gen)',
    bakeSetup.uvFaces > 0, `uvFaces=${bakeSetup.uvFaces}`);

  // Set the checker's coordinate source, force a fresh bake in Rendered mode,
  // decode the baked base map and return a coarse byte signature + distinct
  // luminance-level count + dimensions.
  const bakeWith = async (socket, res) => {
    await t.evaluate(`(() => {
      const mat = window.__app.scene.getMaterial(window.__bakeMatId);
      mat.nodeGraph = {
        nodes: [
          { id: 0, type: 'principled', x: 520, y: 150, params: {} },
          { id: 1, type: 'texCoord', x: 40, y: 140, params: {} },
          { id: 2, type: 'checker', x: 280, y: 140, params: { scale: 4 } },
        ],
        links: [
          { fromNode: 1, fromSocket: '${socket}', toNode: 2, toSocket: 'uv' },
          { fromNode: 2, fromSocket: 'color', toNode: 0, toSocket: 'baseColor' },
        ],
        nextNodeId: 3,
      };
      mat.useNodes = true;
      mat.bakeRes = ${res === null ? 'undefined' : res};
      mat.nodeGraphVersion = (mat.nodeGraphVersion || 0) + 1;
      mat.baked = undefined;
      window.__app.renderer.shadingMode = 'rendered';
      window.__app.renderer.render(window.__app.scene, window.__app.camera);
    })()`);
    return await evalAsync(`(async () => {
      const mat = window.__app.scene.getMaterial(window.__bakeMatId);
      if (!mat.baked) return { baked: false };
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = mat.baked.baseUrl; });
      const cnv = document.createElement('canvas');
      cnv.width = img.naturalWidth; cnv.height = img.naturalHeight;
      const g = cnv.getContext('2d'); g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, cnv.width, cnv.height).data;
      const sig = []; for (let i = 0; i < d.length; i += 64) sig.push(d[i]);
      const set = new Set(); for (let i = 0; i < d.length; i += 4) set.add(d[i]);
      return { baked: true, w: cnv.width, h: cnv.height, distinct: set.size, sig, bakeSize: mat.baked.size };
    })()`);
  };

  const genBake = await bakeWith('generated', null);
  t.check('S6: generated-driven graph baked a base texture', genBake.baked === true);
  t.check('S6: default bake resolution is 128×128', genBake.w === 128 && genBake.h === 128,
    `${genBake.w}×${genBake.h}`);
  t.check('S6: generated bake VARIES (not the uniform UV fallback)', genBake.distinct > 1,
    `distinct=${genBake.distinct}`);

  const uvBake = await bakeWith('uv', null);
  t.check('S6: uv-driven graph baked a base texture', uvBake.baked === true);
  let bakeDiff = 0;
  const bn = Math.min(genBake.sig.length, uvBake.sig.length);
  for (let i = 0; i < bn; i++) if (Math.abs(genBake.sig[i] - uvBake.sig[i]) > 8) bakeDiff++;
  t.check('S6: generated bake DIFFERS from uv bake (gen coords now baked, gap closed)',
    bakeDiff > 0, `changedSamples=${bakeDiff}/${bn}`);

  // --- STAGE 7: per-material bake resolution option. ---
  const res256 = await bakeWith('generated', 256);
  t.check('S7: bakeRes 256 produces 256×256 maps',
    res256.baked === true && res256.w === 256 && res256.h === 256 && res256.bakeSize === 256,
    `${res256.w}×${res256.h} bakeSize=${res256.bakeSize}`);

  // --- Cleanup: drop the node material + the bake cube so the app is left clean. ---
  await t.evaluate(`(() => {
    const S = window.__app.scene;
    const mat = S.getMaterial(${matId});
    mat.useNodes = false;
    mat.nodeGraph = null;
    if (window.__bakeCubeId != null) S.remove(window.__bakeCubeId);
    if (window.__bakeMatId != null) S.removeMaterial(window.__bakeMatId);
    window.__app.renderer.shadingMode = 'matcap';
  })()`);
});
