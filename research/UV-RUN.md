# The UV Dry Run — findings report (P11-4)

Scripted end-to-end run of the UV workflow on THE DONUT, driven through public
entry points (`__app` scene/io APIs, the InputManager Ctrl+E / U menus, the
workspace UV Editor, the Material tab, the F12 tracer, save/load) by
`e2e/p11-uv-dryrun.mjs`. Like `research/DONUT-RUN.md`, this records — stage by
stage — what worked, what needed a workaround, and what is missing or ugly. It
is the input for a UV fix round and the video script.

**How to reproduce:** `flock /tmp/vibe-blender-e2e.lock node e2e/p11-uv-dryrun.mjs`
(dev server on :5199). Deterministic: the loader replay, seam rings, unwrap
(fixed iteration counts, no RNG), and raster probes are all reproducible — two
back-to-back runs report identical numbers (checkerChanged=89043,
checkerVar=2224.1, byte length 663474). Only the F12 tracer carries Monte-Carlo
noise (seeded), well inside the assertion margins.

**Artifacts produced**
- `/tmp/uvrun/NN-*.png` — a viewport screenshot after every stage
  (`01-loaded`, `02-icing-unwrapped`, `03-uv-editor`, `04-rendered-checker`,
  `07-saved-reloaded`).
- `/tmp/uvrun/06-render-none-control.png` / `06-render-checker.png` — the F12
  control vs checker passes.
- `research/donut-uv.vibe.json` — committable scene, round-trips byte-identical.

**Wall time:** ~95 s total; the two F12 passes (6 spp each, torus hidden so the
scene is light) dominate. Everything up to Stage 5 runs in a few seconds.

---

## Stage-by-stage

### 1. Load the pre-UV donut — WORKED
In-page `fetch('/research/donut.vibe.json')` → `__app.io.apply` (the deep-link
loader path). The fixture is format v3, 9 objects, 373 856 bytes, and **predates
UVs** — asserted clean: 0 uvs, 0 seams, 0 non-none textures on load. Icing +
Torus objects located by name. Screenshot `01-loaded.png`.

### 2. Icing seams + Unwrap — WORKED
The icing base mesh is the donut's top-half cap (477 faces, an annular
half-tube band). Two **meridian seam rings** (edges whose endpoints both sit at
major angle φ≈0 and φ≈π) are selected via the edit API and **marked through the
real Ctrl+E → Edge → Mark Seam menu** (17 seam edges total, status line
confirmed). Then **U → Unwrap** through the real UV menu, operating on all faces
(none selected). Result: **every one of the 477 faces got UVs, all inside
[0,1]²** (1903 corners checked), and the seam-split yields **6 islands**.

- **Workaround (documented):** seam EDGE SELECTION is driven through the mesh
  API (deterministic meridian rings) while the Ctrl+E → Mark Seam MENU is
  exercised for real — mirroring `e2e/p11-unwrap.mjs`. Alt+click edge-loop
  select itself is separately proven by `e2e/p9-select.mjs`; a headless Alt+click
  on an exact loop is imprecise.
- **Distortion / island quality (be honest):** the spec anticipated ≥2 islands;
  the honest unwrap gives **6**. The extra islands come from the ragged
  centroid-cut boundary of the icing cap (the icing was built in the donut run by
  deleting faces whose centroid `y < -0.02`, which leaves an irregular rim) plus
  the 5 triangular "drip" faces hanging off the rim — each fragments the band.
  The Tutte embed is well-behaved on the large band islands (boundary → circle,
  interior relaxed, no NaNs, all in [0,1]) but **stretches near the drips**, as
  expected: a 3-vertex drip triangle pinned to a circle is a degenerate island
  that the planar fallback handles but with visible shear. **Packing** is
  shelf-pack with texel-density equalization; with 6 islands of very unequal 3D
  area the small drip islands waste a little atlas space (thin gaps between
  shelves), but no overlap.

### 3. UV Editor — WORKED
Switched a workspace area to the `uv` editor; it drew the icing's **6 islands**
over the procedural checker background (≥2 gray tones probed). Clicked an island
(472 faces selected — the big band island), **G-nudged** it (mesh.uvs changed),
and **Ctrl+Z restored** the pre-nudge UVs exactly. One-way 3D-selection sync is
inactive here (not in edit mode), as designed. Screenshot `03-uv-editor.png`.

