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
| cube | 512² | 311.15 | 15.127 | 20.6× |
| cube | 960×540 | 561.85 | 26.052 | 21.6× |
| gradient-alpha | 512² | 1059.10 | 163.740 | 6.5× |
| gradient-alpha | 960×540 | 1638.45 | 218.146 | 7.5× |
| donut | 512² | 8166.15 | 0.648 | 12603.7× |
| donut | 960×540 | 15178.00 | 1.948 | 7791.9× |
| area-penumbra | 512² | 323.10 | 1.073 | 301.1× |
| area-penumbra | 960×540 | 588.45 | 2.200 | 267.5× |
| emissive-room | 512² | 356.45 | 1.063 | 335.5× |
| emissive-room | 960×540 | 623.45 | 2.013 | 309.8× |
| glass-gold-hero | 512² | 1763.85 | 0.994 | 1774.9× |
| glass-gold-hero | 960×540 | 2474.30 | 1.987 | 1244.9× |
| dof-two-depth | 512² | 333.65 | 0.988 | 337.9× |
| dof-two-depth | 960×540 | 626.60 | 2.033 | 308.2× |

<!-- LEDGER:REAL-GPU END -->
