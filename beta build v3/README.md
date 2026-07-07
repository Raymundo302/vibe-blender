# Beta Build V3 — frozen 2026-07-06

Phases 0-8: everything in V2 plus the full render stack — point/sun/spot
lights with a Light tab, scene material library with a Material tab (PBR:
base color / metallic / roughness / emission), Rendered viewport shading
(Cook-Torrance GGX lit by scene lights), camera objects with frustum display
+ Numpad0 view-through + Camera tab, and the F12 progressive path tracer
(Web Worker + BVH) with a render window, Save PNG, and a topbar 🎬 Render
button (browsers eat F12). Scene format v3 persists lights/cameras/materials.
290 unit tests, 9 e2e suites. Also deployed at
https://raymundo302.github.io/vibe-blender/

Run `./launch.sh` to open it for filming (port 5330 — V1 uses 5310, V2 5320,
dev 5199, so all can run side by side).
Source snapshot: git tag `beta-build-v3`.
