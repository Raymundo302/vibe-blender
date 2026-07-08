# NODES-RUN — the node-shading dry run (P14-4)

The path-traced hero shot is `research/donut-nodes-hero.png`; the saved scene is
`research/donut-nodes.vibe.json`; the driver is `e2e/p14-dryrun.mjs`. This is the
honest field report of taking the **node shader editor** (P14-1) + the tracer/
bake node evaluator (P14-2/P14-3) around the block on the real frozen donut.

## What was driven

Loaded `e2e/fixtures/donut-p9-frozen.vibe.json` (the same fixture P11 froze) and
gave the **Icing** material (`Material.001`, id 0) a procedural graph:

```
noise ─┬─▶ colorRamp (pink→white) ─▶ Principled.baseColor
       └─▶ math (multiply ×0.5)    ─▶ Principled.roughness
```

- **noise** (scale 6, detail 4) → **colorRamp** fac: pink `[0.906, 0.651, 0.769]`
  at 0, white at 1, into **baseColor**.
- **noise** → **math** (`multiply`, b=0.5) → **roughness** (so roughness = noise·0.5,
  the darker crevices read slightly glossier).

Then, through public entry points wherever possible:
- **Rendered viewport bake** — frame differs from the flat pink baseline by 1,794
  changed pixels, no GL errors, and the material baked a base texture whose
  version tracks `nodeGraphVersion`.
- **Shader Editor pane** — switched an area's editor dropdown to `shader` with the
  icing active; `window.__shaderEditor.nodeCount()` returns **4** (Principled +
  Noise + ColorRamp + Math drawn as boxes) and the sockets are laid out
  (`socketPos(0,'baseColor')` resolves to a client point).
- **F12 path trace** (low spp = 4) — completes; the traced frame differs from the
  flat trace of the same view by meanAbsDiff ≈ **6.4/255** (tracer node hook is
  live). Hero PNG saved.
- **Save / reload / re-apply** — `io.serialize` → `donut-nodes.vibe.json`, then
  `t.reload` + `io.apply` into a fresh boot: the graph survives (4 nodes + 4
  links), `useNodes` stays on, and a re-render still shades differently than the
  same material forced flat (1,794 px). Node materials round-trip.

Everything above passes under flock in `e2e/p14-dryrun.mjs`. The full donut suite,
smoke, edit, workspace, `npm test` (600), and `tsc` are all green.

## Findings

### FIXED-HERE
- **The node pipeline is real and end-to-end.** noise/colorRamp/math evaluate
  identically in the Rendered bake and the F12 tracer, the Shader Editor draws
  the graph, and the graph survives save→reload. No code changes were needed for
  the pipeline — this run is the proof, not a repair.

### PUNCH-LIST
- **No generated / object texture coordinates.** Procedural nodes (noise, checker,
  imageTexture) read the surface UV from `ctx.u/ctx.v`, which come only from a UV
  map. The frozen icing carried **zero UVs**, so without a map both the tracer and
  the bake sample `(0,0)` and every procedural node collapses to a constant — the
  whole point of a *procedural* texture is lost. This run had to **Smart-UV-Project
  the icing first** to make the noise vary. Blender's Texture Coordinate node
  (Generated / Object / Normal) would remove that requirement; worth a future node.
- **Noise output centres near 0.5, so a two-stop pink→white ramp reads mostly
  pale.** fbm value noise normalised to 0..1 clusters around the mean, so the
  colorRamp spends most of its fac budget in the light half and the icing looks
  washed-out rather than boldly two-tone (visible in the hero shot). Not a bug —
  but a Map Range / contrast control (or a noise `contrast`/`roughness` param, or
  a 3-stop ramp) would let a user push the mids. UX pain, not a defect.
- **Shader Editor edits are pane-driven, not scriptable as a public API.** Building
  the graph in the dry run went through the `material.nodeGraph` object literal
  (the pattern every P14 sibling suite uses) because there is no headless
  "add node / add link" entry point outside the canvas gestures. Fine for the
  editor's purpose, but it means an e2e that wants a *specific* graph can't drive
  the real UI deterministically — it asserts the UI *renders* the graph instead.
- **Bake artifact — resolution vs. UV density.** The bake rasterises the graph into
  one base texture mapped through the icing's Smart-Project UVs; on the densely
  subdivided icing (subsurf + solidify + scatter, 477 base faces) the packed UV
  islands are small, so fine noise detail is limited by the bake texture size in
  the Rendered viewport (the F12 tracer, which evaluates per-hit, does not share
  this ceiling — compare `02-flat` vs the F12 hero). Acceptable at demo scale;
  note it if bake resolution ever becomes a control.
- **`math` unconnected input default is a quiet contract.** roughness = noise·0.5
  works because `math.b` falls back to the socket default 0.5 when unconnected.
  Correct and documented in `nodesB.ts`, but a user reading only the graph JSON
  sees `b: 0.5` as a param-looking value on an input socket — mildly confusing.
  No change needed.

## Spec-vs-code tiebreaker note
No spec contradictions were hit. One judgement call: the spec says "give the ICING
material a node graph … noise → …" but does not mention UVs, and the frozen icing
has none. Rather than improvise a different graph, I kept the exact graph the spec
asked for and added the minimal enabling step (Smart UV Project, a proven public
menu flow from `e2e/p11-uv-dryrun.mjs`) so the *procedural* nodes actually vary —
recorded above as the top PUNCH-LIST item, since it is precisely the kind of gap
the dry run exists to surface.
