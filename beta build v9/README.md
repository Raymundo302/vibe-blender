# Beta Build V9 — "the NURBS build" (frozen 2026-07-16)

The state at the end of NURBS day: surfaces as a first-class object kind.

- NURBS core: basis/derivatives, rational curves + surfaces, knot insertion,
  degree elevation (A5.9), rebuild, closest-point projection (The NURBS Book)
- Primitives: patch / sphere / cylinder / cone / torus (exact rational quadrics)
- Surface edit mode: control net, click/shift select, G with axis locks, weights
- Surface tab: degree U/V, rebuild, insert span, tessellation (spans/adaptive),
  isoparms, surface curves, trims, projection
- Curves: degree/rebuild/insert knot, curvature combs, G0-G3 align (Shift+M)
- Trimming: curves-on-surface -> trim loops, boundary-snapped tessellation
- IGES 5.3 import/export (File menu): entities 126/128/142/144

Launch: ./launch.sh (port 5390)
