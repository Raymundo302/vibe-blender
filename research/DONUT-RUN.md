# The Donut Dry Run — findings report (P9-8)

Scripted end-to-end build of THE DONUT, driven through public entry points
(`__app` scene/io APIs, key events, UI clicks) by `e2e/donut.mjs`. This report
is the input for the final fix round AND the video script: it records, stage by
stage, what worked, what needed a workaround, and what is missing or ugly.

**How to reproduce:** `flock /tmp/vibe-blender-e2e.lock node e2e/donut.mjs`
(dev server on :5199). Deterministic: fixed seeds (lumpiness `mulberry32(1337)`,
scatter seed `1`), fixed geometry, fixed camera (lock-to-view snap).

**Artifacts produced**
- `/tmp/donut/NN-<stage>.png` — a viewport screenshot after every major stage.
- `/tmp/donut/09-render-hero.png` — path-traced hero (headless cap, see S9).
- `/tmp/donut/09-render-control-4spp.png` — 4-sample control (progress story).
- `/tmp/donut/09-render-dof.png` — depth-of-field pass (focus on icing).
- `research/donut.vibe.json` — committable scene, round-trips byte-identical.

**Wall time:** ~11 min total; the three path-trace passes dominate (~9 min).
Everything up to and including Stage 8 (model → materials → lights → camera)
runs in well under a minute.

---

## Stage-by-stage

### 1. Torus (Shift+A → Torus) — WORKED
Real Add menu + real "Adjust Last Operation" op panel. Set majorRadius 1,
minorRadius 0.55, majorSegments 48, minorSegments 18 → **864 verts**. Shade
Smooth via the per-object flag. Screenshot `01-torus.png`.