### 4. Material → Checker in the RENDERED VIEWPORT — WORKED (after two real gaps)
Icing material texKind set to **Checker** through the real Material-tab select.
The checker maps boldly around the icing's curvature (screenshot
`04-rendered-checker.png`). Proof is a per-pixel diff of a `none` frame vs a
`checker` frame over the whole viewport: **checker changes 89 043 pixels, the
none-vs-none control changes 0** — non-vacuous (the assertion is unreachable when
texKind stays 'none').

Getting there surfaced **the two real gaps** (see punch list):

- **🔴 Gap #1 — modifiers drop UVs.** No modifier copies `mesh.uvs`, so the
  *evaluated* icing (shrinkwrap→solidify→subsurf) has **no UVs at all** — the
  finished icing renders untextured. The dry run **clears the icing modifier
  stack** to render the unwrapped base cap. Until a modifier baking/propagation
  path carries UVs, textures only work on un-modified (or applied-then-unwrapped)
  meshes.
- **🔴 Gap #2 — z-fighting after de-modifying.** Clearing the stack also drops
  the shrinkwrap+solidify **offset**, so the icing cap (cloned from the torus top
  half) **collapses onto the donut body**. The untextured torus then z-fights and
  **hides the checkered icing entirely** — toggling the icing texture changed 0
  visible pixels until the torus was hidden. This cost most of the debugging: the
  checker and the unwrap were fine all along; the donut body was simply drawn on
  top. The run **hides the torus for the inspection** (a normal "isolate to
  inspect UVs" step) and restores it for the save. The underlying fix is Gap #1
  (bake the offset+UVs) or a small polygon-offset / depth bias so coincident
  shells don't z-fight.

Inspection lighting is flat neutral world + lights off (ambient-only) so the
checker's 0.2/1.0 cells read cleanly.

### 5. Torus body → Smart UV Project — WORKED
Entered edit mode on the torus (no seams), **U → Smart UV Project** through the
real menu: **all 864 faces UV'd, all inside [0,1]²**. Smart Project's 6 axis
buckets handle the un-seamed torus exactly as intended (the robust fallback).

### 6. F12 path trace: checker vs control — WORKED
Two 6-spp path traces of the (torus-hidden) icing through the active scene
camera. Icing-region luminance **variance = 2224 with the checker vs 428 without**
— a **5.2×** separation (`checkerVar > noneVar * 1.3`). Non-vacuous: with texKind
'none' both renders are the same scene and the variance would match. The tracer
reads the packed unwrap's checker directly via barycentric UV interpolation.
Passes: `06-render-checker.png`, `06-render-none-control.png`.

### 7. Save / reload / round-trip — WORKED
Torus + lights + world restored, then `__app.io.serialize()` →
`research/donut-uv.vibe.json` (**663 474 bytes**). Reloaded from the file bytes
and re-serialized: **byte-identical**. UVs (1341 face entries across icing +
torus), seams (17), and the checker texture all survive the round trip.

---

## Punch list for a UV fix round (most → least important)
1. **Modifiers strip UVs (Gap #1).** `mesh.uvs` (and `seams`) are dropped by every
   modifier (`array`/`mirror`/`solidify`/`subsurf`/`shrinkwrap`/`scatter`), so a
   modified mesh can never show a texture. Subsurf especially should interpolate
   corner UVs to its new loops; solidify should copy the shell's UVs; mirror/array
   should copy+transform. Without this, "unwrap then subsurf" — the standard donut
   workflow — renders untextured.
2. **Coincident-shell z-fighting (Gap #2).** Two surfaces at the same depth (icing
   cap on the donut body once the offset is baked/removed) z-fight and one hides
   the other. A small depth bias / polygon offset for the rendered + solid passes,
   or honoring the modifier offset when baking, would prevent the "my texture
   vanished" trap.
3. **Unwrap island fragmentation on ragged caps.** The centroid-`y` cut that built
   the icing leaves an irregular rim, and the drip triangles are isolated faces;
   together they turn a should-be-2-island band into 6, some tiny. A seam-aware
   "select boundary" helper, or merging sub-cell islands during packing, would
   tidy the atlas. Distortion is acceptable except a visible shear on the drip
   triangles.
4. **Packing waste with unequal islands.** Shelf-pack with texel-density scaling
   leaves gaps between shelves when island areas differ wildly (big band vs drip
   tris). A guillotine/MaxRects packer would raise atlas utilization.
5. **Cosmetic:** the procedural checker is a fixed 8×8; a UV-scale control on the
   material (or a "checker density" field) would let the inspection grid be tuned
   per object instead of relying on how much [0,1] the islands fill.
