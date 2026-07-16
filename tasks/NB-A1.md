# NB-A1 — NURBS surface primitives + Add ▸ Surface menu

## Context
The NURBS core landed (commit "NB-CORE"). Read these files FIRST — your code must
conform to them, not to imagined shapes:
- `src/core/scene/objectData.ts` — `SurfaceData`, `SurfacePoint`, `defaultSurfaceTess()`,
  `defaultSurfaceData()`. Grid convention: `points` flat index = `iu*pointsV + iv`
  (iu along U, iv along V).
- `src/core/nurbs/surface.ts` — `fromSurfaceData`, `surfacePoint`, `surfaceDomain`
  (use these in your tests to verify exactness).
- `src/core/scene/Scene.ts` — `scene.addSurface(name, data)` (already exists).
- `src/ui/addMenu.ts` — the `Curve ▸` category (`this.category('Curve', …)` +
  `addCurve`) is your integration model; `commitAdd` handles cursor spawn.
- `src/core/nurbs/nurbs.test.ts` — test style to match.

## Deliverables
1. **`src/core/nurbs/primitives.ts`** (new) — pure builders returning `SurfaceData`
   (weights + knots EXACT rational quadrics, not approximations). World is Z-up;
   axis of revolution = Z; centered at origin (matching mesh primitives in
   `src/core/mesh/primitives.ts`).
   - `surfPatch(size = 2)` — 4×4 bicubic flat XY plane (reuse/replicate
     defaultSurfaceData without the bump).
   - `surfSphere(radius = 1)` — exact rational sphere: 9-point full circle
     (degree 2, knots [0,0,0,¼,¼,½,½,¾,¾,1,1,1], weights alternating 1, √2/2)
     in one direction × 5-point half-circle arc (degree 2, knots
     [0,0,0,½,½,1,1,1], weights [1,√2/2,1,√2/2,1]) pole-to-pole in the other.
     Net weights = product of the two arc weights.
   - `surfCylinder(radius = 1, depth = 2)` — 9-point circle × 2 linear rows
     (degree 1 in the axis direction), z from -depth/2 to +depth/2.
   - `surfCone(radius = 1, depth = 2)` — 9-point circle rim at z=-depth/2 ×
     apex row (all points at (0,0,+depth/2)); degree 1 axis direction. The apex
     row collapses — the tessellator welds it (already handled).
   - `surfTorus(major = 1, minor = 0.25)` — 9-point circle × 9-point circle,
     weights = product.
   - Set `tess: defaultSurfaceTess()` on all; explicit `knotsU`/`knotsV` for the
     circle directions (the clamped-uniform default is NOT the circle vector).
2. **Add menu**: a `Surface ▸` category between `Curve` and whatever follows it,
   entries: Patch, Sphere, Cylinder, Cone, Torus. Mirror `addCurve` exactly
   (spawn at cursor, undoable AddObjectCommand path, auto-name "Sphere",
   "SurfPatch"… follow how curve names are built).
3. **`src/core/nurbs/primitives.test.ts`** (new) — closed-form exactness:
   - Sphere: sample `surfacePoint` on a ≥12×12 param grid → every point at
     distance `radius` from origin within 1e-9.
   - Cylinder: every sample at horizontal radius `radius`, |z| ≤ depth/2 + 1e-9.
   - Torus: every sample at distance `minor` from the major circle (distance
     from the ring `sqrt((hypot(x,y)-major)² + z²) == minor`) within 1e-9.
   - Cone: samples on straight lines rim→apex (interpolate: horizontal radius
     shrinks linearly with z) within 1e-9.
   - Patch: flat (z == 0 everywhere), spans ±size/2.

## Out of scope
- Surface edit mode, properties tab, tessellation UI (other NB-A tasks).
- Do NOT touch: sceneJson.ts, objectData.ts, main.ts, Renderer.ts,
  InputManager.ts, nPanel.ts, any file another task owns.

## Acceptance criteria (self-check before reporting)
- `npx tsc --noEmit` clean; `npx vitest run src/core/nurbs` all green.
- `npx vitest run` — full suite untouched/green.
- Add menu shows Surface ▸ with the 5 entries; each spawns a visible shaded
  object (verify via `node e2e/smoke.mjs` still passing; a dedicated e2e is the
  verifier's job, not yours).

If this spec conflicts with what you find in the code, STOP and report the
conflict rather than improvising.
