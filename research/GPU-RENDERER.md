# GPU path tracer — renderer notes & performance ledger

WebGL2 fragment-shader path tracer (src/renderEngine/gpu/). The CPU tracer
(src/renderEngine/tracer.ts) is the parity spec. Ledgers below are written by
e2e/gpu-parity.mjs — run it with E2E_GPU=1 for the authoritative real-Vega
numbers, and on SwiftShader for the sanity/portability timings.

<!-- LEDGER:REAL-GPU START -->
### Performance ledger — REAL-GPU (2026-07-12)

ms/spp (lower is better); speedup = CPU ÷ GPU. GPU timed at 16 spp, CPU at 2 spp (per-sample cost is spp-independent).

| Scene | Resolution | CPU ms/spp | GPU ms/spp | Speedup |
|---|---|---:|---:|---:|
| cube | 512² | 480.60 | 1.231 | 390.3× |
| cube | 960×540 | 849.80 | 0.594 | 1431.2× |
| donut | 512² | 18467.45 | 0.581 | 31772.0× |
| donut | 960×540 | 34650.45 | 0.781 | 44352.6× |
| area-penumbra | 512² | 573.90 | 0.450 | 1275.3× |
| area-penumbra | 960×540 | 979.65 | 0.800 | 1224.6× |
| emissive-room | 512² | 503.15 | 0.631 | 797.1× |
| emissive-room | 960×540 | 933.45 | 1.000 | 933.4× |
| glass-gold-hero | 512² | 4158.35 | 0.431 | 9642.6× |
| glass-gold-hero | 960×540 | 6339.55 | 1.325 | 4784.6× |
| dof-two-depth | 512² | 556.80 | 0.387 | 1436.9× |
| dof-two-depth | 960×540 | 1063.50 | 0.844 | 1260.4× |

<!-- LEDGER:REAL-GPU END -->
