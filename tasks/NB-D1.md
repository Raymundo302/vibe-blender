# NB-D1 — IGES import + export (one worker owns both directions)

## Context
Read FIRST:
- `src/io/obj.ts` — the io-module model: pure string↔scene functions, axis
  conventions documented, deterministic number formatting, unit-tested.
- `src/core/nurbs/curve.ts` (`fromCurveData`, `toCurveData`) and
  `src/core/nurbs/surface.ts` (`fromSurfaceData`, `toSurfaceFields`) — IGES
  entities map through these.
- `src/core/scene/objectData.ts` — `CurveData` (explicit `knots`!),
  `SurfaceData` (knotsU/V, `trims` TrimLoop[] in UV space, defaultSurfaceTess).
- `src/core/scene/Scene.ts` — addCurve/addSurface; `scene.worldMatrix(obj)`.

## Scope
**`src/io/iges.ts`** (new, pure — no DOM) exporting:
- `exportIges(scene: Scene): string`
- `importIges(text: string, scene: Scene): { curves: number; surfaces: number;
  skipped: Map<number, number> /* entity type → count */ }`

### Export
- Fixed 80-column format, sections S/G/D/P/T with correct sequence numbers and
  column-73 section letters. Global (G) section: comma/semicolon delimiters,
  sensible defaults (units 6 = metres to match world units ≈ m, model space
  scale 1), Hollerith strings (nHtext).
- For every VISIBLE curve object → **entity 126** (Rational B-Spline Curve):
  degree, knots, weights, control points. WORLD TRANSFORM BAKED into control
  points (`scene.worldMatrix(obj)` applied; no 124 transform entities —
  document). Bezier payloads convert exactly via `fromCurveData` → 126.
  Cyclic curves: export the wrapped periodic-lite NCurve exactly as
  `fromCurveData` builds it (closed shape preserved; PROP2 closed flag set).
- For every VISIBLE surface object → **entity 128** (Rational B-Spline
  Surface), world transform baked. If the surface has `trims`: also emit the
  trim structure — **142** (Curve on Parametric Surface) per loop with the UV
  curve as a 126 in PARAMETER space (B-rep pointerwise per spec: 142 refs the
  128 + the parameter-space 126), and a **144** (Trimmed Surface) tying them
  (outer loop = the non-hole loop if present, else the domain boundary N1=0;
  holes as inner loops).
- Deterministic output: same scene → byte-identical file (fixed float
  formatting, e.g. up to 9 significant digits, no locale).

### Import
- Parse S/G/D/P robustly: 80-col slicing, D-entry pairs (two 8-field lines),
  parameter data pointer/line counts, G-section delimiters (respect custom
  ones), Hollerith strings skipped correctly.
- Supported: **126** → CurveData (kind 'nurbs', explicit knots, weights;
  degree→order); **128** → SurfaceData (explicit knotsU/V, weights, tess =
  defaultSurfaceTess()); **144/142** → trims on their 128 (parameter-space 126
  → TrimLoop.curve, hole/outer from the 144 structure; MODEL-space-only 142s:
  project is out of scope — skip that loop with a count); **110** (line) →
  degree-1 2-point CurveData; **100** (circular arc, lives in the 124
  transform's XY plane) → exact rational arc CurveData; **124** transforms
  APPLIED to the geometry of entities referencing them; **102** (composite
  curve) → one CurveData per member (do not merge; name them .001…). Everything
  else → counted in `skipped`, never throws.
- Status-flag handling: skip entities whose D status marks them as dependents
  of a 144/142 you already consumed (don't double-import trim curves as
  standalone curves).
- Objects named from the D-entry label when present, else "Iges<Type>.NNN".

### Wiring — NONE
Do NOT touch topbar.ts or main.ts — the File-menu buttons are the architect's
integration step. Your deliverable is the pure module + tests.

## Tests — `src/io/iges.test.ts` (new)
- **Round trip**: build a scene with (a) a wavy open NURBS curve with explicit
  knots + mixed weights, (b) a bezier curve, (c) a rational sphere-like surface
  patch with weights, (d) a trimmed surface (hole loop). exportIges → importIges
  into a fresh scene → for each pair, SAMPLE geometry (evaluateCurve /
  surfacePoint grids) and compare ≤1e-6. Trim loop count + hole flags survive.
- **Format lint**: every line exactly 80 chars, section letters in col 73,
  sequence numbers monotonically increasing per section, T-section totals
  correct.
- **Foreign fixture**: a small HAND-WRITTEN IGES fixture string in the test
  (one 126 curve + one 128 surface with known control points, standard
  delimiters) imports to the expected geometry — this guards against
  "exporter+importer share the same wrong assumption" symmetry bugs. Use the
  IGES 5.3 spec layout; keep the fixture minimal but byte-faithful.
- **Skip behavior**: a file with an unsupported entity (e.g. 314 color) imports
  the rest and reports it in `skipped`.

## Out of scope / do-not-touch
topbar.ts, main.ts, addMenu.ts, InputManager.ts, Renderer.ts, all ui/*, all
render/*, objectData.ts, sceneJson.ts, core/nurbs/* (read-only).

## Acceptance
tsc clean; full vitest green incl. iges.test.ts; no e2e required (pure module).

If the spec conflicts with the code you find, STOP and report.
