# P2 batch — shared conventions (read first, then your task spec)

Everything in `tasks/P1-CONVENTIONS.md` still applies (escape hatch, file discipline,
style, strict TS, undo push-after-apply, commit protocol). Additions for edit mode:

## Edit-mode interfaces (all built and tested — do NOT modify these files)
- `src/core/scene/EditMode.ts` — `EditModeState`: `elementMode: 'vert'|'edge'|'face'`,
  selection Sets (`verts: Set<number>`, `edges: Set<string>` keyed by
  `EditableMesh.edgeKey(a,b)`, `faces: Set<number>`), `version` (bump via `touch()`
  after ANY selection change), `selectedVertIds(mesh)` (what G/R/S move),
  `setElementMode(mode, mesh)`, `clearSelection()`, `selectAll(mesh)`, `prune(mesh)`.
- `src/core/scene/Scene.ts` — `scene.mode` ('object'|'edit'), `scene.editMode`
  (EditModeState | null), `scene.editObject`, `enterEditMode(id?)`, `exitEditMode()`.
- `src/core/mesh/EditableMesh.ts` — topology ops: `deleteFaces(ids)`,
  `deleteVerts(ids)` (cascades to faces), `deleteEdges(keys)` (cascades, keeps verts),
  `mergeVertsAtCenter(ids)`, `facesOfVert(id)`, `edges()`, `faceNormal(id)`,
  `setVertCo(id, co)` (geometry-only version bump), `addVert(co)`, `addFace(vertIds)`,
  `clone()`, `copyFrom(other)`.
- `src/core/mesh/editOverlayData.ts` — `elementIndexMaps(mesh)` returns stable
  `{ vertIds, edgeKeys, faceIds }` arrays; pick indices MUST come from these.
- `src/core/undo/meshCommands.ts` — `MeshEditCommand.capture(name, mesh, mutate)`
  for one-shot topology edits; `MeshEditCommand.fromSnapshots(name, mesh, before, after)`
  for modal tools (see "Modal topology tools" below).

## Undo pattern for modal GEOMETRY tools (move/rotate/scale verts)
On start: save `before = new Map(vertId → co)` for affected verts. Preview by
`mesh.setVertCo(...)` on pointer move. On confirm: restore all `before` positions,
then `undo.push(MeshEditCommand.capture(name, mesh, () => { apply final positions }))`.
On cancel: restore `before` positions, push nothing.

## Undo pattern for modal TOPOLOGY tools (extrude, inset)
On start: `const before = mesh.clone()`, then mutate topology immediately (this IS
the preview) and keep mutating positions during pointer moves. On confirm:
`undo.push(MeshEditCommand.fromSnapshots(name, mesh, before, mesh.clone()))`.
On cancel: `mesh.copyFrom(before)`, push nothing.

## Selection hygiene
After any topology change, call `sel.prune(mesh)` and `sel.touch()`. Set the
selection to the elements a Blender user would expect (e.g. extrude selects the
new cap faces).

## Local vs world space
Vert coordinates are in the edit object's LOCAL space. Pointer deltas computed in
world space must be converted: `obj.transform.matrix().invert().transformDir(delta)`.

## Element pick id namespaces (P2-2 defines the pass; others consume)
`idx` = index into `elementIndexMaps(mesh)` arrays. Encoded pick id =
`VERT_PICK_BASE + idx` (0x000001, i.e. idx+1), `EDGE_PICK_BASE + idx` (0x100000),
`FACE_PICK_BASE + idx` (0x200000). All below `GIZMO_PICK_BASE` (0xf00000).

## Keymap wiring
Edit-mode keys live ONLY in `InputManager.onEditModeKey` (src/input/InputManager.ts).
Add your key with an early-return guard matching the existing style. Multiple P2
tasks touch this one method — keep your addition to the minimal lines and do not
reorder others' entries.

## Verification
`npm run build` && `npm test` && (dev server on 5199) `node e2e/edit.mjs` must all
pass before you commit. Append your task's e2e checks to `e2e/edit.mjs` — keep
existing checks green; use the `t` helpers from `e2e/harness.mjs` (evaluate, click,
key with modifier bitmask alt=1 ctrl=2 shift=8, check, until, screenshot).
