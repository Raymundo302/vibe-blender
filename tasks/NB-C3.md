# NB-C3 — Real trimmed tessellation (v2: refined boundary + edge snapping)

## Context
Read FIRST:
- `src/core/nurbs/tessellate.ts` — YOUR file. Current trim handling is the
  documented v1: whole-cell corner classification (`uvKept`, `sampleUvLoop`,
  the loops check inside `tessellateSurface`). Keep the public API
  (`tessellateSurface`, `tessParams`, `sampleUvLoop`, `pointInLoop`, `uvKept`,
  `tessStats` if NB-B3 added it) — you change the INTERNALS of the trimmed
  path.
- `src/core/nurbs/trimOps.ts` — how loops get created (closed UV curves).
- `src/core/nurbs/nurbs.test.ts` + `tessellate2.test.ts` (if NB-B3 landed it)
  — existing tessellation tests MUST keep passing.
- `src/core/mesh/EditableMesh.ts` — addVert/addFace/setFaceUVs.

## The v2 algorithm (spec'd; deviate only with numeric justification)
For a surface WITH trims:
1. Build the untrimmed grid params (us, vs) as today (spans/adaptive modes).
2. Sample each trim loop DENSELY: `sampleUvLoop(curve, 256)` (closed —
   first == last; drop the duplicate).
3. Classify each grid CELL by its 4 corners + center via `uvKept`:
   - all 5 kept → emit the quad as today;
   - all 5 discarded AND no loop segment crosses the cell → skip;
   - otherwise BOUNDARY: recursively subdivide the cell in UV (2×2) down to
     depth 3 (=> 8×8 sub-cells); a sub-cell at max depth is kept iff its
     CENTER is kept.
4. **Edge snapping** (kills the stair-step): every kept max-depth sub-cell
   corner that lies within one sub-cell diagonal of a loop polyline gets
   SNAPPED in UV onto the nearest point of that polyline (nearest point on the
   sampled segments). Snap in UV; evaluate 3D positions AFTER snapping so
   the mesh edge rides the true trim curve. Never snap two corners of the same
   sub-cell onto positions that invert it (guard: skip a snap that makes the
   sub-cell's UV area ≤ 0 / degenerate; drop degenerate faces like the pole
   dedup does).
5. Sub-cell verts weld with the same exact-position weld the grid uses; UVs =
   normalized domain coords as today (post-snap coords).
6. Untrimmed surfaces: BIT-IDENTICAL output to today (guard with a test that
   compares full serialization of a tessellated untrimmed mesh before/after
   your change — write it against the CURRENT code first).

Determinism required (same payload → same mesh, no randomness).

## Deliverables
1. The v2 trimmed path in `tessellate.ts` (internals; public API unchanged).
2. **Tests** (`src/core/nurbs/trimTess.test.ts`):
   - untrimmed bit-identity (above);
   - circle hole (the closed UV loop from trimOps' shape) in the flat patch:
     (a) no face's center is inside the hole; (b) hole EDGE SMOOTHNESS — for a
     dense sampling of the loop polyline, the nearest boundary-mesh vert in UV
     is ≤ 1.5 sub-cell diagonals away (proves snapping engaged); (c) total kept
     UV area within 3% of (domain − circle area);
   - outer (keep-inside) loop: kept area within 3% of the circle area;
   - two holes don't interact (counts additive within tolerance);
   - degenerate guard: a hole entirely outside the domain changes nothing.
3. **`e2e/nurbs-trim.mjs`**: flat patch + circular hole trim (payload via
   __app), sync → screenshot: the hole is VISIBLE (background pixels inside the
   projected hole region), edge looks round — measure: sample 16 angles, the
   transition radius variance < a sub-cell size. Save
   `research/nurbs-trim.png`. Also assert the tracer path doesn't crash: run a
   low-spp F12 snapshot if the harness has a helper (skip gracefully if not).

## Out of scope / do-not-touch
surfaceNetPass.ts, surfaceTab.ts, cos.ts, projectCurve.ts, trimOps.ts,
Renderer.ts, InputManager.ts, main.ts, ui/*, objectData.ts, sceneJson.ts,
other core/nurbs files (read-only).

## Acceptance
tsc clean; full vitest green (yours + the existing tessellation tests
UNMODIFIED — if one legitimately must change, explain why in the report);
nurbs-trim.mjs green (unique E2E_PORT); screenshot evidence.

If the spec conflicts with the code you find, STOP and report.
