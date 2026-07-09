# Beta Build V8 — "the second AO fix attempt" (2026-07-08)

The state of ambient occlusion after two Opus repair rounds: GTAO-lite horizon
integration, Interleaved Gradient Noise, R8+dither / R16F target, plane-relative
bilateral blur, and the ray-relative coplanarity gate that zeroed the
grazing-angle false occlusion ON THE TEST RIG — while Ray still saw problems on
his real AMD Vega 7. Frozen mid-saga for the video: both fix attempts passed
every numeric check and SwiftShader screenshot review; the lesson is that the
verification loop, not the code, was the weak link.

- Launch: `./launch.sh` (port 5380).
- AO: viewport header shading dropdown ▸ Ambient Occlusion (+ Radius/Strength).
- Companion builds: `beta build v7` (port 5370) = the ORIGINAL banded SSAO.
- The story: research/ao-v1-artifacts.png → AO-RESEARCH.md → ao-v3-artifacts.png
  → ao-v4-*.png (rig-clean, user-unsatisfied).
