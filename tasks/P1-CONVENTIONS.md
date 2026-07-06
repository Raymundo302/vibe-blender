# P1 batch — shared conventions (read first)

Project root: `/home/raymundo/Vibe Coded Blender`. All paths below are relative to it.

## Ground rules
- **Escape hatch:** if this spec is ambiguous or contradicts the real code, STOP and report the problem in your final message instead of improvising.
- Touch ONLY the files listed in your spec's "Files" section. Do not reformat, rename, or "improve" unrelated code. Do not add dependencies.
- Match the existing code style: immutable math types (`Vec3`, `Transform` return copies), `readonly` where possible, doc comments explaining *why*, no semicolonless style, 2-space indent.
- TypeScript strict. `npm run build` runs `tsc --noEmit` — it must pass with zero errors.
- Undo convention (see `src/core/undo/UndoStack.ts`): apply the final state FIRST, then `undo.push(command)`. push() stores, never executes.

## Existing interfaces you build on
- `src/core/scene/Scene.ts` — `Scene` (objects, selection Set, activeId, add/get/remove/insertAt, selectOnly/toggleSelect/deselectAll), `SceneObject` (id, name, mesh, transform, visible).
- `src/core/operator/Operator.ts` — modal `Operator` interface + `OperatorContext` (scene, camera, undo, viewportSize(), setStatus()).
- `src/tools/translate.ts` — `TranslateOperator`, the reference implementation for any new modal operator.
- `src/core/undo/commands.ts` — `TransformCommand` for move/rotate/scale.
- `src/core/undo/objectCommands.ts` — `AddObjectsCommand` (construct AFTER scene.add), `DeleteObjectsCommand.perform()` (captures + deletes + returns pushable command), `RenameObjectCommand`.
- `src/ui/shell.ts` — `UiShell` with `addPanel(panel)` and per-frame `update()`. `window.__app.shell` exposes it; panels are wired in `src/main.ts`.
- `src/core/math/` — `Vec3` (immutable), `Quat` (fromAxisAngle, mul, rotate), `Mat4` (mul, invert, transformPoint with perspective divide, transformDir), `Transform` (immutable, withPosition/withRotation/withScale).
- `src/camera/OrbitCamera.ts` — `pointerRay(px, py, w, h)`, `viewMatrix()`, `projMatrix(aspect)`, `eye`, `forward`.
- World is **Y-up**; the ground grid lies in the XZ plane. Faces wind CCW seen from outside (backface culling is ON).

## Project a world point to CSS pixels (for screen-space operators)
```ts
const { width, height } = ctx.viewportSize();
const ndc = ctx.camera.projMatrix(width / height).mul(ctx.camera.viewMatrix()).transformPoint(p);
const cssX = (ndc.x + 1) / 2 * width;
const cssY = (1 - ndc.y) / 2 * height;
```

## Verification commands
- `npm run build` — typecheck + bundle (must pass)
- `npm test` — vitest unit tests (must pass)
- Headless e2e pattern: see `e2e/smoke.mjs` (CDP over headless Chrome, no deps). Dev server: `node node_modules/vite/bin/vite.js --port 5199`.

## Done = committed
When your acceptance criteria pass, commit ONLY your allowed files:
`git add <your files> && git commit -m "<TASK-ID>: <one-line summary>"`.
If git reports an index.lock conflict, wait 2s and retry. Never `git add -A`.
Your final message: what you built, how you verified each acceptance criterion, and any deviations from the spec (ideally none).
