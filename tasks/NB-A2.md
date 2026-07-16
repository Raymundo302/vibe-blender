# NB-A2 — Surface edit mode: Tab entry, control-net display, point select + G move

## Context
The NURBS core landed. Read FIRST:
- `src/core/scene/SurfaceEdit.ts` — `SurfaceEditState` (selection by FLAT point
  index `iu*pointsV + iv`). Already on Scene: `scene.surfaceEdit`,
  `scene.enterSurfaceEdit(id)`, `scene.exitSurfaceEdit()`, `scene.surfaceEditObject`.
- `src/core/undo/surfaceCommands.ts` — `SurfaceCommand.capture/fromSnapshots`.
  The surface DRIVER re-tessellates the mesh automatically after any payload
  change (`src/tools/surfaceObject.ts`) — you never rebuild meshes yourself.
- The CURVE edit system is your model, mirror it closely:
  - Tab entry branch: `src/input/InputManager.ts` ~line 1291 (`kind === 'curve'` →
    `enterCurveEdit`). Add the surface branch NEXT TO it.
  - Point picking + selection: find how curve control points are click-picked in
    InputManager (screen-space projection distance) and mirror for the net.
  - `src/tools/curveMove.ts` (`CurveMoveOperator`) — your `SurfaceMoveOperator`
    model, incl. how it snapshots payload before/after and commits a command.
  - `src/render/passes/curveEditPass.ts` — your render-pass model (shader,
    caching by (payload signature, selection.version), draw order).
- `src/main.ts` `__app.surface` handle: `editing()`, `selectPoint(i)`, `selection()`,
  `pointCount()`, `sync()` — already exposed for your e2e.

## Deliverables
1. **Tab entry** (`src/input/InputManager.ts`): active object kind 'surface' →
   `scene.enterSurfaceEdit(...)`, status hint "Surface Edit — click points, G: move,
   Tab/Esc: exit". Tab/Esc inside surface edit exits it. Do not break the
   existing mesh/curve/text branches.
2. **`src/render/passes/surfaceNetPass.ts`** (new): draws for the surface being
   edited — and for any surface object with `surface.showNet` in object mode —
   (a) the control net hull lines (grey, both directions: rows iu=const and
   columns iv=const), (b) control-point dots (white; selection orange, same
   constants as curveEditPass). Cache buffers by (surface signature,
   selection version). Hook it into `src/render/Renderer.ts` where
   `curveEditPass` is drawn (find its draw call and mirror the wiring).
3. **Click select** in surface edit mode: click picks the nearest net point
   within the same pixel threshold curve edit uses; Shift+click toggles;
   click empty space deselects (mirror curve edit behavior exactly).
   Box select (B) over net points if curve edit supports it — mirror; if it
   doesn't, skip.
4. **`src/tools/surfaceMove.ts`** (new): `SurfaceMoveOperator` — G moves the
   selected net points (mirror CurveMoveOperator: axis locks X/Y/Z, numeric
   input if curveMove has it, Esc cancel restores snapshot, commit =
   `SurfaceCommand.fromSnapshots('Move Points', …)`). Wire the G key in surface
   edit mode in InputManager next to `startCurveMove()`.
5. **`e2e/nurbs-edit.mjs`** (new, follow `e2e/curves.mjs` harness patterns +
   `E2E_PORT` convention): checks —
   - add a surface via `__app` scene handle (or the Add menu), Tab enters
     surface edit (`__app.surface.editing()` true),
   - `selectPoint(5)` then a scripted G-move (drive the operator like curves.mjs
     drives curve moves) displaces `surface.points[5].co`,
   - the tessellated mesh CHANGED after `__app.surface.sync()` (vert position
     delta), undo restores both payload and mesh,
   - Tab exits.

## Out of scope
- Weight editing UI (NB-A3's tab), degree/spans (NB-A3), primitives (NB-A1).
- Do NOT touch: addMenu.ts, nPanel.ts, surfaceTab.ts, main.ts, sceneJson.ts,
  objectData.ts, core/nurbs/* (read-only for you).

## Acceptance criteria
- `npx tsc --noEmit` clean; full `npx vitest run` green.
- `node e2e/nurbs-edit.mjs` green; `node e2e/curves.mjs` + `node e2e/edit.mjs`
  still green (you touched their input paths).
- The net is VISIBLE: capture a screenshot via the e2e harness of a surface in
  edit mode showing dots + hull lines (save to `research/nurbs-net.png`), and
  confirm non-trivially (pixel-count the orange/white dots region, don't just
  "file exists").

If the spec conflicts with the code you find, STOP and report.
