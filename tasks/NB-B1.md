# NB-B1 — Curvature combs for curves

## Context
Read FIRST:
- `src/core/nurbs/curve.ts` — `curvatureAt(c, u)` (point, tangent, kappa,
  principal normal — the comb primitive is DONE, you sample and draw it),
  `fromCurveData`, `curveDomain`.
- `src/render/Renderer.ts` — `drawCurves` (~line 393) + `curveGpu` (~line 341):
  the per-curve ribbon cache pattern. Your comb pass hooks in right after
  drawCurves' loop.
- `src/render/passes/curveEditPass.ts` — pass structure model (shader, VertexArray,
  cache key).
- `src/ui/nPanel.ts` — the Curve section (extended by NB-A4 with degree/rebuild;
  read its CURRENT state). You add a "Curvature Comb" subsection to it.
- `src/core/undo/curveCommands.ts` — for payload changes (comb display fields).

## Design
Comb display state is a PER-CURVE payload field (serialized): add is NOT allowed
in objectData.ts (do-not-touch) — instead keep comb settings as APP-LEVEL,
per-object-id runtime prefs in a new module `src/render/combPrefs.ts`
(localStorage-persisted, keyed by object id, the overlayPrefs/shadePrefs
pattern — read those files). Fields per curve: `on: boolean`,
`scale: number` (default 1), `samples: number` (default 64, clamp 8..256).

## Deliverables
1. **`src/render/combPrefs.ts`** (new) — the prefs module described above
   (defaults off; load/save; `combFor(id)` accessor). Model: overlayPrefs.ts.
2. **`src/render/passes/combPass.ts`** (new) — for every visible curve object
   with comb `on`: sample `curvatureAt` at `samples` uniform domain parameters;
   each sample draws a comb LINE from the curve point along the principal
   normal, world length = `kappa * 0.35 * scale` (the Alias/Rhino porcupine:
   tooth length ∝ curvature), plus an ENVELOPE polyline connecting the teeth
   tips. Teeth + envelope in a readable accent color (pick from the wire/ribbon
   palette; teeth slightly transparent, envelope solid). Straight spans
   (kappa≈0 / zero normal) draw no tooth. Cache buffers keyed by (curve
   signature, scale, samples). Draw AFTER drawCurves with depth test on,
   blended, world-space (u_modelView pattern like curveEditPass).
3. **Renderer hook** (`src/render/Renderer.ts`): instantiate + draw the pass in
   every shading mode where drawCurves runs (same call sites). Keep the diff
   surgical — other workers may be editing other regions of this file.
4. **N-panel** (`src/ui/nPanel.ts`, Curve section): "Curvature Comb" subsection —
   On checkbox, Scale (0.01..100, scrub field), Samples (8..256). These write
   combPrefs (NOT undoable — display prefs, like overlay toggles; note in a
   comment). Only visible when the active object is a curve.
5. **`e2e/nurbs-combs.mjs`** (new): add a NURBS/bezier circle curve, enable the
   comb via the N-panel, screenshot → assert comb pixels present (the circle
   comb = a larger concentric ring of teeth; count accent-colored pixels
   OUTSIDE the curve's radius vs a comb-off screenshot). Scale slider doubles
   → pixel spread grows. Follow e2e harness + E2E_PORT conventions.
6. **Unit test** (`src/render/combPrefs.test.ts` or colocated): prefs
   defaults/clamps/persistence round-trip (localStorage mock pattern — see
   shadePrefs.test.ts).

## Screenshot evidence (mandatory — visual feature)
Save before/after comb screenshots to `research/nurbs-combs-{off,on}.png`; your
report must state the measured pixel counts.

## Out of scope / do-not-touch
InputManager.ts, surfaceTab.ts, tessellate.ts, surfaceNetPass.ts, addMenu.ts,
main.ts, objectData.ts, sceneJson.ts, core/nurbs/* (read-only).

## Acceptance
- tsc clean, full vitest green, `node e2e/nurbs-combs.mjs` green (unique
  E2E_PORT), curves.mjs still green, screenshots captured with pixel evidence.

If the spec conflicts with the code you find, STOP and report.
