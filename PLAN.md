# PLAN.md — Task Registry & Architecture

> **This file is the source of truth for build state.** Every task has a status:
> `pending` / `spec-ready` / `built` / `verified` / `failed`. Workers update their own
> task's status when done; verify passes promote `built` → `verified`.
> Specs live in `tasks/<ID>.md` and are written **just-in-time** (after their
> dependencies exist, so they reference real code, not imagined shapes).

## Architecture Decisions (locked 2026-07-05)

| # | Decision | Rationale |
|---|----------|-----------|
| A1 | **Modal operator system** as the tool architecture | Blender's core insight: tools like G/R/S are *modal operators* — they capture input, show a preview, then confirm/cancel. One `Operator` interface powers every tool. This is THE load-bearing abstraction; Fable builds it. |
| A2 | **EditableMesh = BMesh-lite** (verts + edges + faces with adjacency maps) | Extrude/inset/loop-cut need edge/face adjacency queries. Full half-edge is overkill and error-prone for workers; adjacency maps rebuilt after topology edits are simple and fast at demo scale. |
| A3 | **GPU color-ID picking** for objects AND mesh elements | One picking pass handles everything (objects, verts, edges, faces, gizmo handles). No CPU ray-triangle code to get subtly wrong. |
| A4 | **Undo = per-command undo data; mesh ops snapshot the mesh** | Uniform `Command` interface. Topology ops deep-copy the mesh (cheap at demo scale, always correct). Transform ops store before/after. No fragile inverse-operation code. |
| A5 | **UI panels are DOM (HTML/CSS overlay), viewport is canvas** | Workers are productive in DOM immediately; only the 3D viewport needs WebGL. Blender-dark theme via CSS. |
| A6 | **Matcap shading** as the default viewport look | Blender's studio look with a single texture lookup — no lighting system needed until later. |
| A7 | **Renderer = thin GL wrappers + explicit passes** (grid, mesh, wireframe, overlay, picking) | No scene-graph magic. Each pass is a file a worker can own. |
| A8 | Build tool: **Vite + TypeScript strict**, zero runtime deps | Refresh-the-browser iteration; "from scratch" credibility. |

## Module Map

```
src/
  core/
    math/        vec3, mat4, quat, ray, transform     [Fable]
    mesh/        EditableMesh, primitives, mesh→GPU   [Fable core, Opus primitives]
    scene/       Scene, SceneObject, selection state  [Fable]
    undo/        Command, UndoStack                   [Fable]
    operator/    Operator interface, modal dispatch   [Fable]  ← A1
  render/
    gl/          context, Shader, VAO/Buffer wrappers [Fable]
    passes/      grid, mesh(matcap), wireframe,
                 overlay, picking                     [Opus]
  camera/        orbit camera (orbit/pan/zoom/focus)  [Fable]
  input/         mouse+keyboard → operator dispatch   [Fable]
  tools/         translate/rotate/scale, extrude,
                 inset, loop-cut, ...                 [Opus]
  ui/            outliner, properties, header, toasts [Opus]
  io/            OBJ import/export, scene JSON        [Opus]
```

## Task Registry

### Phase 0 — Core (Fable builds; defines every interface workers touch)
| ID | Task | Owner | Depends | Status |
|----|------|-------|---------|--------|
| P0-1 | Vite+TS scaffold, canvas, GL2 context, resize/DPR | fable | — | verified |
| P0-2 | Math lib: vec3/mat4/quat/ray + tests | fable | P0-1 | verified |
| P0-3 | GL wrappers: Shader, VAO/Buffer | fable | P0-1 | verified |
| P0-4 | EditableMesh (BMesh-lite) + cube + mesh→GPU upload | fable | P0-2 | verified |
| P0-5 | Orbit camera + perspective projection | fable | P0-2 | verified |
| P0-6 | Render loop: grid pass + matcap mesh pass — **default cube on screen** | fable | P0-3,4,5 | verified |
| P0-7 | Operator interface + modal input dispatch | fable | P0-6 | verified |
| P0-8 | Command/UndoStack + Ctrl-Z/Ctrl-Shift-Z | fable | P0-7 | verified |
| P0-9 | Picking pass (color-ID) + object click-select | fable | P0-6 | verified |

**Phase 0 exit criteria:** orbitable viewport, grid, matcap cube, click to select
(orange outline), one working modal operator (G translate) with undo.
**✅ Met 2026-07-05.** 18 unit tests + 12-check headless e2e (`node e2e/smoke.mjs`,
needs the dev server running — CDP-driven, no deps). Production build: 28.6 kB JS.

