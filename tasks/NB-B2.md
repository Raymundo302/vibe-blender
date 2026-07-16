# NB-B2 — G0/G1/G2/G3 curve-end continuity matching (Align tool)

## Context
Read FIRST:
- `src/core/nurbs/curve.ts` — `fromCurveData`, `toCurveData`, `curveDerivs`,
  `curvatureAt`, `curveDomain`, `elevateDegree`, `rebuildCurve`.
- `src/core/nurbs/basis.ts` — `dersBasisFuns` (end-derivative ↔ control-point
  relations come from evaluating this at the domain end).
- `src/core/undo/curveCommands.ts` — `CurveCommand`.
- `src/input/InputManager.ts` — how operators/keys dispatch (you add a binding).
- `src/ui/popover.ts` + `src/ui/pieMenu.ts` — existing floating-UI helpers; use
  whichever fits for the small Align dialog.

## The math (core deliverable)
**`src/core/nurbs/matching.ts`** (new): `matchCurveEnd(src: CurveData, srcEnd:
'start'|'end', target: CurveData, targetEnd: 'start'|'end', level: 0|1|2|3):
CurveData`.

Recipe (open, clamped NURBS; convert bezier via fromCurveData; if src is cyclic
or has non-uniform weights, REBUILD it first with rebuildCurve(keeping count,
degree ≥ level+1 — document); elevate degree if p < level+1 so enough control
points are free):
1. Evaluate the TARGET end: point Q, unit tangent T̂ (oriented to flow ACROSS
   the join: if srcEnd meets targetEnd head-on, flip so the curves continue
   smoothly, not fold back), curvature vector K = κ·N̂, and for G3 the
   arc-length derivative dK/ds (finite-difference K at two nearby parameters
   mapped through ds = |C'|du).
2. Preserve the SRC end speed m = |C'_src(end)| (minimizes shape disturbance).
   Construct desired END DERIVATIVES for src:
   - D1 = m·T̂
   - D2 (G2): the parameter-space second derivative whose NORMAL component
     realizes K at speed m: D2 = m²·K + (original D2's tangential component
     projected onto T̂). (κ depends only on the normal component.)
   - D3 (G3): m³·dK/ds + Frenet chain-rule corrections of lower order; keep
     src's original tangential/binormal residuals where they don't affect
     d(κN̂)/ds. Derive carefully; the numeric acceptance below is the referee.
3. At the src end, C^(k) is a LINEAR combination of the last (first) k+1
   control points with coefficients from `dersBasisFuns` at the end parameter.
   Solve the triangular system top-down: G0 sets the end point, G1 solves the
   next point from D1, G2 the next from D2, G3 the next from D3. Weights stay 1
   (non-rational after the rebuild guard).
4. Return the modified payload (explicit knots preserved via toCurveData).

## Numeric acceptance (the tests that matter — write them first)
**`src/core/nurbs/matching.test.ts`**: for a pair of wavy open cubics at every
level:
- G0: |src(end) − target(end)| < 1e-9
- G1: unit tangents (flow-oriented) dot > 1 − 1e-9
- G2: |K_src − K_target| < 1e-6 · max(1, |K_target|)
- G3: |dK/ds_src − dK/ds_target| < 1e-3 · max(1, |dK/ds_target|)
  (compute both sides by the same finite-difference scheme)
- Each level also satisfies all lower levels.
- The far end of src (opposite the join) moves < 1e-9 (only the near control
  points changed).
- Matching a bezier src works (through the documented conversion).

## UI
- **Trigger**: object mode, exactly two curve objects selected → key `M`
  handled in InputManager (guard: doesn't collide with the existing M
  collection-move binding — CHECK what M does in object mode today; if taken,
  use Shift+M and document). Opens a small popover: Level select (G0–G3),
  "Src end" (start/end/auto-nearest), "Target end" (start/end/auto-nearest,
  auto = closest endpoint pair), Apply. ACTIVE object = the curve that MOVES
  (Blender convention: active is modified toward the other).
- Apply via `CurveCommand.capture('Align G'+level, …)` — single undo step.
- **`src/ui/alignPopover.ts`** (new) — own the dialog here.
- Status-bar hint line while open.

## e2e
**`e2e/nurbs-align.mjs`**: build two separated curves via __app, select both,
trigger the popover (dispatch the key), apply G1; assert endpoint + tangent
continuity numerically from the payloads; undo restores.

## Out of scope / do-not-touch
nPanel.ts, Renderer.ts, surfaceTab.ts, tessellate.ts, combPass/combPrefs,
addMenu.ts, main.ts, objectData.ts, sceneJson.ts,
core/nurbs/{basis,curve,surface,tessellate,edit,curveOps,primitives}.ts
(read-only).

## Acceptance
tsc clean; full vitest green (incl. your matching tests); nurbs-align.mjs +
curves.mjs green on a unique E2E_PORT.

If M-in-object-mode is already bound or anything conflicts, STOP and report.
