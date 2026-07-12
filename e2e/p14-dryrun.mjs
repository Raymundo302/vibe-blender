/**
 * P14-4 e2e — THE NODE-SHADING DRY RUN.
 *
 * Loads the frozen donut (e2e/fixtures/donut-p9-frozen.vibe.json — the same
 * fixture P11 froze), gives the ICING material a real procedural node graph,
 * and drives the whole node-shading pipeline end-to-end through public entry
 * points (in-page fetch + __app.io.apply, the material object, the Shader
 * Editor workspace pane, the Rendered viewport bake, the F12 path tracer,
 * io.serialize + t.reload + io.apply):
 *
 *   noise ─┬─▶ colorRamp (pink→white) ─▶ Principled.baseColor
 *          └─▶ math (multiply 0.5)     ─▶ Principled.roughness
 *
 *   1. Load the frozen donut; identify the icing object + its material.
 *      Smart-UV-Project the icing (procedural noise reads surface UVs, and the
 *      frozen icing carries NONE — see NODES-RUN.md, PUNCH-LIST: no generated
 *      texture coords yet), so the noise actually varies across the surface.
 *   2. Rendered-viewport + F12 baselines of the FLAT pink icing.
 *   3. Build the graph on the icing material; useNodes on; version bumped.
 *   4. Rendered viewport: frame differs from the flat baseline; no GL errors.
 *   5. Shader Editor pane on the icing: it renders the 4 node boxes
 *      (debug handle window.__shaderEditor.nodeCount()).
 *   6. F12 low-spp path trace: completes and differs from the flat trace of the
 *      same view; the hero PNG is saved to research/donut-nodes-hero.png.
 *   7. io.serialize → research/donut-nodes.vibe.json; t.reload + io.apply into a
 *      fresh boot; the graph survives (4 nodes + 4 links) and a re-render still
 *      differs from the same material with useNodes off.
 *
 * Run with the dev server up (under flock; long — two F12 passes):
 *   flock /tmp/vibe-blender-e2e.lock node e2e/p14-dryrun.mjs
 */
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runE2e } from './harness.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..');
const SHOTS = '/tmp/noderun';
mkdirSync(SHOTS, { recursive: true });

// The icing's pink (Material.001 baseColor in the frozen fixture) → the
// colorRamp's low stop; white is the high stop.
const PINK = [0.905882, 0.65098, 0.768627];

