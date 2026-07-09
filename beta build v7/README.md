# Beta Build V7 — "the banded AO build" (2026-07-08)

Frozen for filming the ambient-occlusion before/after. This build contains the
ORIGINAL v1 scattered-sample SSAO with its artifacts: dark gradient wave bands
on floors, stipple on flat faces, grazing-angle self-occlusion.

- Launch: `./launch.sh` (port 5370, opens a chrome-less app window).
- Enable AO: viewport header (right side) ▸ shading dropdown ▸ Ambient
  Occlusion. Radius/Strength sliders included; the banding shows best on a big
  floor plane at radius 0.9 / strength 1.6 with the camera low.
- The fixed version (GTAO-lite per research/AO-RESEARCH.md) lives in the main
  build — run both side by side for the comparison shot.
- Reference artifact screenshot: research/ao-v1-artifacts.png in the repo.
