# Beta Build V5 — frozen 2026-07-07 (the UV night build)

Phases 0-11: everything in V4 plus Phase 10 (collections, 8 themes + 🎨
picker, 🌍 World flat/gradient/HDRI, camera Lock-to-View + passepartout) and
Phase 11 (per-corner UVs + seams, Ctrl+E Mark Seam, U → Unwrap / Smart UV
Project / Project From View, the UV Editor workspace pane, checker/image
textures through UVs in Rendered mode AND the path tracer, modifiers preserve
UVs). Ships with the UV'd donut (donut-uv.vibe.json — launch.sh opens it;
switch an area to UV Editor to see the icing's 6 islands, or 🎬 to render the
checkered icing). 467 unit tests, 25 e2e suites. Also deployed at
https://raymundo302.github.io/vibe-blender/

Run `./launch.sh` (port 5350 — V1..V4 use 5310-5340, dev 5199).
Source snapshot: git tag `beta-build-v5`.
