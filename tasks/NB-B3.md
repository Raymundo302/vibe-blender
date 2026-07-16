# NB-B3 — Tessellation quality: true adaptive refinement + isoparm display

## Context
Read FIRST:
- `src/core/nurbs/tessellate.ts` — current tessellator: `tessParams` (spans +
  midpoint-bisection 'adaptive'), `tessellateSurface`, weld/dedup, v1 trim
  classification. YOUR file to improve.
- `src/core/nurbs/surface.ts` — `surfaceDerivs`, `surfaceNormal`, `isoCurve`.
- `src/render/passes/surfaceNetPass.ts` — built by NB-A2 (read its current
  state); you EXTEND it with isoparm lines.
- `src/ui/surfaceTab.ts` — built by NB-A3 (read current state); you extend its
  Display + Tessellation sections.
- `src/core/nurbs/nurbs.test.ts` — tessellation test style.

## Deliverables
1. **Adaptive tessellation upgrade** (`src/core/nurbs/tessellate.ts`):
   - Current probe uses 3 fixed cross-parameters; upgrade to probing at ALL
     current cross-direction params (capped at 9 evenly-chosen ones) so a
     feature localized off-center still triggers refinement.
   - Add NORMAL-deviation refinement: also split an interval when the surface
     normals at its ends deviate more than ~15° (cos < 0.966) at any probe —
     catches curvature the chord test misses on thin features.
   - Keep depth cap 5 and the segs floor. Deterministic (same payload → same
     grid).
   - Export `tessStats(data): { verts: number; faces: number; us: number; vs:
     number }` for the UI info row (compute WITHOUT building an EditableMesh
     twice — refactor so tessellateSurface and tessStats share the grid step).
2. **Isoparm display** (`src/render/passes/surfaceNetPass.ts` + surfaceTab):
   - New per-surface display toggle `showIsoparms` — add the field to the
     runtime DISPLAY prefs location that showNet uses… showNet lives in the
     PAYLOAD (objectData — do-not-touch). Instead: isoparms piggyback on
     showNet? NO — make isoparms an app-level pref in a tiny module
     `src/render/isoparmPrefs.ts` (per-object-id, localStorage; model:
     overlayPrefs/combPrefs).
   - When on for a surface object: draw the exact isoparametric curves at
     every DISTINCT interior knot + the 4 boundary curves, sampled via
     `isoCurve` + curve evaluation (~64 segments each), thin lines in a subtle
     grey-cyan, depth-tested, drawn wherever the net pass draws (object +
     edit mode).
   - surfaceTab Display section gains "Isoparms" checkbox next to Show Net.
   - Cache buffers by (surface signature, pref state).
3. **Tessellation info row** (surfaceTab): use `tessStats` — show "verts / faces
   (grid U×V)" updating live as tess fields change.
4. **Tests** (extend `src/core/nurbs/` tests in a NEW file
   `tessellate2.test.ts`):
   - a surface with one sharp localized bump off-center refines MORE cells near
     the bump than the old 3-probe scheme (assert face count increases vs
     mode 'spans' at the floor, and that refinement concentrates: cell count in
     the bump quadrant > other quadrants),
   - normal-deviation splitting triggers on a high-curvature ridge even when
     chord deviation is tiny (construct: thin S-fold),
   - tessStats matches the real tessellateSurface output counts,
   - determinism: two runs identical.
5. **`e2e/nurbs-isoparms.mjs`**: sphere surface, toggle isoparms in the tab →
   screenshot pixel-diff shows the iso lines (compare on/off captures; save to
   `research/nurbs-isoparms-{off,on}.png`); adaptive mode on the sphere yields
   more faces than spans-floor mode (via `__app` face counts).

## Out of scope / do-not-touch
Renderer.ts (the net pass is already hooked — extend the PASS, not the hook),
InputManager.ts, nPanel.ts, alignPopover/matching, combPass/combPrefs,
addMenu.ts, main.ts, objectData.ts, sceneJson.ts,
core/nurbs/{basis,curve,surface,edit,curveOps,primitives,matching}.ts
(read-only).

## Acceptance
tsc clean; full vitest green; nurbs-isoparms.mjs + nurbs-tab.mjs + nurbs-edit.mjs
green (unique E2E_PORT); screenshots with pixel evidence in your report.

If the spec conflicts with the code you find (e.g. surfaceNetPass shape differs
from what this expects), STOP and report.