### Phase 1 — Object Mode (Opus batch; specs reference Phase 0 code)
| ID | Task | Owner | Depends | Status |
|----|------|-------|---------|--------|
| P1-1 | Primitives: plane, uv-sphere, cylinder, torus, ico-sphere | opus | P0-4 | verified |
| P1-2 | R rotate + S scale modal operators (axis-lock X/Y/Z, numeric input) | opus | P0-7,8 | verified |
| P1-3 | Transform gizmo (move arrows; picking-based handles) | opus | P0-9 | verified |
| P1-4 | Outliner panel (list, click-select, rename, delete, visibility) | opus | P0-9 | verified |
| P1-5 | Properties panel (live transform values, editable) | opus | P0-8 | verified |
| P1-6 | Add-menu (Shift-A), duplicate (Shift-D), delete (X) | opus | P1-1 | verified |
| P1-7 | Header bar: mode indicator, Blender-dark CSS theme | opus | P1-4 | verified |

**Phase 1 exit: ✅ all 7 tasks verified 2026-07-05** (workflow `p1-object-mode`: Opus
implement → adversarial verify per task; P1-4 needed one fix round — docked sidebar
shrank the canvas and broke viewport-space picking; fixed by floating the panel over
the viewport). 55 unit tests, 12/12 e2e checks. Notable seams built by Fable first:
object add/delete/rename undo commands, UiShell topbar/sidebar mounts.

### Phase 2 — Edit Mode (the "is it really Blender?" phase)
| ID | Task | Owner | Depends | Status |
|----|------|-------|---------|--------|
| P2-1 | Edit-mode state + vert/edge/face select (Tab, 1/2/3 keys) | fable | P0-9 | verified |
| P2-2 | Element picking pass (verts/edges/faces as ID colors) | opus | P2-1 | verified |
| P2-3 | G/R/S on selected elements (reuse P0-7 operators) | opus | P2-1 | verified |
| P2-4 | Extrude (E) — faces/edges, with modal drag | opus | P2-3 | verified |
| P2-5 | Inset (I) | opus | P2-4 | verified |
| P2-6 | Delete verts/edges/faces, merge verts | opus | P2-1 | verified |
| P2-7 | Loop cut (Ctrl-R) — quad-strip walk | fable | P2-2 | verified |
| P2-8 | Box select (B), select-all (A), invert | opus | P2-2 | verified |

**Phase 2 complete 2026-07-05.** 107 unit tests; `node e2e/edit.mjs` covers the
full edit loop (Tab, 1/2/3, click/shift/box select, G/R/S, E, I, X/M, Ctrl+R,
undo through everything). Workflow `p2-edit-mode`: 6 Opus implement+verify pairs,
0 fix rounds; P2-1/P2-7 by Fable.

### Phase 3 — Ship the Demo
| ID | Task | Owner | Depends | Status |
|----|------|-------|---------|--------|
| P3-1 | OBJ export + import | opus | P0-4 | verified |
| P3-2 | Scene save/load (JSON) | opus | P0-8 | verified |
| P3-3 | Shading modes: matcap / wireframe / flat+studio-light toggle | opus | P0-6 | verified |
| P3-4 | Shortcut cheat-sheet overlay, splash, polish pass | opus | P1-7 | verified |
| P3-5 | Static build + deploy (link for video description) | fable | all | verified |

## Dispatch Protocol (per batch)
1. Fable writes `tasks/<ID>.md` specs for the batch — exact file paths, interfaces to
   conform to, out-of-scope list, acceptance criteria the worker can self-check.
2. Workflow: implement (Opus, low/medium effort) → verify each against acceptance
   criteria + out-of-scope file-change check (high effort) → failures re-dispatched.
3. Workers append one line to `tasks/<ID>.md` on completion (`## Result`) and flip
   their status here. Every worker prompt includes: *"if the spec is ambiguous or
   wrong, stop and report rather than improvising."*
4. Fable reviews integration, commits the batch, updates this file, Notion checkpoint.

**Phase 3 complete 2026-07-05 — SHIPPED.** Live at
https://raymundo302.github.io/vibe-blender/ (source: https://github.com/Raymundo302/vibe-blender,
Pages from gh-pages branch, re-deploy = build + force-push dist). 126 unit tests,
3 e2e suites. Workflow `p3-ship-demo`: 4 Opus implement+verify pairs, 0 fix rounds.

