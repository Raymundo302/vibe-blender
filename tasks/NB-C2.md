# NB-C2 — Curve projection onto surfaces (closest-point + directional)

## Context
Read FIRST:
- `src/core/nurbs/surface.ts` — `projectPointToSurface` (multi-start Newton
  closest point — your workhorse), `surfaceDerivs`, `surfacePoint`,
  `surfaceDomain`, `fromSurfaceData`.
- `src/core/nurbs/curve.ts` — `fromCurveData`, `curvePoint`, `curveDomain`,
  `interpolateCurve`, `toCurveData`, `chordParams`.
- `src/core/scene/objectData.ts` — `SurfaceCurve` UV convention [u, v, 0].
- `src/core/scene/Scene.ts` — `worldMatrix(obj)`; `src/core/math/mat4.ts` for
  inverse/transform APIs.
- `src/core/undo/surfaceCommands.ts` — SurfaceCommand (the scene-level helper
  commits through it).

## Deliverables
1. **`src/core/nurbs/projectCurve.ts`** (new) — pure core:
   - `projectCurveToSurfaceUV(curve: NCurve-in-surface-local-space | sampled
     points, surface: NSurface, opts): CurveData | null` — design the exact
     signature; requirements:
     - Input: a 3D polyline OR curve payload ALREADY in the surface's local
       space (the scene-level wrapper below handles world/local transforms) +
       mode `'closest' | 'direction'` (+ `dir: Vec3` for direction, in surface
       local space).
     - Sample the source curve at ~128 parameters.
     - `'closest'`: per sample, `projectPointToSurface`.
     - `'direction'`: per sample, solve S(u,v) = P + t·d (3 eqs / unknowns
       u,v,t) by Newton seeded from the closest-point solution; a sample MISSES
       when Newton diverges or the residual ⊥ distance stays > 1e-4 — keep the
       longest contiguous run of hits (a projection that clips the surface edge
       still yields the on-surface part). < 8 hits → null.
     - Fit the UV samples: thin them (drop near-duplicates < 1e-6 apart in UV),
       `interpolateCurve` in UV (z = 0) at degree 3, then REBUILD to
       max(8, ceil(hits/8)) control points so the payload stays light. Return
       as CurveData (kind nurbs, explicit knots, resolution 12).
   - Domain-edge behavior: clamp UV samples into the domain (closest mode
     naturally clamps; keep monotone param order).
2. **Scene-level wrapper** (same file or `projectCurve.ts` exporting it):
   `projectCurveObjectToSurface(scene, curveObj, surfObj, opts): SurfaceCurve |
   null` — transforms the curve's evaluated polyline (use
   `evaluateCurve(curveObj.curve)` from core/curve/eval) through
   `scene.worldMatrix(curveObj)` → world → inverse of `worldMatrix(surfObj)` →
   surface local, then the core projection; names the result "Proj.NNN"
   (next free). DOES NOT mutate — returns the SurfaceCurve; the caller commits
   `SurfaceCommand.capture('Project Curve', …)` appending it.
3. **Tests** `src/core/nurbs/projectCurve.test.ts`:
   - Straight 3D line hovering over the flat default patch, closest mode → UV
     curve maps back through surfacePoint onto the vertical projection of the
     line ≤1e-6.
   - Directional projection straight down (-Z) onto a sphere (from above) →
     every fitted UV point maps to a 3D point whose (x, y) equals the source
     sample's (x, y) ≤1e-4 and z > 0 (upper hemisphere).
   - Directional projection that half-misses the patch (line extends past the
     edge) → returns the on-surface contiguous segment (endpoints inside the
     domain, no NaNs).
   - Fully-missing projection → null.
   - World-transform correctness: same geometry but the SURFACE object rotated
     90° (wrapper path with a mock scene) still projects onto the right spot
     (use a real Scene — it's cheap).
4. **NO UI.** The architect wires the button after batch C integrates
   (`surfaceTab` is owned by NB-C1 right now). Your deliverable is core +
   wrapper + tests only.

## Out of scope / do-not-touch
ALL ui/*, Renderer.ts, InputManager.ts, main.ts, tessellate.ts, cos.ts,
trimOps.ts, objectData.ts, sceneJson.ts, other core/nurbs files (read-only).

## Acceptance
tsc clean; full vitest green including yours. No e2e (pure core).

If the spec conflicts with the code you find, STOP and report.
