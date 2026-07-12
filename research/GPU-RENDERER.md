# GPU path tracer — renderer notes & performance ledger

WebGL2 fragment-shader path tracer (src/renderEngine/gpu/). The CPU tracer
(src/renderEngine/tracer.ts) is the parity spec. Ledgers below are written by
e2e/gpu-parity.mjs — run it with E2E_GPU=1 for the authoritative real-Vega
numbers, and on SwiftShader for the sanity/portability timings.

<!-- LEDGER:REAL-GPU START -->
### Performance ledger — REAL-GPU (2026-07-12)

ms/spp (lower is better) = honest MARGINAL cost of one path-tracer sample at that resolution/scene, EXCLUDING setup (GPU scene upload / CPU prepareScene). GPU = two-point (t(64)−t(16))/48 to cancel the per-render readback+bind overhead; CPU = wall time of 2 full renderSample passes ÷ 2. speedup = CPU ÷ GPU.

| Scene | Resolution | CPU ms/spp | GPU ms/spp | Speedup |
|---|---|---:|---:|---:|
| cube | 512² | 629.80 | 17.215 | 36.6× |
| cube | 960×540 | 1123.60 | 33.163 | 33.9× |
| donut | 512² | 17482.85 | 1.902 | 9191.4× |
| donut | 960×540 | 33223.50 | 3.919 | 8478.1× |
| area-penumbra | 512² | 501.60 | 2.344 | 214.0× |
| area-penumbra | 960×540 | 924.95 | 3.867 | 239.2× |
| emissive-room | 512² | 524.00 | 1.775 | 295.2× |
| emissive-room | 960×540 | 962.80 | 3.358 | 286.7× |
| glass-gold-hero | 512² | 4353.60 | 1.765 | 2467.2× |
| glass-gold-hero | 960×540 | 5508.50 | 4.206 | 1309.6× |
| dof-two-depth | 512² | 557.50 | 2.194 | 254.1× |
| dof-two-depth | 960×540 | 1011.00 | 3.988 | 253.5× |

<!-- LEDGER:REAL-GPU END -->
