# NB-C1 — Curves on surfaces: display, isoparm extraction, extract-to-3D, batch-C UI

## Context
Read FIRST:
- `src/core/scene/objectData.ts` — `SurfaceCurve` ({ name, curve }) on
  SurfaceData: a CurveData whose control points live in UV space [u, v, 0].
  Serialization already round-trips them (v21).
- `src/core/nurbs/surface.ts` — `isoCurve(s, dir, t)` (EXACT isoparm as an
  NCurve in 3D), `fromSurfaceData`, `surfaceDomain`, `surfacePoint`.
- `src/core/nurbs/curve.ts` — `fromCurveData`, `toCurveData`, `curvePoint`,
  `curveDomain`, `rebuildCurve`.
- `src/core/nurbs/trimOps.ts` — `addTrimFromSurfaceCurve`, `removeTrim`,
  `clearTrims`, `isClosedUvCurve` (ALREADY IMPLEMENTED — your Trims UI calls
  these).
- `src/core/nurbs/tessellate.ts` — `sampleUvLoop` (UV polyline sampling you can
  reuse for display).
- `src/render/passes/surfaceNetPass.ts` — current state (net + isoparms from
  NB-B3); you add the surface-curve display.
- `src/ui/surfaceTab.ts` — current state (Shape/Rebuild/Tessellation/Display
  sections); you add two sections.
- `src/core/undo/surfaceCommands.ts` — SurfaceCommand.
- `src/main.ts` `__app.surface` — extend if your e2e needs a helper (keep it
  read-only accessors; coordinate nothing else in main.ts).

## Deliverables
1. **`src/core/nurbs/cos.ts`** (new) — pure helpers:
   - `evalSurfaceCurve3D(data: SurfaceData, curve: CurveData, segs = 96):
     Vec3[]` — sample the UV curve, map each (u, v) through `surfacePoint`
     (clamp into the domain), → 3D polyline in the SURFACE's local space.
   - `isoparmSurfaceCurve(data: SurfaceData, dir: 'u'|'v', t: number):
     SurfaceCurve` — a degree-1 two-point UV LINE across the domain at t
     (u=t for 'u', v=t for 'v'), named "IsoU.NNN"/"IsoV.NNN" style (caller
     numbers it).
   - `extractSurfaceCurveToCurveData(data: SurfaceData, curve: CurveData):
     CurveData` — a standalone 3D curve approximating the on-surface curve.
     For EXACT isoparm lines (detectable: degree-1 two-point UV curve at
     constant u or v) use `isoCurve` → `toCurveData` (exact). General UV
     curves: sample 128 points through the surface map, fit via
     `rebuildCurve`-style interpolation (24 points, degree 3), document the
     approximation.
2. **Display** (`src/render/passes/surfaceNetPass.ts`): draw each
   `surfaceCurves` entry of a surface that is (a) in surface edit mode, or
   (b) has showNet or isoparms display on, or (c) is SELECTED in object mode —
   as a polyline via `evalSurfaceCurve3D`, in a distinct warm color (pick from
   the existing palette constants; must differ from net lines and isoparm
   lines). Slight depth pull toward the eye (the fractional viewPos trick used
   everywhere) so it sits on the surface without z-fighting. Cache by (surface
   signature — surfaceCurves are part of it — and display state).
3. **surfaceTab — "Surface Curves" section**:
   - List rows: name + ✕ delete (SurfaceCommand 'Delete Surface Curve').
   - "Add Isoparm": direction toggle U/V + param field 0..1 (mapped into the
     real domain) + Add button → appends `isoparmSurfaceCurve` (SurfaceCommand).
   - Per-row "Extract" button → creates a new scene CURVE object at the
     surface's world transform from `extractSurfaceCurveToCurveData`
     (AddObjectsCommand pattern — see how addMenu commits object adds).
4. **surfaceTab — "Trims" section**:
   - Per surface-curve row (in the section above): "Trim" + "Hole" buttons —
     enabled only when `isClosedUvCurve`; call `addTrimFromSurfaceCurve(data,
     i, hole)` via SurfaceCommand ('Trim Surface'); the tessellator + driver do
     the rest.
   - Trim list rows: "hole"/"keep" tag + "Untrim" (`removeTrim`) + a
     "Clear All" (`clearTrims`).
5. **Tests** `src/core/nurbs/cos.test.ts`:
   - isoparm SurfaceCurve at t maps through evalSurfaceCurve3D onto points that
     equal `surfacePoint(s, t, v)` samples ≤1e-9;
   - extract of an exact isoparm equals the surface samples ≤1e-9;
   - extract of a general diagonal UV curve stays within 1e-3 of true surface
     points;
   - trims round-trip through add/remove (payload equality).
6. **`e2e/nurbs-cos.mjs`**: sphere surface → add isoparm U at 0.5 via the tab →
   visible (screenshot pixel check, save research/nurbs-cos.png) → Extract →
   new curve object exists with ≥ 10 points → mark the isoparm... (isoparm
   lines aren't closed: also add a closed UV circle surfaceCurve via __app
   payload edit, Trim as hole → face count drops after sync).

## Out of scope / do-not-touch
tessellate.ts internals (NB-C3 owns trimmed tessellation), projectCurve.ts
(NB-C2), Renderer.ts, InputManager.ts, nPanel.ts, alignPopover.ts, combPass,
addMenu.ts, objectData.ts, sceneJson.ts, other core/nurbs files (read-only).
main.ts: only additive read-only accessors under `__app.surface` if needed.

## Acceptance
tsc clean; full vitest green; nurbs-cos.mjs + nurbs-tab.mjs + nurbs-isoparms.mjs
green (unique E2E_PORT); screenshot evidence with pixel counts.

If the spec conflicts with the code you find, STOP and report.
