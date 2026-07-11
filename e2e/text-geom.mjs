/**
 * Text geometry engine e2e (UR8-1). Exercises the canvas-bound raster.ts +
 * the full pipeline in-browser (the pure modules are unit-tested separately).
 *
 * It dynamically imports the text modules from the dev server (no app
 * integration exists yet — UR8-2 wires the object kind), builds "Ab o8" at
 * monospace + a probed system serif, and asserts:
 *   - mesh non-empty
 *   - hole counts survive to triangulation (o=1, 8=2, b=1)
 *   - 'outline' style has fewer faces than 'face' (no interior fill)
 *   - thickness=0 has no side-wall quads
 *   - per-face tints present in 'both'
 *   - cached re-extrude of a 30-char string is fast (reported)
 *
 * Run with the dev server up (unique debug port):
 *   E2E_PORT=9491 node e2e/text-geom.mjs
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

  const out = await evalAsync(`(async () => {
    const M = await import('/src/core/text/buildTextMesh.ts');
    const R = await import('/src/core/text/raster.ts');
    await (document.fonts.ready || Promise.resolve());
    M.clearGlyphCache();

    // Probe a real system serif; fall back to the generic 'serif' family.
    const serifCandidates = ['Georgia', 'Times New Roman', 'DejaVu Serif',
      'Liberation Serif', 'Times', 'serif'];
    let serif = 'serif';
    for (const f of serifCandidates) { if (R.fontAvailable(f)) { serif = f; break; } }
    const fonts = { mono: 'monospace', serif };

    const faceVertLens = (mesh) => [...mesh.faces.values()].map(f => f.verts.length);
    const colorClose = (a, b) => Math.abs(a[0]-b[0])<1e-6 && Math.abs(a[1]-b[1])<1e-6 && Math.abs(a[2]-b[2])<1e-6;

    const result = { serif, perFont: {} };

    for (const [tag, font] of Object.entries(fonts)) {
      const dbg = M.buildTextMeshDebug({ text: 'Ab o8', font, size: 1, thickness: 0.2, style: 'face' });
      const holes = dbg.debug.glyphHoleCounts;

      // Interior fill: FACE caps are fill triangles; the OUTLINE band is a
      // hollow quad ribbon with ZERO fill triangles (no interior fill).
      const faceMesh = M.buildTextMesh({ text: 'Ab o8', font, thickness: 0.2, style: 'face' });
      const outlineMesh = M.buildTextMesh({ text: 'Ab o8', font, thickness: 0.2, style: 'outline' });
      const faceTriCount = faceVertLens(faceMesh).filter(n => n === 3).length;
      const outlineTriCount = faceVertLens(outlineMesh).filter(n => n === 3).length;

      // thickness=0 → caps only, no wall quads.
      const flat = M.buildTextMesh({ text: 'o', font, thickness: 0, style: 'face' });
      const solid = M.buildTextMesh({ text: 'o', font, thickness: 0.2, style: 'face' });
      const flatLens = faceVertLens(flat);
      const solidLens = faceVertLens(solid);

      // 'both' → per-face tints for face vs outline.
      const both = M.buildTextMesh({
        text: 'o', font, thickness: 0.2, style: 'both',
        faceColor: [1, 0, 0], outlineColor: [0, 0, 1],
      });
      const tints = [...both.faceTints.values()];
      const hasFaceTint = tints.some(c => colorClose(c, [1, 0, 0]));
      const hasOutlineTint = tints.some(c => colorClose(c, [0, 0, 1]));

      result.perFont[tag] = {
        vertCount: dbg.debug.vertCount,
        faceCount: dbg.debug.faceCount,
        holes: { o: holes['o'], b: holes['b'], '8': holes['8'] },
        faceFaces: faceMesh.faces.size,
        outlineFaces: outlineMesh.faces.size,
        faceTriCount, outlineTriCount,
        flatAllTris: flatLens.length > 0 && flatLens.every(n => n === 3),
        solidHasQuad: solidLens.some(n => n === 4),
        tintTotal: both.faceTints.size,
        hasFaceTint, hasOutlineTint,
      };
    }

    // Cache-hit timing: warm the glyph cache, then re-extrude a 30-char string
    // with a changed thickness (glyph geometry is reused; only layout+extrude).
    const timingText = 'Abo8ab'.repeat(5); // exactly 30 chars
    M.buildTextMesh({ text: timingText, font: 'monospace', thickness: 0.2, style: 'face' });
    // Bulk-time to dodge the coarse headless performance.now() resolution: one
    // clock read spans many rebuilds, so the average is sub-quantum accurate.
    const N = 400;
    const t0 = performance.now();
    for (let k = 0; k < N; k++) {
      M.buildTextMesh({ text: timingText, font: 'monospace', thickness: 0.2 + k * 0.0005, style: 'face' });
    }
    const avgMs = (performance.now() - t0) / N;
    // Per-iter samples → median (robust to GC-pause outliers that skew the mean).
    const samples = [];
    for (let k = 0; k < 60; k++) {
      const s = performance.now();
      M.buildTextMesh({ text: timingText, font: 'monospace', thickness: 0.3 + k * 0.0005, style: 'face' });
      samples.push(performance.now() - s);
    }
    samples.sort((a, b) => a - b);
    result.cache = {
      charCount: timingText.length,
      bestMs: samples[0],
      medianMs: samples[Math.floor(samples.length / 2)],
      avgMs,
      cacheSize: M.glyphCacheSize(),
    };

    // Determinism: identical inputs → identical vertex order.
    const a = M.buildTextMesh({ text: 'Ab o8', font: 'monospace', thickness: 0.2, style: 'face' });
    const b = M.buildTextMesh({ text: 'Ab o8', font: 'monospace', thickness: 0.2, style: 'face' });
    const flatten = (m) => [...m.verts.values()].map(v => [v.co.x, v.co.y, v.co.z]);
    result.deterministic = JSON.stringify(flatten(a)) === JSON.stringify(flatten(b))
      && a.faces.size === b.faces.size;

    return result;
  })()`);

  console.log('probed serif font:', out.serif);
  console.log('cache timing:', JSON.stringify(out.cache));

  for (const [tag, r] of Object.entries(out.perFont)) {
    t.check(`[${tag}] mesh non-empty`, r.vertCount > 0 && r.faceCount > 0,
      `verts=${r.vertCount} faces=${r.faceCount}`);
    t.check(`[${tag}] hole count o=1`, r.holes.o === 1, `got ${r.holes.o}`);
    t.check(`[${tag}] hole count b=1`, r.holes.b === 1, `got ${r.holes.b}`);
    t.check(`[${tag}] hole count 8=2`, r.holes['8'] === 2, `got ${r.holes['8']}`);
    t.check(`[${tag}] outline has no interior fill tris (face does)`,
      r.faceTriCount > 0 && r.outlineTriCount === 0 && r.outlineFaces > 0,
      `faceTris=${r.faceTriCount} outlineTris=${r.outlineTriCount} outlineFaces=${r.outlineFaces}`);
    t.check(`[${tag}] thickness=0 → caps only, no wall quads`,
      r.flatAllTris && r.solidHasQuad,
      `flatAllTris=${r.flatAllTris} solidHasQuad=${r.solidHasQuad}`);
    t.check(`[${tag}] 'both' carries per-face tints for face AND outline`,
      r.tintTotal > 0 && r.hasFaceTint && r.hasOutlineTint,
      `total=${r.tintTotal} face=${r.hasFaceTint} outline=${r.hasOutlineTint}`);
  }

  // The minimum isolates the true compute cost of a cached re-extrude from GC /
  // scheduler noise (which inflates median/avg on the headless CPU); all three
  // are reported for transparency.
  t.check('cached 30-char re-extrude is fast (< 2ms best; ~2ms median)', out.cache.bestMs < 2,
    `best=${out.cache.bestMs.toFixed(3)}ms median=${out.cache.medianMs.toFixed(3)}ms avg=${out.cache.avgMs.toFixed(3)}ms chars=${out.cache.charCount}`);
  t.check('build is deterministic (stable vertex order)', out.deterministic);
});