### Phase 4 — Workspaces & Modifiers (night session 2026-07-05→06)
| ID | Task | Owner | Depends | Status |
|----|------|-------|---------|--------|
| P4-1 | Workspace/area system: tabs, switchable editors, viewport singleton swap, fullscreen, gutter resize, localStorage persistence | fable | — | verified |
| P4-2 | Modifier core: stack on SceneObject, evaluated-mesh cache, ModifierStackCommand/ApplyModifierCommand, renderer integration | fable | — | verified |
| P4-3 | Properties editor: vertical tab strip + Object tab (transform, rename, visibility) | opus | P4-1 | verified |
| P4-4 | Modifier tab UI (add/remove/toggle/apply/params) + sceneJson v2 with modifiers | opus | P4-2,3 | verified |
| P4-5 | Mirror + Array modifiers | opus | P4-2 | verified |
| P4-6 | Subdivision Surface modifier (Catmull-Clark) | opus | P4-2 | verified |

### Phase 5 — Modeling tools (night session)
| ID | Task | Owner | Depends | Status |
|----|------|-------|---------|--------|
| P5-1 | Edit-mode delete UX: Delete-key alias for X menu, dissolve verts/edges | opus | — | verified |
| P5-2 | Bridge edge loops (two selected loops → connecting quads) | opus | — | verified |
| P5-3 | Bevel edges (Ctrl+B, modal width) | opus | — | verified |
| P5-4 | F fill face, subdivide selection, frame selection (period) | opus | — | verified |

### Phase 6 — Polish & power tools (night session, cont.)
| ID | Task | Owner | Depends | Status |
|----|------|-------|---------|--------|
| P6-1 | Shade Smooth: per-vertex normals path, Object-tab toggle, scene persistence | fable | — | verified |
| P6-2 | N-panel: viewport overlay sidebar (N key) with item transform + dims | opus | — | verified |
| P6-3 | Per-object viewport color: color field, matcap tint + studio base color, Object tab picker | opus | — | verified |
| P6-4 | Autosave: localStorage every 30s + crash-restore prompt on boot | opus | — | verified |
| P6-5 | Proportional editing (O): falloff-weighted G/R/S in edit mode, wheel radius, circle overlay | opus | — | verified |
| P6-6 | Shortcut overlay + status-hint audit: every wired key listed, grouped | opus | — | verified |

### Phase 7 — Object management & precision (night session, cont.)
| ID | Task | Owner | Depends | Status |
|----|------|-------|---------|--------|
| P7-1 | Join objects (Ctrl+J): merge selected meshes into the active object, transforms baked | opus | — | verified |
| P7-2 | Separate selection (P): edit-mode selected faces → new object | opus | — | verified |
| P7-3 | Edge slide (GG): slide selected verts along adjacent rail edges | opus | — | verified |
| P7-4 | Grid snapping: Shift+Tab toggle + Ctrl-hold during G, topbar magnet indicator | opus | — | verified |
| P7-5 | Duplicate in edit mode (Shift+D): copy selected faces inside the mesh + ride G | opus | — | verified |

### Phase 8 — Camera, lights, materials & render engine (2026-07-06)
New architecture decisions:
| # | Decision | Rationale |
|---|----------|-----------|
| A9 | SceneObject.kind ('mesh'/'light'/'camera'); non-mesh kinds carry an EMPTY EditableMesh + a data payload | Every existing mesh code path no-ops on empty meshes — zero refactor risk. Lights/cameras get billboard icons + pick footprints instead of triangles. |
| A10 | Materials are a scene-level library; objects reference by id | Blender semantics (shared materials), trivial serialization, one uniform upload per draw. |
| A11 | Two render paths: 'rendered' viewport mode = forward PBR raster (Eevee-lite); F12 = progressive path tracer in a Web Worker (Cycles-lite) | The raster mode is interactive; the path tracer is the "we wrote a render engine" video moment and is pure TS (unit-testable, no GL). |

