# The Donut Gap Analysis

Goal: follow Blender Guru's **2026 donut series (Blender 5.0, 8 parts)** inside
Vibe Blender for the video's Act 3 payoff. Source: full transcripts of all 8
parts, feature-extracted 2026-07-06 (see `tasks/` P9 specs when written).
Scope decision: we reproduce **the donut on a plate with icing, dribbles and
sprinkles, lit and path-traced** — parts 1, 3, 4, 7, 8. The mug (part 2) and
the texturing/UV parts (5, 6) are stretch goals.

## Already have ✓ (Phases 0-8)
Torus/cylinder/sphere/plane primitives, Shift+A, shade smooth, orbit/pan/zoom,
G/R/S + axis locks + numeric input, edit mode (vert/edge/face), delete faces,
extrude, inset, loop cut, edge slide, box select, proportional editing (O),
merge, fill (F), bridge loops, knife-lite (loop-based), Subsurf/Mirror/Array
modifiers + apply + reorder, join/separate, duplicate, grid snapping, undo
through everything, save/load, outliner (rename/hide/delete), materials
(base color/metallic/roughness/emission), point/sun/spot lights, camera
objects + Numpad0, Rendered viewport (GGX), **F12 progressive path tracer**,
Save PNG.

## MUST-HAVE gaps (blocking the donut) — Phase 9 candidates

| # | Feature | Tutorial moment | Notes |
|---|---------|-----------------|-------|
| D1 | **Adjust-last-operation panel** (primitive params: torus major/minor radius + segments, cylinder vertex count, circle radius) | P1: "radius 0.1, minor 0.057, 48/18 segments" | Our primitives are fixed presets today. F9-style floating panel after Add. |
| D2 | **Circle primitive** (with ngon-fill option) | P4: plate starts from a filled circle | Small. |
| D3 | **Alt+click edge/face loop select** | P1/P2/P3/P4 constantly | We already walk quad strips for loop cut — same topology query. |
| D4 | **X-ray / select-through toggle** (box select grabs far-side verts) | P3: select donut's bottom half | Our GPU picking only sees front faces; need a through-selection mode. |
| D5 | **Solidify modifier** (offset, thickness, rim crease) | P1 mug walls, P3 icing thickness, P4 plate | Core generate-modifier; registry pattern exists. |
| D6 | **Shrinkwrap modifier** (nearest-surface + offset, target picker) | P3: icing hugs the donut | Deform modifier; needs closest-point-on-mesh query. |
| D7 | **Edge crease** (Shift+E) + Catmull-Clark honoring crease weights | P3 icing rim, P4 plate rim | Our subsurf is uncreased; add per-edge crease attr + serialize it. |
| D8 | **Merge by Distance** | P4: cleanup doubled verts | We have merge-at-center; add distance variant. |
| D9 | **Sculpt-lite: Inflate + Grab brushes** (radius via F, strength) | P3: icing droplets/thickness | Scoped: 2 brushes, no dyntopo. Fallback: proportional editing only — decide at spec time. |
| D10 | **Scatter modifier** (instance an object/collection over faces: density, seed, random Y-rotation, align-to-normal, surface offset, min-distance, face-selection or vertex-group mask) | P7: the sprinkles | THE visual payoff. Scoped-down version of 5.0's Scatter on Surface. Model sprinkle capsule with existing tools. |
| D11 | **Per-instance random material color** (random value → color ramp with constant bands) | P7: pastel sprinkles | Could be a material "random hue set" param instead of full nodes. |
| D12 | **Light radius → soft shadows in the path tracer** (+ optional color temperature) | P8: sky point light softness | Tracer already samples lights; add area sampling. |
| D13 | **Camera: lock-camera-to-view** (navigate viewport to place camera) | P4/P8 framing | We have Numpad0 view-through; add "grab camera to current view" (Blender's Ctrl+Alt+Numpad0 is enough). |
| D14 | **Subsurface scattering approximation** (weight + radius on materials, honored by path tracer; Rendered mode can fake with wrap lighting) | P4/P8: donut + icing look edible because of SSS | Even a cheap diffusion approximation sells the donut. |
| D15 | **Recalculate normals** (Shift+N + auto-orient on fill/extrude) | P2, and protects everything else | We've been lucky; icing surgery will expose it. |

## NICE-TO-HAVE (only if time/credits allow)
- **Lattice deform** (P4 lumpiness) — substitute: proportional editing on the donut+icing.
- **Parenting** (P8 hierarchy; already on the follow-up list) + Ctrl+P keep-transform.
- **Collections** (P7/P8 organization) — outliner groups; scatter can point at a single object instead.
- **Depth of field** in the path tracer (P8) — thin-lens is ~20 lines in a tracer; great bang/buck if D10-D14 land early.
- **Render slots + compare (J)** (P4).
- **Reference images** (P2 mug).
- **Multi-object edit mode** (P4).
- **Weight paint** (P7) — substitute: face-selection mask on the scatter modifier.

## OUT OF SCOPE (substitutions, stated honestly in the video)
- **Image textures / PBR maps / UV unwrapping / displacement / shader nodes**
  (parts 5-6, Poliigon): flat PBR colors + SSS instead. "Our bakery doesn't do
  texture scans yet."
- **Eevee vs Cycles**: our Rendered viewport IS our Eevee, our F12 path tracer
  IS our Cycles — that mapping is a video beat, not a gap.
- **Geometry nodes**: D10's scatter modifier plays that role.
- **GPU rendering, denoising, light probes, compositing**: the tracer just
  takes more samples.

## Suggested build order (P9)
1. D5 Solidify + D7 crease + D8 merge-by-distance (mesh/modifier core, one batch)
2. D3 loop select + D4 x-ray select + D15 normals (selection/robustness batch)
3. D6 Shrinkwrap + D9 sculpt-lite (icing batch)
4. D1 op panel + D2 circle + D13 camera-to-view (UX batch)
5. D10 scatter + D11 random color (sprinkles batch)
6. D12 soft shadows + D14 SSS (+DoF if cheap) (render batch)
7. **The dry run: model the donut start-to-finish, film it.**
