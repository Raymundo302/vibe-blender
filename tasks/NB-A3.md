# NB-A3 — Surface properties tab: degree, spans (rebuild), tessellation options, weights

## Context
The NURBS core landed. Read FIRST:
- `src/core/scene/objectData.ts` — `SurfaceData`, `SurfaceTess`, `clampSurfaceSegs`,
  `SURFACE_SEGS_MIN/MAX`. Grid convention: flat index `iu*pointsV + iv`.
- `src/core/nurbs/surface.ts` — `fromSurfaceData`, `toSurfaceFields`,
  `surfaceElevateU/V`, `rebuildSurface`, `surfaceInsertKnotU/V`, `surfaceDomain`.
- `src/core/undo/surfaceCommands.ts` — `SurfaceCommand.capture(name, obj, mutate)`;
  the driver re-tessellates automatically after payload changes.
- `src/ui/textTab.ts` — YOUR MODEL for a data tab (registerPropertiesTab pattern,
  build/update lifecycle, no-selection empty state). Also check how lightTab
  greys/updates when the active object isn't its kind.
- `src/core/scene/SurfaceEdit.ts` + `scene.surfaceEdit` — for the selected-point
  weight row.

## Deliverables
1. **`src/core/nurbs/edit.ts`** (new) — PURE payload transforms (unit-testable,
   no DOM). Each takes and returns `SurfaceData` (merge geometry fields via
   `toSurfaceFields`, preserve `tess`/`trims`/`surfaceCurves`/`showNet`):
   - `setSurfaceDegree(data, dir: 'u'|'v', degree: number): SurfaceData` —
     increase = EXACT `surfaceElevateU/V` (shape preserved); decrease = rebuild
     at the current point counts with the new degree (approximation, weights
     reset — document it). Clamp degree 1..(count-1) and 1..5.
   - `rebuildSurfaceData(data, pointsU, pointsV, degreeU, degreeV): SurfaceData`
     — `rebuildSurface` passthrough.
   - `insertSurfaceKnotAt(data, dir: 'u'|'v', t: number): SurfaceData` — exact
     span insert (adds a control row without changing shape) via
     `surfaceInsertKnotU/V` at parameter t.
2. **`src/ui/surfaceTab.ts`** (new), registered via `registerPropertiesTab`
   (icon suggestion: '◧', title 'Surface'). Sections:
   - **Shape**: Degree U / Degree V numeric steppers (apply via
     `SurfaceCommand.capture` + `setSurfaceDegree`). Info row: "Points: nu × nv,
     Spans: su × sv" (spans = distinct interior knot intervals; compute via
     `interiorKnots` from `src/core/nurbs/basis.ts`).
   - **Rebuild**: Points U, Points V, Degree U, Degree V number fields + a
     Rebuild button → `rebuildSurfaceData` (one undo step "Rebuild Surface").
   - **Insert Span**: two buttons "Insert U" / "Insert V" — insert a knot at the
     parametric midpoint of the LARGEST span in that direction (exact, shape
     preserved).
   - **Tessellation**: mode select (spans/adaptive), Segs U, Segs V
     (clamped via clampSurfaceSegs), Tolerance (adaptive only — hide/disable
     otherwise), and an info row with the current tessellation counts
     (`obj.mesh.verts.size` / `faces.size`). Live-apply each field through
     SurfaceCommand.capture (mirroring how textTab applies field edits).
   - **Display**: "Show Net" checkbox (`showNet` — NOT part of the driver
     signature, so it must not re-tessellate; verify it doesn't).
   - **Selected Point** (only while `scene.surfaceEdit` has a selection):
     Weight field (0.01..100) applying to ALL selected points via
     SurfaceCommand.capture("Point Weight").
   - Follow the app's field-scrub + dark-input conventions used by textTab.
3. **Register the tab**: add `import './ui/surfaceTab';` next to the textTab
   import in `src/main.ts` (line ~29). Touch NOTHING else in main.ts.
4. **`src/core/nurbs/edit.test.ts`** (new): shape-preservation for degree
   ELEVATE (sample before/after ≤1e-9) and knot insert; rebuild produces the
   requested counts/degrees; tess/trims/showNet fields survive every transform.
5. **`e2e/nurbs-tab.mjs`** (new, harness patterns): add a surface, open the
   Properties editor's Surface tab, drive Degree U 3→4 (point count grows,
   sampled shape preserved via `__app` mesh probe), Rebuild to 10×6 (counts
   verified in payload), switch tess segs (mesh face count changes after
   `__app.surface.sync()`).

## Out of scope
- Edit-mode interaction/net rendering (NB-A2), primitives (NB-A1), curve ops
  (NB-A4), curvature combs/isoparms (batch B).
- Do NOT touch: addMenu.ts, InputManager.ts, Renderer.ts, nPanel.ts,
  sceneJson.ts, objectData.ts, core/nurbs/{basis,curve,surface,tessellate}.ts.
  main.ts = the ONE import line only.

## Acceptance criteria
- `npx tsc --noEmit` clean; full `npx vitest run` green; `node e2e/nurbs-tab.mjs`
  green; `node e2e/smoke.mjs` still green.
- Degree elevation from the tab leaves the rendered shape IDENTICAL (your e2e
  proves it numerically by sampling mesh verts against the pre-op surface).

If the spec conflicts with the code you find, STOP and report.