runE2e(async (t) => {
  // UR12-3: default render engine is GPU; these are CPU-path regression suites — pin CPU.
  await t.until('!!window.__renderEngine');
  await t.evaluate("window.__renderEngine.setEngine('cpu')");
  const wallStart = Date.now();
  const evalAsync = async (expr) => {
    const { result, exceptionDetails } = await t.send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    });
    if (exceptionDetails) throw new Error(`page threw: ${exceptionDetails.text}`);
    return result.value;
  };
  const shot = (n, name) => t.screenshot(join(SHOTS, `${n}-${name}.png`));
  const clickItem = (label) => t.evaluate(`(() => {
    const b = [...document.querySelectorAll('.add-menu-item')].find((x) => x.textContent === ${JSON.stringify(label)} && !x.disabled);
    if (b) { b.click(); return true; }
    return false;
  })()`);
  const report = {};

  // Layout workspace + dismiss splash.
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

  // =====================================================================
  // STAGE 1 — Load the frozen donut; identify the icing + its material.
  // =====================================================================
  const load = await evalAsync(`(async () => {
    const txt = await fetch('/e2e/fixtures/donut-p9-frozen.vibe.json').then((r) => r.text());
    window.__app.io.apply(txt);
    const S = window.__app.scene;
    const icing = S.objects.find((o) => o.name === 'Icing');
    let nodeMats = 0;
    for (const m of S.materials) if (m.useNodes) nodeMats++;
    return {
      objects: S.objects.length,
      icing: icing ? icing.id : null,
      matId: icing ? icing.materialId : null,
      nodeMats,
      bytes: txt.length,
    };
  })()`);
  t.check('S1: frozen donut loaded (9 objects)', load.objects === 9, `objects=${load.objects}`);
  t.check('S1: icing object + its material present', load.icing != null && load.matId != null,
    `icing=${load.icing} matId=${load.matId}`);
  t.check('S1: fixture predates nodes — 0 node materials', load.nodeMats === 0, `nodeMats=${load.nodeMats}`);
  const icingId = load.icing;
  const matId = load.matId;
  report.fixtureBytes = load.bytes;
  await shot('01', 'loaded');

  // Smart UV Project the icing so procedural noise has UVs to sample. Frozen
  // icing has none; without UVs the tracer/bake sample (0,0) and the noise is
  // a constant. Driven through the real U → Smart UV Project menu.
  await evalAsync(`(() => {
    const S = window.__app.scene;
    if (S.editMode) S.exitEditMode();
    S.selectOnly(${icingId});
    S.enterEditMode(${icingId});
    S.editMode.setElementMode('face', S.editObject.mesh);
    S.editMode.clearSelection();
  })()`);
  await t.sleep(100);
  t.check('S1: icing base mesh has no UVs before Smart Project',
    (await t.evaluate(`window.__app.scene.editObject.mesh.uvs.size`)) === 0);
  await t.mouse('mouseMoved', cx, cy);
  await t.key('u', 'KeyU', 0);
  await t.sleep(90);
  t.check('S1: U menu offers Smart UV Project', await clickItem('Smart UV Project'));
  await t.sleep(200);
  const uvOut = await t.evaluate(`(() => {
    const m = window.__app.scene.editObject.mesh;
    return { uvFaces: m.uvs.size, faces: m.faces.size };
  })()`);
  t.check('S1: Smart Project populates every icing face UV',
    uvOut.uvFaces === uvOut.faces && uvOut.uvFaces > 0, `${uvOut.uvFaces}/${uvOut.faces}`);
  report.icingFaces = uvOut.faces;
  await evalAsync(`window.__app.scene.exitEditMode()`);
  await t.sleep(80);

  // =====================================================================
  // STAGE 2 — FLAT baselines. Frame the icing + Rendered mode; capture the
  // Rendered-viewport frame and a low-spp F12 trace of the flat pink icing.
  // =====================================================================
  await t.evaluate(`window.__app.scene.selectOnly(${icingId})`);
  await t.mouse('mouseMoved', cx, cy);
  await t.key('.', 'NumpadDecimal', 0); await t.sleep(220);
  await t.evaluate(`window.__app.renderer.shadingMode = 'rendered'`);
  await t.sleep(150);

  // Full-frame luminance capture stored in-page (for flat-vs-nodes diffs).
  const capFrame = (slot) => t.evaluate(`(() => {
    const app = window.__app, gl = app.renderer.ctx.gl, c = gl.canvas;
    app.renderer.render(app.scene, app.camera);
    const w = c.width, h = c.height, px = new Uint8Array(w*h*4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const lum = new Float64Array(w*h);
    for (let i = 0; i < w*h; i++) lum[i] = 0.299*px[i*4] + 0.587*px[i*4+1] + 0.114*px[i*4+2];
    window['${slot}'] = lum;
    return gl.getError();
  })()`);
  const countChanged = (a, b) => t.evaluate(`(() => { const A = window['${a}'], B = window['${b}']; let n = 0; for (let i = 0; i < A.length; i++) if (Math.abs(A[i] - B[i]) > 12) n++; return n; })()`);

  const flatErr = await capFrame('__ndFlat');
  t.check('S2: flat Rendered pass reports NO GL error', flatErr === 0, `getError ${flatErr}`);
  // Determinism control: the same flat scene rendered twice must be identical.
  await capFrame('__ndFlat2');
  const flatFlat = await countChanged('__ndFlat', '__ndFlat2');
  t.check('S2: flat-vs-flat Rendered frame is identical (0 changed pixels)', flatFlat === 0, `changed=${flatFlat}`);
  await shot('02', 'flat-rendered');

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

  const flatTrace = await traceTo('flat');
  writeFileSync(join(SHOTS, '02-trace-flat.png'), Buffer.from(flatTrace.png.split(',')[1], 'base64'));
  t.check('S2: flat trace frame is non-empty',
    Array.isArray(flatTrace.sample) && flatTrace.sample.length > 100);

  // =====================================================================
  // STAGE 3 — Build the node graph on the icing material.
  // noise → colorRamp(pink→white) → baseColor ; noise → math(×0.5) → roughness.
  // Built on the material object (the sibling P14 suites' pattern); the Shader
  // Editor (Stage 5) then displays it. useNodes on, nodeGraphVersion bumped.
  // =====================================================================
  const built = await t.evaluate(`(() => {
    const mat = window.__app.scene.getMaterial(${matId});
    mat.nodeGraph = {
      nodes: [
        { id: 0, type: 'principled', x: 520, y: 150, params: {} },
        { id: 1, type: 'noise', x: 40, y: 140, params: { scale: 6, octaves: 4 } },
        { id: 2, type: 'colorRamp', x: 280, y: 40, params: {
            ramp: { stops: [ { pos: 0, color: ${JSON.stringify(PINK)} }, { pos: 1, color: [1, 1, 1] } ] } } },
        { id: 3, type: 'math', x: 280, y: 250, params: { op: 'multiply', a: 0.5, b: 0.5 } },
      ],
      links: [
        { fromNode: 1, fromSocket: 'value', toNode: 2, toSocket: 'fac' },
        { fromNode: 2, fromSocket: 'color', toNode: 0, toSocket: 'baseColor' },
        { fromNode: 1, fromSocket: 'value', toNode: 3, toSocket: 'a' },
        { fromNode: 3, fromSocket: 'value', toNode: 0, toSocket: 'roughness' },
      ],
      nextNodeId: 4,
    };
    mat.useNodes = true;
    mat.nodeGraphVersion = (mat.nodeGraphVersion || 0) + 1;
    return { useNodes: mat.useNodes, nodes: mat.nodeGraph.nodes.length, links: mat.nodeGraph.links.length };
  })()`);
  t.check('S3: node graph built on the icing material (4 nodes, 4 links, useNodes on)',
    built.useNodes === true && built.nodes === 4 && built.links === 4, JSON.stringify(built));

  // =====================================================================
  // STAGE 4 — Rendered viewport: the node bake differs from the flat baseline;
  // no GL errors. (Same camera as the flat baseline — nothing moved.)
  // =====================================================================
  await t.sleep(80);
  const nodeErr = await capFrame('__ndNodes');
  t.check('S4: node Rendered pass reports NO GL error', nodeErr === 0, `getError ${nodeErr}`);
  const rChanged = await countChanged('__ndFlat', '__ndNodes');
  t.check('S4: Rendered viewport with nodes differs from the flat baseline (bake path active)',
    rChanged > 500 && flatFlat === 0, `changed=${rChanged} control=${flatFlat}`);
  report.renderedChanged = rChanged;
  await shot('04', 'nodes-rendered');

  // Bake sanity: the material baked a base texture at the current graph version.
  const bake = await t.evaluate(`(() => {
    const mat = window.__app.scene.getMaterial(${matId});
    return {
      baked: !!(mat.baked && mat.baked.baseUrl && mat.baked.baseUrl.startsWith('data:image/png')),
      bakedVersion: mat.baked ? mat.baked.version : -1,
      graphVersion: mat.nodeGraphVersion,
    };
  })()`);
  t.check('S4: material baked a base texture from the graph', bake.baked === true);
  t.check('S4: baked version tracks nodeGraphVersion', bake.bakedVersion === bake.graphVersion,
    `baked ${bake.bakedVersion} vs graph ${bake.graphVersion}`);

  // =====================================================================
  // STAGE 5 — Shader Editor pane on the icing: it renders the 4 node boxes.
  // Switch an area to the 'shader' editor (icing is the active object) and read
  // the P14-1 debug handle's node count (== drawn node boxes).
  // =====================================================================
  await t.evaluate(`window.__app.scene.selectOnly(${icingId})`);
  await t.sleep(60);
  await t.evaluate(`(() => {
    const sel = [...document.querySelectorAll('.wsp-area-select')].find((s) => s.value === 'properties') ||
                document.querySelector('.wsp-area-select');
    sel.value = 'shader';
    sel.dispatchEvent(new Event('change'));
  })()`);
  await t.sleep(400); // frame loop mounts + draws the shader canvas

  t.check('S5: Shader Editor canvas mounted', await t.evaluate(`!!document.querySelector('.shader-editor-canvas, .shader-editor canvas')`));
  t.check('S5: Shader Editor debug handle present', await t.evaluate(`!!window.__shaderEditor`));
  const nodeCount = await t.evaluate(`window.__shaderEditor.nodeCount()`);
  t.check('S5: Shader Editor renders the 4 node boxes (Principled + Noise + ColorRamp + Math)',
    nodeCount === 4, `nodeCount=${nodeCount}`);
  // Sockets are positionable — proves the nodes are actually laid out/drawn.
  const socketOk = await t.evaluate(`(() => {
    const p = window.__shaderEditor.socketPos(0, 'baseColor');
    return !!p && Number.isFinite(p.x) && Number.isFinite(p.y);
  })()`);
  t.check('S5: node sockets are laid out (Principled.baseColor has a client pos)', socketOk === true);
  report.shaderNodeCount = nodeCount;
  await shot('05', 'shader-editor');

  // Switch the area back to Properties so the rest of the run is unaffected.
  await t.evaluate(`(() => {
    const sel = [...document.querySelectorAll('.wsp-area-select')].find((s) => s.value === 'shader');
    if (sel) { sel.value = 'properties'; sel.dispatchEvent(new Event('change')); }
  })()`);
  await t.sleep(250);

  // =====================================================================
  // STAGE 6 — F12 low-spp path trace of the node material; differs from the
  // flat trace of the same view; save the hero PNG.
  // =====================================================================
  const nodeTrace = await traceTo('nodes');
  const heroPath = join(REPO, 'research', 'donut-nodes-hero.png');
  writeFileSync(heroPath, Buffer.from(nodeTrace.png.split(',')[1], 'base64'));
  writeFileSync(join(SHOTS, '06-trace-nodes.png'), Buffer.from(nodeTrace.png.split(',')[1], 'base64'));
  let diff = 0, n = Math.min(flatTrace.sample.length, nodeTrace.sample.length);
  for (let i = 0; i < n; i++) diff += Math.abs(flatTrace.sample[i] - nodeTrace.sample[i]);
  const meanDiff = diff / n;
  t.check('S6: node F12 trace DIFFERS from the flat trace of the same view (tracer hook active)',
    meanDiff > 1.0, `meanAbsDiff(0-255)=${meanDiff.toFixed(3)}`);
  report.f12MeanDiff = +meanDiff.toFixed(3);
  report.heroSaved = 'research/donut-nodes-hero.png';

  // =====================================================================
  // STAGE 7 — Save → reload → re-apply → the graph survives + still shades.
  // =====================================================================
  await t.evaluate(`window.__app.renderer.shadingMode = 'matcap'`);
  const serialized = await t.evaluate('window.__app.io.serialize()');
  const outPath = join(REPO, 'research', 'donut-nodes.vibe.json');
  writeFileSync(outPath, serialized);
  report.sceneBytes = serialized.length;

  await t.reload();
  const survive = await evalAsync(`(async () => {
    const txt = await fetch('/research/donut-nodes.vibe.json').then((r) => r.text());
    window.__app.io.apply(txt);
    const S = window.__app.scene;
    const icing = S.objects.find((o) => o.name === 'Icing');
    const mat = icing ? S.getMaterial(icing.materialId) : null;
    return {
      icingId: icing ? icing.id : null,
      useNodes: mat ? mat.useNodes : false,
      nodes: mat && mat.nodeGraph ? mat.nodeGraph.nodes.length : 0,
      links: mat && mat.nodeGraph ? mat.nodeGraph.links.length : 0,
    };
  })()`);
  t.check('S7: reloaded scene keeps useNodes on', survive.useNodes === true);
  t.check('S7: node graph survives the reload (4 nodes + 4 links)',
    survive.nodes === 4 && survive.links === 4, JSON.stringify(survive));

  // Re-render in the fresh boot: node material vs the same material forced flat.
  await t.evaluate(`window.__app.scene.selectOnly(${survive.icingId})`);
  await t.mouse('mouseMoved', cx, cy);
  await t.key('.', 'NumpadDecimal', 0); await t.sleep(220);
  await t.evaluate(`window.__app.renderer.shadingMode = 'rendered'`);
  await t.sleep(150);
  await capFrame('__ndReloadNodes');
  const flipFlat = await t.evaluate(`(() => {
    const S = window.__app.scene;
    const icing = S.objects.find((o) => o.name === 'Icing');
    const mat = S.getMaterial(icing.materialId);
    window.__ndSavedUseNodes = mat.useNodes;
    mat.useNodes = false;
    mat.nodeGraphVersion = (mat.nodeGraphVersion || 0) + 1;
    return true;
  })()`);
  t.check('S7: could toggle the reloaded material to flat for the control', flipFlat === true);
  await t.sleep(80);
  await capFrame('__ndReloadFlat');
  const reloadChanged = await countChanged('__ndReloadFlat', '__ndReloadNodes');
  t.check('S7: after reload, the node material still shades differently than flat',
    reloadChanged > 500, `changed=${reloadChanged}`);
  report.reloadChanged = reloadChanged;
  await shot('07', 'reloaded-nodes');

  // Restore useNodes so the saved scene state is coherent, then clean up.
  await t.evaluate(`(() => {
    const S = window.__app.scene;
    const icing = S.objects.find((o) => o.name === 'Icing');
    if (icing) { const mat = S.getMaterial(icing.materialId); if (mat) mat.useNodes = window.__ndSavedUseNodes !== false; }
    window.__app.renderer.shadingMode = 'matcap';
    if (S.editMode) S.exitEditMode();
    for (const o of [...S.objects]) S.remove(o.id);
    for (const m of [...S.materials]) S.removeMaterial(m.id);
    window.__app.renderer.cameraViewId = null;
    window.__app.autosave && window.__app.autosave.clear && window.__app.autosave.clear();
  })()`);

  report.wallSeconds = ((Date.now() - wallStart) / 1000).toFixed(1);
  console.log('\n===NODE-DRYRUN-REPORT===');
  console.log(JSON.stringify(report, null, 2));
  console.log('===END-REPORT===');
});
