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
| P6-5 | Proportional editing (O): falloff-weighted G/R/S in edit mode, wheel radius, circle overlay | opus | — | pending |
| P6-6 | Shortcut overlay + status-hint audit: every wired key listed, grouped | opus | — | pending |
