# NB-A4 — Curve degree / spans / knot-insert operations (N-panel)

## Context
The NURBS core landed. Read FIRST:
- `src/core/nurbs/curve.ts` — `fromCurveData`, `toCurveData`, `elevateDegree`,
  `insertKnot`, `rebuildCurve`, `curveDomain`, `curveDataDegree`. NOTE:
  `toCurveData` returns an OPEN nurbs payload with explicit knots.
- `src/core/scene/objectData.ts` — `CurveData` (now has optional `knots`;
  the evaluator honors them — see `evaluateNurbs` in `src/core/curve/eval.ts`).
- `src/core/undo/curveCommands.ts` — `CurveCommand.capture`.
- `src/ui/nPanel.ts` — the existing Curve section (~line 51,
  `curveResInput`, `curveOrderRow` etc.) — you EXTEND this section.
- `e2e/curves.mjs` — harness patterns for curve e2e.

## Deliverables
1. **`src/core/nurbs/curveOps.ts`** (new) — PURE payload transforms
   (CurveData → CurveData). Semantics:
   - `setCurveDegree(data, degree): CurveData` — clamp 1..5 and ≤ points-1.
     OPEN NURBS: increase = exact `elevateDegree`; decrease = `rebuildCurve`
     keeping the current point count. BEZIER or CYCLIC input: convert via
     rebuild (open result for bezier stays bezier-shaped but kind 'nurbs';
     cyclic input keeps `cyclic: true` with clamped-uniform knots — rebuild the
     wrapped polyline; document both). Preserve `resolution`.
   - `rebuildCurveData(data, pointCount, degree): CurveData` — via rebuildCurve
     (open) — cyclic input keeps cyclic flag (rebuild the closed shape:
     sample the closed loop, drop the duplicate end point, weights 1,
     clamped-uniform periodic-lite like presets).
   - `insertCurveKnotAt(data, u): CurveData` — OPEN nurbs only: exact
     `insertKnot` at u (shape preserved, +1 point, explicit knots in result).
     For bezier/cyclic: throw or return input unchanged with a documented
     reason (the UI disables the button there).
   - `largestSpanMid(data): number | null` — parametric midpoint of the widest
     knot span (for the Insert button target). Null when not applicable.
2. **N-panel Curve section extensions** (`src/ui/nPanel.ts`):
   - **Degree** stepper (shows `curveDataDegree(data)`, 1..5) — applies via
     `CurveCommand.capture('Curve Degree', …)` + `setCurveDegree`. For bezier
     curves show it disabled with tooltip "Bezier is cubic" UNLESS you convert —
     keep bezier disabled (conversion is a rebuild; users go through Rebuild).
   - **Rebuild** row: Points + Degree fields + Rebuild button →
     `rebuildCurveData` (one undo step).
   - **Insert Knot** button (enabled for open NURBS only) → insert at
     `largestSpanMid` (one undo step, point count +1, shape identical).
   - **Knots** info row: read-only display "knots: n (spans: m)" so degree/span
     state is visible.
   - Match the section's existing input/scrub styling and update() wiring.
3. **`src/core/nurbs/curveOps.test.ts`** (new):
   - degree elevate preserves shape (sample the evaluated polyline via
     `evaluateCurve` before/after, closest-point tolerance ≤1e-6),
   - insertKnotAt preserves shape exactly and bumps point count,
   - rebuild hits requested count/degree; cyclic stays cyclic (first/last
     evaluated points coincide),
   - resolution preserved through every op.
4. **`e2e/nurbs-curve-ops.mjs`** (new): add a NURBS curve (Shift+A menu or
   `__app` handle like curves.mjs does), open the N-panel, drive Degree 3→4
   (payload order becomes 5, polyline unchanged within tolerance), Insert Knot
   (+1 point, `knots` present), Rebuild to 12 points (count verified), undo
   steps back through each.

## Out of scope
- Surface anything (A1/A2/A3 own those files). Curvature combs (B1),
  G-matching (B2).
- Do NOT touch: addMenu.ts, InputManager.ts, Renderer.ts, surfaceTab.ts,
  main.ts, sceneJson.ts, objectData.ts, core/nurbs/{basis,curve,surface,
  tessellate,edit,primitives}.ts (read-only), core/curve/eval.ts.

## Acceptance criteria
- `npx tsc --noEmit` clean; full `npx vitest run` green;
  `node e2e/nurbs-curve-ops.mjs` + `node e2e/curves.mjs` green.

If the spec conflicts with the code you find, STOP and report.
