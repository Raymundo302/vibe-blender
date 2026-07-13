# GPU path tracer — renderer notes & performance ledger

WebGL2 fragment-shader path tracer (src/renderEngine/gpu/). The CPU tracer
(src/renderEngine/tracer.ts) is the parity spec. Ledgers below are written by
e2e/gpu-parity.mjs — run it with E2E_GPU=1 for the authoritative real-Vega
numbers, and on SwiftShader for the sanity/portability timings.

<!-- LEDGER:REAL-GPU START -->
### Performance ledger — REAL-GPU (2026-07-13)

ms/spp (lower is better) = honest MARGINAL cost of one path-tracer sample at that resolution/scene, EXCLUDING setup (GPU scene upload / CPU prepareScene). GPU = two-point (t(64)−t(16))/48 to cancel the per-render readback+bind overhead; CPU = wall time of 2 full renderSample passes ÷ 2. speedup = CPU ÷ GPU.

| Scene | Resolution | CPU ms/spp | GPU ms/spp | Speedup |
|---|---|---:|---:|---:|
| cube | 512² | 322.45 | 16.331 | 19.7× |
| cube | 960×540 | 592.80 | 27.571 | 21.5× |
| gradient-alpha | 512² | 1164.50 | 166.163 | 7.0× |
| gradient-alpha | 960×540 | 1695.25 | 224.873 | 7.5× |
| donut | 512² | 8819.15 | 0.500 | 17638.3× |
| donut | 960×540 | 16187.15 | 2.335 | 6931.2× |
| area-penumbra | 512² | 338.20 | 1.192 | 283.8× |
| area-penumbra | 960×540 | 617.95 | 2.112 | 292.5× |
| emissive-room | 512² | 366.90 | 1.110 | 330.4× |
| emissive-room | 960×540 | 649.35 | 2.177 | 298.3× |
| glass-gold-hero | 512² | 1889.75 | 1.083 | 1744.4× |
| glass-gold-hero | 960×540 | 2761.60 | 2.162 | 1277.0× |
| dof-two-depth | 512² | 343.35 | 1.085 | 316.3× |
| dof-two-depth | 960×540 | 629.15 | 2.056 | 306.0× |

<!-- LEDGER:REAL-GPU END -->
