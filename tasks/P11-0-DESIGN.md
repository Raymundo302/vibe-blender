# Phase 11 — UVs (the night build, 2026-07-06 → 07)

Ray's ask: "UV properties and a UV unwrapper, build that overnight."

## Architecture decisions
| # | Decision | Rationale |
|---|----------|-----------|
| A12 | UVs are PER-FACE-CORNER: `mesh.uvs: Map<faceId, [u,v][]>` parallel to face.verts | Corner UVs (Blender loops) allow seams/islands without duplicating verts; simplest storage that is correct. Faces without an entry have no UVs (render as 0,0). |
| A13 | Seams are an edge-key Set on the mesh, like creases | Same lifecycle (clone/undo/serialize/prune); drawn by the edit overlay. |
| A14 | Unwrap = seam-split islands → boundary-circle Tutte embed → uniform-spring relaxation, then shelf-pack | LSCM/ABF is overkill for a night build; Tutte+relax is robust, deterministic, and honest to explain. Smart Project + Project From View cover the failure cases like real Blender workflows do. |
| A15 | Textures v1: per-material `texKind: 'none'\|'checker'\|'image'` + packed data-URL image, multiplying baseColor; consumed by Rendered mode AND the tracer | UVs are invisible without something mapped through them. Checker is the industry inspection tool; one image slot honestly reopens donut parts 5–6. |
| A16 | The UV Editor is a second workspace editor type with its OWN canvas | The workspace system was built for this (P4-1). The frozen "exactly one canvas" assertions get scoped to the 3D viewport canvas by the architect. |

## Task registry
| ID | Task | Owner | Depends |
|----|------|-------|---------|
| F11-1 | UV + seam mesh attributes (clone/undo/serialize/GPU), material texture fields + serialization, snapshot per-tri UVs, workspace canvas-assertion scoping | fable | — |
| P11-1 | Seam marking (Ctrl+E edge menu) + Unwrap/Smart Project/Project From View (U menu) + island packing | opus | F11-1 |
| P11-2 | UV Editor workspace editor: islands over grid/checker, island select, G/R/S, 3D-selection sync | opus | F11-1 |
| P11-3 | Textures: checker + image in renderedPass and tracer, Material tab texture rows, materialTab e2e | opus | F11-1 |
| P11-4 | UV dry run: unwrap the donut icing, checker it, render — e2e + findings report | opus | P11-1..3 |
