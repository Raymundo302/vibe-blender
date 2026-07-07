# Beta Build V4 — frozen 2026-07-06 (the donut build)

Phases 0-9: everything in V3 plus THE DONUT TOOLKIT — Solidify, Shrinkwrap
and Scatter modifiers (modifiers can reference other objects), crease-aware
subdivision + Shift+E, adjust-last-operation panel with parametric primitives
+ Circle, sculpt-lite Inflate/Grab brushes, Alt+click loop select, X-ray
select-through, Shift+N recalc normals, Ctrl+Alt+Numpad0 camera-to-view,
path-tracer soft shadows / subsurface scattering / depth of field, and a
?scene= deep link. Ships with the first donut the app ever modeled
(donut.vibe.json — launch.sh opens it; press Z to Rendered or 🎬 to
path-trace it). 385 unit tests, 17 e2e suites. Also deployed at
https://raymundo302.github.io/vibe-blender/

Run `./launch.sh` (port 5340 — V1 5310, V2 5320, V3 5330, dev 5199, so all
run side by side). Source snapshot: git tag `beta-build-v4`.