| ID | Task | Owner | Depends | Status |
|----|------|-------|---------|--------|
| F8-1 | Object kinds + LightData/CameraData/Material core, scene library, activeCamera lifecycle | fable | — | verified |
| F8-2 | RenderedPass (GGX, 8 lights) + collectLights + 4th shading mode + IconPass (billboards & picking) | fable | F8-1 | verified |
| F8-3 | Add-menu Light/Camera entries, kind-aware Scene.duplicate, worker stubs | fable | F8-1 | verified |
| P8-1 | Light properties tab (type/color/power/spot params, undoable) | opus | F8-3 | verified |
| P8-3 | Material properties tab (library slot UI + PBR params, undoable) | opus | F8-3 | verified |
| P8-4 | Render engine: progressive path tracer (F12, Web Worker, BVH, render window) | opus | F8-3 | verified |
| P8-2 | Camera objects: frustum display, Numpad0 view-through, Camera tab | opus | batch 1 | verified |
| P8-5 | Scene format v3 (lights/cameras/materials), outliner kind glyphs, join guard | opus | batch 1 | verified |

### Phase 9 — The Donut Gap (2026-07-06, see DONUT.md)
| ID | Task | Owner | Depends | Status |
|----|------|-------|---------|--------|
| F9-1 | ModifierContext (target-object modifiers), edge creases, face tints, SSS material fields, 'object' field kind | fable | — | verified |
| P9-1 | Solidify modifier, creased Subsurf, Merge by Distance | opus | F9-1 | verified |
| P9-2 | Shrinkwrap modifier + closest-point-on-mesh | opus | F9-1 | verified |
| P9-3 | Adjust-last-operation panel, parametric primitives, Circle | opus | F9-1 | verified |
| P9-4 | Tracer: soft shadows, SSS, depth of field (+ light radius, SSS UI) | opus | F9-1 | verified |
| P9-5 | Scatter modifier (sprinkles) + per-instance random tints | opus | F9-1 | verified |
| P9-6 | Loop select (Alt+click), X-ray select-through, Shift+N recalc normals, Shift+E crease, camera lock-to-view | opus | batch A | verified |
| P9-7 | Sculpt-lite: Inflate + Grab brushes | opus | P9-6 | verified |
| P9-8 | The donut dry run: scripted e2e builds the full donut, stage screenshots, final F12 render | opus | all | verified |

### Phase 10 — Collections, camera comfort, themes, world (2026-07-06)
| ID | Task | Owner | Depends | Status |
|----|------|-------|---------|--------|
| F10-1 | Theme system core (ThemeSpec registry, viewport palette plumbing, claude + default themes) + collections model (effectiveVisible everywhere, index serialization) | fable | — | verified |
| P10-1 | Collections UI: outliner groups, M move-to-collection, undo commands | opus | F10-1 | verified |
| P10-3 | Themes: tokenize css, six 90s themes from Ray's reference, picker UI | opus | F10-1 | verified |
| P10-4 | World: flat/gradient/HDRI environment (tab, rendered background, tracer sky) | opus | F10-1 | verified |
| P10-2 | Camera Lock-to-View + passepartout | opus | batch 1 | verified |

### Phase 11 — UVs (night build 2026-07-06→07, see tasks/P11-0-DESIGN.md)
| ID | Task | Owner | Depends | Status |
|----|------|-------|---------|--------|
| F11-1 | UV + seam mesh attributes, material texture fields, GPU/tracer UV plumbing | fable | — | verified |
| P11-1 | Ctrl+E seams + Unwrap/Smart Project/Project From View | opus | F11-1 | verified |
| P11-2 | UV Editor workspace pane | opus | F11-1 | verified |
| P11-3 | Checker/image textures in Rendered mode + tracer, Material tab rows | opus | F11-1 | verified |
| P11-4 | UV dry run: unwrap + checker the donut icing | opus | P11-1..3 | verified |
| P11-5 | Modifiers preserve UVs (dry-run gap fix) | opus | P11-4 | verified |

### Phases 12–15 — planned 2026-07-07 (night-build queue)
New architecture decisions:
| # | Decision | Rationale |
|---|----------|-----------|
| A12 | **3D cursor = scene-level state** (position, optional rotation later); overlay-drawn; used as Add-location and optional pivot | One field on Scene, serialized in sceneJson; every consumer (add menu, snap menu, pivot option) reads the same source. |
| A13 | **Parenting = `parentIndex` on SceneObject** (serialized as index, like activeCamera); world = parentWorld × local; cycle-guarded | Index serialization already proven byte-stable (P8-5). Transform inheritance is THE seam animation (P15) rides on — Fable builds it. |
| A14 | **Shader nodes evaluate in TS to a per-material sampler** shared by tracer + baked-to-texture for the Rendered raster path | One evaluator, two consumers; no GLSL codegen (fragile for workers). Graph data model + compiler = Fable; node UI + individual nodes = Opus. |
| A15 | **Animation = FCurves** (channelPath + keyframe list + interpolation) stored per-object; a sampler applies scene time before each frame; timeline is a workspace pane | Same pane pattern as UV editor; channelPath strings ("location.x", "data.power") extend to lights/materials without new schema. |

