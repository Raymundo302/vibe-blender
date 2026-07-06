# P4/P5 batch — shared conventions (read first, then your task spec)

`tasks/P1-CONVENTIONS.md`, `P2-CONVENTIONS.md`, `P3-CONVENTIONS.md` all still
apply (escape hatch, file discipline, style, strict TS, undo patterns, commit
protocol, deterministic serialization, dev server on 5199 / CDP 9222 rules).

## New Phase-4 core interfaces (built + tested — do NOT modify these files)
- `src/ui/workspace.ts` — WorkspaceManager, EditorFactory { type, title,
  singleton?, create(): { element, update(), destroy?() } }. Editors are
  registered in `src/main.ts` (editorFactories array).
- `src/core/modifiers/Modifier.ts` — Modifier interface (type/name/enabled,
  PURE apply(mesh)→new mesh, params()/setParam()/fields()), registerModifier,
  createModifier, modifierTypes, cloneModifier. Fields drive a GENERIC param UI:
  kinds 'number' | 'int' | 'bool' | 'axis' ('axis' renders as an X/Y/Z select
  storing 'x'|'y'|'z').
- `src/core/scene/Scene.ts` — SceneObject.modifiers (array), modifiersVersion
  (bump after ANY stack mutation), evaluatedMesh() (cached; the renderer already
  shows it in object mode and hides modifiers during edit mode).
- `src/core/undo/modifierCommands.ts` — ModifierStackCommand.capture(name, obj,
  mutate) for stack/param changes; `new ApplyModifierCommand(obj, modifier)`
  applies the FIRST modifier into the base mesh (throws otherwise; construct =
  perform, then undo.push it).

## e2e
Four suites now: smoke.mjs, edit.mjs, ship.mjs, workspace.mjs — ALL must pass
before you commit (run sequentially). Phase-4 checks go in `e2e/ship.mjs`
unless your spec says otherwise. NEVER hardcode page pixel coordinates — the
workspace layout moves/resizes the canvas; derive points from
`document.querySelector('canvas').getBoundingClientRect()` (see the `cv()`
helper pattern at the top of edit.mjs).

## Registering new modifiers
Each modifier lives in its own file under `src/core/modifiers/` and calls
`registerModifier(type, label, factory)` at module load. Add the import to
`src/core/modifiers/builtins.ts` (P4-5 creates it; main.ts imports it once).
Modifier `apply` MUST be pure — clone or build a fresh EditableMesh, never
mutate the input. Determinism: same input mesh + params → identical output
(vert/face insertion order included; the GPU cache and tests rely on it).
