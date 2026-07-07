# P9 batch — shared conventions (read first, then your task spec)

Everything in `tasks/P8-CONVENTIONS.md` still applies: file discipline (you run
IN PARALLEL with other workers in the same tree — touch ONLY files your spec
lists), escape hatch (ambiguous spec → stop, report "blocked"), dev server
already running on 5199 (never restart), EVERY e2e run wrapped in
`flock /tmp/vibe-blender-e2e.lock node e2e/<suite>.mjs`, own e2e file + own css
file per task, no git commands, do not edit PLAN.md.

KNOWN FLAKE: e2e/ship.mjs occasionally fails one check on a loaded machine and
passes on re-run. If a suite fails, re-run it once before reporting — but any
failure that reproduces twice is REAL and yours to explain.

## New Phase-9 core (architect-built + tested — do NOT modify these)
- `src/core/modifiers/Modifier.ts` — `apply(mesh, ctx?: ModifierContext)`;
  ModifierContext { hostMatrix, target(objectId) → { mesh (EVALUATED), matrix,
  version } | null }. Modifiers that reference objects use param values of
  kind **'object'** (a number: object id, -1 = none — the UI dropdown and the
  save/load index remap already work). Implement `depVersion(ctx)` returning a
  string that changes whenever your output would (target version + relevant
  transforms) — the evaluatedMesh cache keys on it. WITHOUT ctx (unit tests on
  bare meshes, some tools), object-referencing modifiers MUST return the input
  mesh unchanged.
- `src/core/scene/Scene.ts` — `scene.modifierContext(obj)` builds the ctx
  (cycle-guarded). The Renderer + path-tracer snapshot already pass it.
- `src/core/mesh/EditableMesh.ts` — `creases` (Map edgeKey→0..1, helpers
  setCrease(a,b,w)/crease(a,b)) and `faceTints` (Map faceId→[r,g,b]). Both
  survive clone/copyFrom/undo/save. Tints already multiply into all three
  solid shading modes via per-corner colors — just set them on output faces.
- `src/core/scene/objectData.ts` — Material gains `subsurfaceWeight` (0..1)
  and `subsurfaceRadius` (world units). Serialized; defaults 0 / 0.05.

## Modifier rules (unchanged from P4, restated)
Pure apply (never mutate input; build/clone a fresh mesh), deterministic
(same input+params+ctx → identical output, insertion order included — use a
seeded RNG like mulberry32 if you need randomness; Math.random is FORBIDDEN),
register via registerModifier in your own file (already imported by
builtins.ts stub), params through fields() so the generic UI renders them.