**Unit mapping (for the script):** the tutorial models the donut at 0.1 m
(Blender's default 1 m torus scaled ×0.1). We stay in native units:
majorRadius 1 = "one donut radius", minorRadius 0.55 = a fat ring. All later
distances (light positions, plate size) are in these units. Nothing depends on
the absolute scale, so the 0.1 m detail is cosmetic in our engine.

### 2. Proportional lumpiness (O) — WORKED (real) + seeded top-up
Real path: enter Edit Mode, select the top vert, toggle **O**, **G**-drag it up,
Enter. The default proportional radius (2) is large relative to a 1-unit donut,
so **644 of 864 verts** moved as a smooth neighbourhood — proof the falloff
works, though the radius is coarse for fine "lattice" lumps. For richer, fully
reproducible lumpiness the run then applies a seeded `mulberry32(1337)` ±4.5 %
radial wobble across all verts via `setVertCo` (our stand-in for the tutorial's
lattice). Screenshot `02-lumpy.png`.

- **Workaround:** the bulk lumpiness is applied through the mesh API, not a
  series of hand-driven proportional drags — headless mouse drags of specific
  vert sets are imprecise. The proportional *tool* is exercised for real once;
  the deterministic wobble is the visual.
- **Ugly / to improve:** default proportional radius 2 is too big for donut-scale
  detail; the tutorial's lattice gives finer, lower-frequency deformation. A
  smaller default radius (or a radius shown in scene units) would help.

### 3. Icing: duplicate → Shrinkwrap → Solidify → Subsurf — WORKED, with a real bug
Icing = a clone of the donut with the lower half removed (**472 of 864 faces**
kept). Stack added through the Modifiers-tab dropdown **in order**
shrinkwrap → solidify → subsurf. Params: shrinkwrap target = donut, offset 0.06;
solidify thickness 0.12, offset 1, rimCrease 1; subsurf levels 2. Evaluated
icing = **16 704 verts/faces** (subsurf-2 is the heavy geometry in the scene).
Screenshot `03-icing.png`.

- **Workaround:** the bottom-half deletion is done via the mesh API
  (`deleteFaces` by face-centroid `y`), not an x-ray box-select drag — headless
  box-select of exactly the lower ring is imprecise. X-ray select-through itself
  is separately proven by `e2e/p9-select.mjs`.
- **🔴 REAL BUG (for the fix round): "Apply" on an object-referencing modifier
  corrupts the base mesh.** Clicking **Apply** on the index-0 shrinkwrap ran
  `ApplyModifierCommand`, which does `obj.mesh.copyFrom(modifier.apply(obj.mesh))`.
  A ctx-less object modifier returns the *same* mesh instance unchanged (per the
  P9 convention), so `copyFrom(self)` **clears the source before copying → the
  base mesh is emptied (522 → 0 verts).** Two fixes needed:
    1. `ApplyModifierCommand` should thread the scene's `ModifierContext` so
       shrinkwrap/scatter actually bake (right now their apply is a guaranteed
       no-op or, worse, a wipe).
    2. `EditableMesh.copyFrom` should be self-assignment safe (or Apply should
       clone the result before `copyFrom`).
  The dry run **keeps the stack live** (Ctrl+Z to undo the bad bake) — the
  Renderer/tracer snapshot threads the context, so `evaluatedMesh` is correct
  for the render regardless. So: modifiers work perfectly *live*; only *baking*
  the object-referencing ones is broken.

### 4. Icing dribbles — WORKED (mesh API)
Added 5 short triangular "drips" hanging off the icing rim so the silhouette
reads as dripping icing. Screenshot `04-drips.png`.

- **Workaround:** driven through the mesh API. Rim-vert extrude-down +
  sculpt-lite inflate on droplet ends is proven interactively by
  `e2e/p9-sculpt.mjs`; reproducing exact multi-vert rim gestures headless is
  brittle, so the drips are modelled directly.
- **Ugly / to improve:** the drips are simple flat triangles, not rounded
  teardrops. A real inflate stroke (or a small solidify+subsurf on the drip
  fan) would round them out.

### 5. Plate + table — WORKED
Plate = shallow `makeCylinder(2.2, 0.18, 48)` disc at y −0.85; table =
`makePlane(20)` at y −0.95. Simplified vs the tutorial's extruded/scaled rim
(explicitly allowed by the spec). Screenshot `05-plate-table.png`.

### 6. Materials — WORKED
Icing pink through the **Material tab UI** (New → baseColor `#e7a6c4`,
roughness 0.25, subsurface 0.4) to prove the path. Donut brown
(`[0.45,0.24,0.12]`, rough 0.55, SSS 0.6 / radius 0.1), plate ceramic white
(`[0.92,0.92,0.9]`, rough 0.15), table grey (`[0.18,0.18,0.2]`, rough 0.8) via
`scene.addMaterial` (the tab is covered by `e2e/p8-material.mjs`). Colors from
the tutorial. Rendered-viewport screenshot `06-materials.png`.

### 7. Sprinkles: capsule + Scatter — WORKED, sprinkles read pale
One capsule stand-in (`makeCylinder(0.03,0.16,6)`) scattered on the icing:
count 120, upOnly, minDistance 0.08, colorVariation 1. **Seed trial:** seeds
1/3/7 all yielded 12 distinct hue buckets in the evaluated face tints; seed **1**
was chosen (tie → lowest). Sprinkles multiplied the icing to **18 024 faces**.
Rendered-viewport screenshot `07-sprinkles.png`.

- **Ugly / to improve (for the fix round):** in the *path-traced* hero the
  sprinkles look **pale/near-white**, not candy-coloured, even at colorVariation
  1. The per-face tints exist in the geometry (12 hue buckets) but are washed out
  by exposure + the bright three-lamp rig; the tracer may also be under-weighting
  `faceTints` vs the base material. Worth checking that the tracer reads face
  tints and that sprinkle albedo survives tone-mapping.
- **Note:** the capsule is a plain 6-sided cylinder (no subsurf/loop-cut
  rounding). The spec's "cylinder + subsurf + loop cuts" capsule would look
  rounder; kept simple here because Scatter instances the source as-is.

### 8. Camera + three-lamp rig — WORKED
Camera via **lock-to-view snap** (frame `.` then Ctrl+Alt+Numpad0), focal 50.
Lights: warm Sun (`[1,0.85,0.6]`, power 4, angled from +X+Y), blue "sky" point
fill (`[0.5,0.62,1]`, power 500, radius 1.2 for soft shadows), white bounce
point (power 260, radius 0.8). Screenshot `08-lit.png`.

- **Ugly / to improve:** the lock-to-view snap inherits the *default orbit*
  distance, which frames the donut **very tight** — the plate and table fall
  outside the render frame (see the hero image; we see icing edge-to-edge). For
  the video, dolly the camera back (or frame the whole plate) before snapping.

### 9. Path trace + control + DoF — WORKED, with a headless sample cap
- **Control:** 4 samples, `09-render-control-4spp.png` (~110 s).
- **Hero:** `09-render-hero.png`. Non-trivial (luminance variance ≈ 1580) and
  the donut region is warm/pink (center R−B ≈ +15) vs the blue-grey sky
  background (R−B ≈ +6) — acceptance criterion 2 met.
- **DoF:** aperture 0.35, focus distance = eye→icing, `09-render-dof.png`.

- **⚠️ DEVIATION FROM SPEC (documented): the spec asks for ≥64 samples; the
  headless run caps the hero at 16.** Under headless swiftshader (CPU, no GPU on
  this Beelink) the tracer runs at **~25 s/sample** for THIS scene — 960×540,
  subsurf-2 icing (~16.7k faces), 3 soft-shadowed lights. 64 spp ≈ **30 min**,
  which is infeasible for an e2e suite. The progressive tracer produces a valid
  image at any sample count, and criterion 2 is met well below 64, so the hero
  caps at 16 spp (a clear step up from the 4-spp control) and the DoF at 8 spp.
  **The full 64+ spp beauty render is an offline/manual pass** (open the app,
  F12, walk away). The saved `donut.vibe.json` captures the full-quality scene
  (subsurf 2, 120 sprinkles, 3 lights) so an offline render is one F12 away.
- **Ugly:** obvious Monte-Carlo grain at 16 spp (expected); the icing rim shows
  mild faceting where solidify rimCrease 1 meets subsurf 2 (the crease holds the
  edge hard against the smoothing — visible as a subtle ridge around the icing
  boundary), matching the effect the spec anticipated.

### 10. Save / reload / round-trip — WORKED
`__app.io.serialize()` → `research/donut.vibe.json` (**~373 KB**, format v3,
9 objects). Reloaded from the file bytes and re-serialized: **byte-identical**.

---

## Punch list for the final fix round (most → least important)
1. **`ApplyModifierCommand` empties the mesh when baking a ctx-less object
   modifier** (shrinkwrap/scatter): thread `ModifierContext` into Apply, and make
   `EditableMesh.copyFrom` self-assignment safe. (Stage 3 — real bug.)
2. **Scatter sprinkles render pale** despite colorVariation 1: verify the path
   tracer honours `faceTints` and that tinted albedo survives tone-mapping.
   (Stage 7.)
3. **Lock-to-view framing is too tight** — plate/table clipped. Consider a
   "frame all + pull back" camera snap, or expose camera dolly. (Stage 8.)
4. **Proportional radius default (2) is too coarse** for donut-scale lumps, and
   the radius isn't shown in scene units. (Stage 2.)
5. Path-trace speed: ~25 s/sample headless at 960×540 makes high-spp renders an
   offline-only affair. A lower-res preview mode or adaptive sampling would let
   the dry run push more samples. (Stage 9.)
6. Cosmetic: icing drips are flat triangles; sprinkle capsule is un-rounded.