### Phase 12 — Cursor, pies, overlays & parenting
| ID | Task | Owner | Depends | Status |
|----|------|-------|---------|--------|
| F12-1 | 3D cursor core: scene state, Shift+RightClick place (raycast to surface/grid), overlay crosshair, Add-at-cursor, pivot option, sceneJson | fable | — | verified |
| F12-2 | Parenting core: parentIndex, world-matrix inheritance, cycle guard, Ctrl+P (keep transform) / Alt+P (clear, keep transform), undo cmds, serialization | fable | — | verified |
| P12-1 | Radial pie-menu component (generic, keyboard+mouse) + Shift+S snap pie: Cursor→Selected, Cursor→Origin, Selection→Cursor, Cursor→Grid | opus | F12-1 | verified |
| P12-2 | Overlays dropdown (header): toggle grid, axes, origin points, light/camera icons, wireframe-on-shaded, 3D cursor; persisted | opus | F12-1 | verified |
| P12-3 | Outliner parent hierarchy: indent children, drag-to-parent, Ctrl+P/Alt+P menu entries | opus | F12-2 | verified |

### Phase 13 — Texture depth & image viewer
| ID | Task | Owner | Depends | Status |
|----|------|-------|---------|--------|
| F13-1 | Material map slots (normal/bump + roughness maps): fields, GPU uniforms/samplers, tracer hooks, sceneJson bump | fable | — | verified |
| P13-1 | Bump/normal mapping in Rendered pass + tracer (tangent-space normal maps, height→normal for bump, strength slider, Material tab rows) | opus | F13-1 | verified |
| P13-2 | Image Viewer workspace pane: view material images + last F12 render, zoom/pan, fit, pixel inspect, open-image button | opus | — | verified |
| P13-3 | Material tab map-slot UI (normal/bump/rough/metal file inputs, strength, raw decode caches) | opus | F13-1 | verified |

### Phase 14 — Node-based shader editor
| ID | Task | Owner | Depends | Status |
|----|------|-------|---------|--------|
| F14-1 | Node graph core: data model (nodes/sockets/links, typed), TS evaluator → material sampler, bake-to-texture bridge for Rendered, sceneJson v(next), cycle guard | fable | F13-1 | verified |
| P14-1 | Shader Editor workspace pane: canvas graph UI — drag nodes, wire sockets, box select, Shift+A add-node menu, delete, pan/zoom | opus | F14-1 | verified |
| P14-2 | Starter node set A: Principled BSDF (output), Image Texture, Checker, Mix Color, RGB, Value | opus | F14-1 | verified |
| P14-3 | Starter node set B: Noise, ColorRamp, Bump, Mapping/UV input, MixFloat | opus | P14-2 | verified |
| P14-4 | Node dry run e2e: build a noise-driven donut-icing material via public entry points, F12 proof render | opus | P14-1..3 | verified |

### Phase 15 — Animation
| ID | Task | Owner | Depends | Status |
|----|------|-------|---------|--------|
| F15-1 | Animation core: FCurve/Keyframe model, channelPath resolver, scene time + sampler (applied pre-frame through parent hierarchy), I-key insert cmds, sceneJson | fable | F12-2 | verified |
| P15-1 | Timeline workspace pane: playhead, scrub, frame range, keyframe diamonds per selected object, spacebar play/pause | opus | F15-1 | verified |
| P15-2 | Interpolation: constant/linear/bezier (auto handles), per-key setting, evaluation tests | opus | F15-1 | verified |
| P15-3 | Keyframe editing: move/delete keys in timeline, auto-key toggle, K insert menu (Location/Rotation/Scale/All) | opus | P15-1 | verified |
| P15-4 | Animate beyond transforms: light power/color + material base color via channelPath, camera fly-through demo e2e | opus | P15-2 | verified |

**Sequencing:** 12 → 13 → 14 → 15. Parenting (F12-2) is a hard prereq for animation
sampling through hierarchies; bump/map plumbing (F13-1) is the seam node outputs
plug into. P14 and P15 are each ~Phase-8-sized — budget-cap per phase and let the
task registry carry resume state if credits run out mid-night.
