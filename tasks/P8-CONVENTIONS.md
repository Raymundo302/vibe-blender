# P8 batch — shared conventions (read first, then your task spec)

All previous conventions apply (`tasks/P1..P4-CONVENTIONS.md`): escape hatch
(spec ambiguous/wrong → STOP and report, don't improvise), file discipline
(touch ONLY the files your spec lists — other workers run in parallel in the
SAME working tree), strict TS, deterministic serialization, dev server on
5199 / CDP 9222, all e2e suites must pass before commit.

## New Phase-8 core (built + tested by the architect — do NOT modify)
- `src/core/scene/objectData.ts` — ObjectKind, LightData (type point/sun/spot,
  color, power, spotAngle, spotBlend), CameraData (focalLength mm, near, far),
  Material (id, name, baseColor, metallic, roughness, emissive,
  emissiveStrength), DEFAULT_MATERIAL, defaultLight/defaultCamera/makeMaterial,
  `cameraFovY(cam)` (vertical FOV from focal length, 24mm sensor height),
  `objectForward(transform)` (lights/cameras aim down local -Z).
- `src/core/scene/Scene.ts` — SceneObject.kind ('mesh'|'light'|'camera',
  readonly; non-mesh objects carry an EMPTY EditableMesh), .light?, .camera?,
  .materialId (number|null). Scene.addLight/addCamera, materials library
  (addMaterial/getMaterial/removeMaterial/materialOf), activeCameraId +
  activeCamera getter (first camera auto-activates; remove promotes the next;
  insertAt reactivates on undo), kind-aware duplicate(src, name).
  enterEditMode refuses non-mesh objects.
- `src/render/passes/renderedPass.ts` — RenderedPass (forward Cook-Torrance
  GGX, MAX_LIGHTS=8) + `collectLights(scene)` → LightSet (positions,
  directions, energies premultiplied — sun: color×power, point/spot:
  color×power/4π —, types 0/1/2, spot cos(inner)/cos(outer)).
- `src/render/passes/iconPass.ts` — billboard glyphs for non-mesh objects +
  pick footprints; already wired into Renderer.render()/pick() (lights and
  cameras are click-selectable TODAY).
- `src/render/Renderer.ts` — shadingMode cycle is now matcap → wireframe →
  studio → **rendered**. Rendered mode draws mesh objects with
  scene.materialOf(obj); unlit scenes are near-black by design.
- `src/ui/addMenu.ts` — Shift+A already has Add Mesh / Add Light / Add Camera.

## Properties tabs
Register via `registerPropertiesTab` (`src/ui/propertiesEditor.ts`) — follow
`src/ui/modifierTab.ts` as the reference implementation, including its
empty-state and undo patterns. Your tab's file is listed in your spec and is
ALREADY imported by main.ts (stub) — fill the stub, do not edit main.ts.

## Undo
Every user-visible mutation must be undoable. For small param edits follow the
capture pattern used by modifierTab / the Object tab (before/after command
pushed on commit — e.g. on input change, not per keystroke while dragging).

## e2e
Five suites: smoke, edit, ship, workspace + your additions. Phase-8 checks go
where your spec says. Never hardcode pixel coords; derive from the canvas rect.
Set shading mode / scene state through `window.__app` where convenient.
