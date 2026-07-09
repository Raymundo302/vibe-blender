# Real-Time Ambient Occlusion — State of the Art & Implementation Blueprint

Research worker report, 2026-07-08. **Research only — no source files were modified.**

Context: the viewport SSAO in `src/render/passes/aoPass.ts` (v2) has been built twice and the
user still reports *"a lot of banding — dark band gradient waves"* on his AMD Vega 7 iGPU. This
report surveys what shipping DCCs/engines do, ranks the root causes of our specific banding, and
gives a concrete blueprint that fits our constraints (WebGL2 core + common extensions, single-frame
redraw-on-demand, ≲2–3 ms at ~2560×1080, single AO factor texture sampled by `gl_FragCoord`,
radius + strength sliders).

Diagnostic note: `research/ao-v1-artifacts.png` shows the two symptoms directly — **(a)** dark,
roughly horizontal *wave* bands marching across the ground plane (iso-depth aligned), and **(b)** a
fixed **stipple/dot** pattern on the near cube faces (the 4×4 tiled rotation noise that the 4×4 blur
never fully averages out). Both are present in v2's design too.

---

## 1. TL;DR — the recommendation

**Replace the 16-sample scattered-hemisphere kernel with a horizon-based GTAO integrator, drive its
per-pixel rotation/offset with Interleaved Gradient Noise (IGN) instead of a tiled noise texture,
render AO into an `R8` (or `R16F`) single-channel target with a tiny per-pixel output dither, and
denoise with a wider *depth-relative* bilateral (or 2-pass à-trous) blur.**

Concretely, the combo to build:

| Choice | What | Why it beats v2 |
|---|---|---|
| **Algorithm** | **GTAO-lite**: 2–3 *slices* (directions), 4–6 steps/side, cosine-weighted horizon integration (Visibility-Bitmask variant optional). | Horizon integration yields a **continuous** AO value per pixel instead of `k/16` discrete levels → the single biggest cure for "gradient stepping". Matches Blender EEVEE, Unreal, Unity URP, Godot's successor path. |
| **Noise** | **IGN** (`fract(52.9829189*fract(0.06711056*x+0.00583715*y))`) as a per-pixel rotation angle + step offset. **Drop the 4×4 texture.** | Per-pixel low-discrepancy noise decorrelates every pixel (kills the fixed stipple), yet a small bilateral removes it cleanly. Tiled 4×4 noise is *structured* → aliases with geometry → the stipple you see. |
| **Denoise** | **Depth-aware bilateral with a depth-*relative* threshold**, radius ≥ noise period; ideally split into a separable/à-trous 2-pass. | v2's blur uses a fixed `abs(linearZ−centerZ) < 0.5` reject that **fails at grazing angles**, so the floor never gets blurred → bands survive. A relative threshold keeps the blur alive on receding planes. |
| **Target format** | **`R8`** (core, no extension) with **ordered/IGN dither** on write; upgrade to **`R16F`** where `EXT_color_buffer_float` exists. | 8-bit + already-few AO levels = visible steps on wide soft gradients. Dither converts steps into imperceptible noise; R16F removes the quantization entirely. |
| **Resolution** | Full-res to start (thin wires/edges in a modeling viewport). Half-res + joint-bilateral upsample is the perf lever if GTAO+blur exceeds budget. | Full-res avoids haloing thin features; GTAO at 2 slices is cheap enough on Vega 7 (see §3). |

Why this is the right target: it is exactly the family every current engine converged on
(GTAO/horizon-based, see §2), the math produces smooth AO by construction, and each banding cause
in §3 is addressed by a specific piece above. It stays single-frame (no TAA) because GTAO's spatial
noise + a wide bilateral is designed to look acceptable without a temporal pass (XeGTAO's
own fallback when TAA is absent — see [XeGTAO](https://github.com/GameTechDev/XeGTAO)).

---

## 2. Banding root-cause ranking for OUR symptoms

Ordered by how plausibly each explains *"dark gradient wave bands on the floor that our SwiftShader
e2e didn't flag"*, with the fix:

**#1 — Discrete AO levels from too few samples (the "stepping" itself).**
16 hemisphere samples → occlusion is `count/16`, i.e. only **17 possible raw values**. After
`pow(1-occ,1.4)`, the strength remap, and the distance-fade `smoothstep(30,60)` ramp stretched
across the whole floor, those 17 levels land at different screen depths and read as **discrete
bands** exactly where the fade gradient crosses a level boundary — "gradient waves". This is the
classic low-sampling-rate banding Quilez and IceFall describe
([iquilezles.org/articles/ssao](https://iquilezles.org/articles/ssao/),
[Know your SSAO artifacts](https://mtnphil.wordpress.com/2013/06/26/know-your-ssao-artifacts/)).
*Fix:* horizon-based **continuous** integration (GTAO) — no discrete count. Secondarily, more
samples + dither. **This is the primary cause.**

**#2 — Bilateral blur dies at grazing angles, so the floor is never smoothed.**
The blur rejects taps with `abs(linearZ − centerZ) < 0.5` (a **fixed** world-space threshold). On a
receding floor the per-pixel depth delta between neighbors is large, so nearly every tap is
rejected → the blur is a no-op there → raw discrete/tiled AO shows through as iso-depth bands (the
"waves" follow lines of constant depth). Meanwhile the near cube faces (fronto-parallel, small depth
delta) *do* blur — which is why the stipple is worst on the faces but the *bands* are worst on the
floor. *Fix:* make the threshold **depth-relative** (`< k*centerViewZ` or compare against the
plane predicted by depth+normal), and widen the kernel beyond the noise period. **Strong contributor
to the floor-specific look.**

**#3 — 8-bit `RGBA8` AO target quantization with no dither.**
256 levels is plenty for a smooth field, but combined with #1 the *effective* level count is tiny,
and any smooth ramp (the distance fade, or GTAO's soft cavity gradients) written to 8-bit without
dithering produces textbook posterization. *Fix:* `R8`+dither now, `R16F` where available. Adding a
**±0.5 LSB IGN dither before the 8-bit write** converts hard steps into sub-perceptual noise — the
standard cure ([Bart Wronski, real-world 2D quantization
dithering](https://bartwronski.com/2016/10/30/dithering-part-three-real-world-2d-quantization-dithering/)).

**#4 — Structured/tiled 4×4 noise aliasing with geometry (the stipple).**
The 4×4 LCG rotation texture repeats every 4 px. A repeating pattern beats against screen-space
geometry and, because it's only 16 distinct rotations, the AO it produces has a **fixed low-frequency
residual** the matched 4×4 box blur cannot remove (box-averaging 16 *different* rotations still
leaves structure once the bilateral rejects some taps). This is the dotted pattern on the cube.
*Fix:* per-pixel **IGN** (low-discrepancy over every overlapping 3×3 block — see
[demofox](https://blog.demofox.org/2022/01/01/interleaved-gradient-noise-a-different-kind-of-low-discrepancy-sequence/))
or a blue-noise texture; both decorrelate neighbors so a small bilateral fully removes them.

**#5 — Linear-depth reconstruction error at distance.**
`viewPos()` reconstructs from a 24-bit depth buffer; at far distances depth precision is coarse, so
the range check and `sceneZ` comparison quantize → adds noise/bands far out. Minor here (the fade at
30–60 units already hides most of it) but real. *Fix:* GTAO works in viewspace with a prefiltered
depth MIP; keeping the near/far ratio tight helps.

**Why SwiftShader hid it:** the artifacts are **perceptual banding on smooth gradients**, and our
e2e checks read pixel *values* / pass-fail thresholds rather than measuring *distinct-level counts
across a region that should be smooth*. SwiftShader is also fp32-clean and does exactly the 8-bit
write we ask, so it produces the *same* stepped values — but nobody's eye is in the loop, and no
gradient-histogram metric exists. §5 fixes the verification gap.

---

## 3. Algorithm survey (what ships, with citations)

| Algorithm | Used by | Core idea | Taps | Noise / denoise | Artifact profile |
|---|---|---|---|---|---|
| **Classic hemisphere SSAO** (ours) | Old UE/Unity, tutorials | Scatter N samples in oriented hemisphere, count occluded | 8–64 | tiled rotation tex + bilateral blur | **Banding from few discrete levels**, haloing, stipple from tiled noise. [LearnOpenGL SSAO], [iquilezles](https://iquilezles.org/articles/ssao/) |
| **HBAO / HBAO+** | NVIDIA GameWorks era | March along directions on the depth heightfield, find max **horizon angle**, integrate | ~4 dirs × 4–6 steps | interleaved/dither + blur | Smoother than SSAO; can over-darken; needs good bias. |
| **GTAO** (Jimenez et al. 2016) | **Unreal** (`r.AmbientOcclusion.Method 1`), **Unity URP**, **Blender EEVEE**, Godot successor | Radiometrically-correct AO: per-slice **arc/horizon integration** with a cosine weight; optional bent normals | ~2–3 slices × 3–6 steps (≈18 spp) | IGN/blue-noise + spatial (5×5) + TAA when present | Ground-truth match, **continuous** (no stepping), ~0.5 ms console. [Jimenez 2016], [scribd GTAO PDF](https://www.scribd.com/document/862516092/gtao) |
| **XeGTAO** (Intel, MIT) | reference impl, ports everywhere | GTAO + **depth MIP prefilter** + Hilbert→R2 spatial noise + 5×5 depth-aware denoise | 18 spp (hi), 8 spp (lo) | Hilbert-curve R2 quasi-random; **5×5 spatial denoise**, TAA optional | **2.39 ms @1080p on Intel Iris Xe iGPU**; best documented single-frame recipe. [github.com/GameTechDev/XeGTAO](https://github.com/GameTechDev/XeGTAO) |
| **Visibility Bitmask** (Bavoil-style, 2023) | research → engines | GTAO but a **32-bit sector bitmask** tracks occluded sectors incl. thickness → less light-leak | 4 slices × 4 steps typical | IGN per-pixel jitter | GTAO quality + thickness; simple GLSL exists. [arXiv 2301.11376](https://arxiv.org/pdf/2301.11376), [cybereality GLSL](https://cybereality.com/screen-space-indirect-lighting-with-visibility-bitmask-improvement-to-gtao-ssao-real-time-ambient-occlusion-algorithm-glsl-shader-implementation/) |
| **ASSAO** (Intel, deprecated) | **Godot 4** (faithful port) | HBAO-like solid-angle model + **2×2 deinterleaved** rendering + depth MIPs, preset-scaled taps | scalable | dither + smart blur | Fast/scalable; **superseded by XeGTAO** per Intel. [github.com/GameTechDev/ASSAO](https://github.com/GameTechDev/ASSAO), [Intel ASSAO](https://www.intel.com/content/www/us/en/developer/articles/technical/adaptive-screen-space-ambient-occlusion.html) |
| **FidelityFX CACAO** (AMD) | AMD SDK titles | Highly optimized ASSAO derivative, 4 quality presets, deinterleaved | scalable | dither + adaptive blur | AMD-tuned (relevant to Vega!) but heavier integration than we need. |
| **MSSAO / multi-scale, SSDO, VAO** | niche | multi-radius mips (MSSAO); directional bounce (SSDO); volumetric (VAO) | varies | varies | MSSAO fixes large-radius banding via mip pyramid; SSDO adds color bleed (overkill for a cavity look). |

**Engine consensus (question 1):** the industry converged on **horizon-based / GTAO**. Blender
EEVEE computes AO with **GTAO** and (EEVEE-Next) adds screen-space ray-traced GI/AO
([Blender 5.1 raytracing manual](https://docs.blender.org/manual/en/latest/render/eevee/render_settings/raytracing.html),
[EEVEE-Next AO PR #108398](https://projects.blender.org/blender/blender/pulls/108398)). Unreal
defaults to SSAO but ships **GTAO** via `r.AmbientOcclusion.Method 1`. Unity URP shipped **GTAO**
(preview) alongside its older MSVO/ASSAO-derived SSAO. Godot 4 ships a **faithful Intel ASSAO** port
(HBAO-family) and has open work to move forward. **Top-2 for us: GTAO-lite (primary) and the
Visibility-Bitmask GTAO variant (if we want thickness/less leak for the same cost).**

### Core math sketch — GTAO-lite (the recommended integrator)

For pixel P (viewspace pos `p`, normal `n`), pick `S` slice directions in screen space. For each
slice direction `ω` (a 2D screen dir rotated by the per-pixel IGN angle):

1. Define the slice plane spanned by view vector `v = normalize(-p)` and `ω`. Project `n` into it.
2. March `K` steps outward along `+ω` and `−ω` in screen space (step length from `radius` projected
   to pixels, jittered by IGN so steps don't align). At each tap read depth → viewspace sample `s`,
   form `d = normalize(s − p)`, track the **max horizon cosine** on each side:
   `cHorizon = max(cHorizon, dot(d, v))` (with a `thickness`/falloff so distant taps don't count).
3. Convert the two horizon cosines to angles `h1,h2`, clamp to the normal's hemisphere in the slice,
   and integrate the cosine-weighted visible arc analytically:
   `innerIntegral = 0.25*(-cos(2h1−γ)+cos γ+2 h1 sin γ) + 0.25*(-cos(2h2−γ)+cos γ+2 h2 sin γ)`
   where `γ` is the angle of the projected normal in the slice (the closed form from Jimenez 2016).
4. Weight each slice by the projected-normal length and average over slices.

The result is a **smooth scalar in [0,1]** — no `k/N` quantization. (Visibility-Bitmask replaces
steps 2–3 with `occlusion |= sectorBits(h1,h2)` over a 32-bit mask and counts set bits — see
[cybereality GLSL](https://cybereality.com/screen-space-indirect-lighting-with-visibility-bitmask-improvement-to-gtao-ssao-real-time-ambient-occlusion-algorithm-glsl-shader-implementation/);
their default was 4 slices, 4 samples, radius 4, thickness 0.5.)

### IGN — the noise (exact formula)

Per-pixel, deterministic, low-discrepancy over every 3×3 block, ideal for single-frame dithering and
sample jitter ([Jimenez, "Next Generation Post Processing in CoD:AW", SIGGRAPH
2014](https://www.iryoku.com/next-generation-post-processing-in-call-of-duty-advanced-warfare/);
[demofox](https://blog.demofox.org/2022/01/01/interleaved-gradient-noise-a-different-kind-of-low-discrepancy-sequence/)):

```glsl
// returns [0,1)
float ign(vec2 p) {
  return fract(52.9829189 * fract(0.06711056 * p.x + 0.00583715 * p.y));
}
```

Use `angle = ign(gl_FragCoord.xy) * 2π` for the slice rotation, and a second decorrelated value
(e.g. `ign(gl_FragCoord.xy + 1.0)` or `fract(ign*ϕ)`) for the per-step offset. IGN beats a tiled
texture for single-frame because it is *per-pixel* (no repeat period to alias) yet still
low-discrepancy so a tiny blur removes it. Blue-noise textures (e.g. 64×64 from Christoph Peters'
free set) are the other state-of-practice option and are marginally better for pure dithering; IGN
wins on being free (dot+fract, no texture bind) and is what CoD/Unity use.

---

## 4. Denoise without temporal (question 4)

State of practice for single-frame AO cleanup:

- **Depth-aware (cross-bilateral) blur** — weight taps by depth similarity so silhouettes are
  preserved. This is what we have; the *fix* is the **relative threshold** (§2 #2) and a **kernel
  wider than the noise's characteristic period** (with per-pixel IGN the period is ~1 px so even a
  4–5 px Gaussian works; matching a 4×4 box to a 4×4 tile as v2 does is fragile).
- **À-trous / edge-avoiding wavelet** (Dammertz 2010) — 2–3 passes with increasing tap spacing,
  each depth+normal weighted. Cheap, separable-ish, removes low-frequency residual that a single
  small box leaves. Good upgrade if one bilateral pass isn't clean.
- **XeGTAO's 5×5 depth-aware spatial denoise** is the concrete reference: one (or two) 5×5 passes
  with edge weights derived from the AO pass, explicitly designed to be the *only* denoise when TAA
  is absent ([XeGTAO](https://github.com/GameTechDev/XeGTAO)). Copy this shape.
- **Half-res + high sample count + joint upsample** — do AO at half-res with more taps, then a
  joint (depth-guided) bilateral upsample. Cheaper, but see §5 caveat on thin geometry.

We must **not** use TAA (single-frame, redraw-on-demand). If we ever wanted temporal: it only helps
frame-2+ and *must* look right on frame 1 after every camera move, so it can only ever be a
progressive *refinement* layered on a spatially-complete frame-1 image — not a dependency. Given the
budget, skip it; GTAO spatial + wide bilateral is enough.

---

## 5. Resolution strategy (question 5)

- **Full-res AO + full-res bilateral** — best for a modeling viewport: wires, loop-cut previews,
  small bevels, and gizmos are thin, and half-res AO + upsample tends to **halo or drop** sub-2px
  features and shimmer on edges. GTAO at 2 slices/4 steps is affordable full-res on Vega 7 (XeGTAO's
  18spp hi-preset is 2.39 ms @1080p on comparable Iris Xe; our 2560×1080 at a lighter preset lands
  in budget).
- **Half-res AO + joint-bilateral upsample** — the perf lever if we blow the 2–3 ms budget: ~4×
  fewer AO invocations, guided upsample using full-res depth. Keep a **full-res** depth for the
  upsample weights and consider computing AO full-res only where depth discontinuities are dense.
  Recommendation: **ship full-res first, measure with the §6 timer, drop to half-res only if needed.**

---

## 6. Implementation blueprint for our codebase

Target file: `src/render/passes/aoPass.ts` (drop-in — the consumer contract stays: one AO factor
texture multiplied into shading, sampled by `gl_FragCoord`; `radius` world-units + `strength`
sliders unchanged). Keep `beginDepth/setObject/compute/texture/white` public surface identical.

### Pass structure (3 passes, same count as v2)

1. **Prepass (keep, minor change).** Same depth+view-normal prepass. Keep `DEPTH_COMPONENT24` depth
   and the `RGBA8` view-normal target (normal*0.5+0.5). *Optional* perf upgrade later: a depth MIP
   chain (XeGTAO PrefilterDepths) for far taps — skip for v3.
2. **GTAO pass (rewrite the SSAO frag).** Fullscreen. Reconstruct viewspace pos from depth, read
   view normal, compute IGN angle, loop `S` slices × `K` steps/side doing horizon integration.
   Output the AO scalar to an **`R8`** target with output dither. This replaces the 16-sample kernel
   loop and the `u_kernel[16]` uniform and the `u_noise` tiled texture entirely.
3. **Denoise pass (rewrite the blur).** Depth-aware bilateral, **depth-relative threshold**, 5×5
   (or two à-trous passes 3×3 @ spacing 1 then 2). Output `R8` (+dither) or `R16F`.

### Render-target formats (WebGL2 + extension notes)

- **Depth:** `DEPTH_COMPONENT24` (core) — unchanged.
- **View normals:** `RGBA8` (core) — unchanged. (Could pack to `RG8` octahedral to save bandwidth;
  not necessary.)
- **AO (ssao + blur targets):** **`R8`** — *color-renderable in WebGL2 core, no extension*
  ([WebGL2 spec](https://registry.khronos.org/webgl/specs/latest/2.0/)). Halves bandwidth vs the
  current `RGBA8` AO targets. **Add IGN dither before the 8-bit write.**
  - **Preferred where available:** `R16F`. Color-renderable **only with `EXT_color_buffer_float`**
    ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/EXT_color_buffer_float)); linear filter
    needs `OES_texture_float_linear`/half-float-linear (both ~universal on desktop, ~99% per
    webglstats, but **not guaranteed** — Vega 7 desktop has them). Removes 8-bit quantization
    outright.
  - **Fallback ladder:** try `R16F` (if `EXT_color_buffer_float`) → else `R8`+dither → (both are
    fine; `R8`+dither is visually indistinguishable from `R16F` for AO). Our `Framebuffer` helper
    currently makes `RGBA8`; add a format param. Feature-detect once at construction:
    `gl.getExtension('EXT_color_buffer_float')`.

### Shader-level details

**GTAO frag (replaces `SSAO_FRAG`):**

- Slices `S = 2` (Draft) or `3` (default); steps `K = 4` per side. `spp = 2*S*K = 16–24`.
- Per-pixel rotation: `float a = ign(gl_FragCoord.xy) * 6.2831853;` build screen-space slice dir
  `vec2 dir = vec2(cos(a), sin(a))` and rotate by `π/S` per slice.
- Step length in pixels from `radius`: project `radius` viewspace units at `P.z` to screen texels;
  jitter first step by `ign2` in `[0,1)` so step rings don't align across pixels.
- Horizon: track `max(dot(normalize(s−P), v))` per side with a `thickness`/`falloff` so a tap that's
  far *behind* doesn't create a false horizon (kills haloing). Integrate with the Jimenez closed
  form (§3). Keep the existing **distance fade** `1 - smoothstep(farStart, farEnd, viewDepth)` but
  raise/scale to taste; it's fine once AO underneath is continuous.
- Final: `ao = pow(clamp(visibility,0,1), strengthCurve)`; map `strength` slider as v2 does
  (`ao = 1 - (1-ao)*strength`). **Then dither:** `ao += (ign(fc) - 0.5) * (1.0/255.0);` before write
  (only meaningful for `R8`).

**Denoise frag (replaces `BLUR_FRAG`):** 5×5, weight
`w = exp(-abs(linearZ(tap)-centerZ) / (centerZ * kRel + eps))` with `kRel ≈ 0.02` (relative → survives
grazing floors), optionally multiply by a normal-dot weight from the normal target. Normalize by
`wsum`. This is the single most important floor-band fix after switching to GTAO.

### Tuning parameters & defaults (mapped to existing sliders)

- **`radius`** (world units) — unchanged slider. Default keep ~`0.55`; GTAO clamps the *screen*
  march so large radii stay stable. Internally clamp max screen march to ~64 px to bound cost.
- **`strength`** — unchanged slider; keep the `1 - (1-ao)*strength` remap so 0=off, 1=default,
  2=strong (clamped). Consider default `1.0` and a `power` of ~1.5.
- New internal (not necessarily exposed): `slices` (2 draft / 3 default), `stepsPerSide=4`,
  `thickness≈0.25*radius`, `farFade=[30,60]` (keep), `blurRel=0.02`.

### Ordered work plan

1. **Add `R8`/`R16F` support to `Framebuffer`** (format param + `EXT_color_buffer_float` detect).
   *Smallest change, immediately lets us test format effect in isolation.*
2. **Add output dither** to the *current* v2 SSAO write + switch AO targets to `R8`. Re-shoot the
   floor. (Cheap experiment — quantifies how much of the banding is #3 alone.)
3. **Swap tiled-noise → IGN** for the rotation in the current SSAO shader (delete `aoNoise`/`u_noise`).
   Re-shoot the cube faces — expect the stipple to break into fine grain the blur removes.
4. **Fix the bilateral**: depth-relative threshold + widen to 5×5. Re-shoot the floor — expect the
   iso-depth bands to vanish.
5. **Replace the kernel loop with GTAO-lite** horizon integration (2–3 slices, closed-form).
   This removes the discrete-level cause (#1) structurally.
6. **Measure** with `EXT_disjoint_timer_query_webgl2` (or CPU `performance.now` around a `finish`);
   if > budget, drop to half-res AO + joint upsample (§5).
7. **Verification (§below) + e2e**; freeze.

Steps 2–4 are independently shippable improvements even before the GTAO rewrite — do them first so
each cause is validated on real hardware.

---

## 7. Verification plan that actually catches banding on real hardware

Our SwiftShader e2e never flagged this because it checks values, not *smoothness*. Add:

1. **Gradient-histogram / distinct-level metric.** In a headless/real-GPU capture, `readPixels` a
   region that *should* be a smooth gradient (a strip of the ground plane receding from camera, and
   a fronto-parallel cube face). Compute the AO luminance along the strip and **count distinct
   quantized levels** and the **max run-length at a single level** (a plateau = a band). A smooth
   field should show many closely-spaced levels with short runs; banding shows few levels with long
   plateaus. Assert `distinctLevels > T` and `maxRun < R`. This is the metric that would have caught
   v2. (Also compute a **local gradient/derivative** and flag pixels where |Δ| jumps then flatlines.)
2. **FFT / row-variance for the stipple.** Take a fronto-parallel face patch, subtract a blurred
   copy, and measure residual energy at the 4-px (tile) frequency — non-zero = structured noise
   surviving. Should collapse to broadband grain after the IGN switch.
3. **Run on real hardware, not just SwiftShader.** Add a manual/opt-in path that runs the AO capture
   in the user's actual Chrome/Firefox on the Vega 7 (or at least a non-SwiftShader ANGLE backend)
   and dumps the histogram numbers. SwiftShader can stay for logic/regression; the banding metric
   needs a real rasterizer + the 8-bit write path.
4. **Screenshot matrix.** Render the standard cube-on-floor at `radius ∈ {0.25, 0.55, 1.0, 2.0}` ×
   `strength ∈ {0.5, 1, 2}`, half-res and full-res, `R8` vs `R16F`, dither on/off — save PNGs to
   `research/` and eyeball for: floor wave-bands, cube-face stipple, halos around the cube
   silhouette, over-darkening in the box interior, and thin-feature dropout.
5. **What to eyeball specifically:** (a) the receding floor must fade smoothly with *no* horizontal
   steps; (b) flat faces must be clean grain, not fixed dots; (c) contact shadow where cube meets
   floor should be a soft continuous darkening, not a stair-step; (d) no bright halo ringing the
   cube; (e) wireframe/edit-mode edges must not smear.

---

## Sources

- Jimenez et al. 2016, *Practical Realtime Strategies for Accurate Indirect Occlusion* (GTAO): [scribd copy](https://www.scribd.com/document/862516092/gtao); overview via [DeepWiki GTAO](https://deepwiki.com/gkjohnson/threejs-sandbox/2.2-ground-truth-ambient-occlusion-(gtao))
- Intel XeGTAO (MIT reference impl, passes/noise/denoise/perf): https://github.com/GameTechDev/XeGTAO ; shader [vaGTAO.hlsl](https://github.com/GameTechDev/XeGTAO/blob/master/Source/Rendering/Shaders/vaGTAO.hlsl), [XeGTAO.hlsli](https://github.com/GameTechDev/XeGTAO/blob/master/Source/Rendering/Shaders/XeGTAO.hlsli)
- Screen Space Indirect Lighting with Visibility Bitmask: [arXiv 2301.11376](https://arxiv.org/pdf/2301.11376); GLSL walkthrough: [cybereality](https://cybereality.com/screen-space-indirect-lighting-with-visibility-bitmask-improvement-to-gtao-ssao-real-time-ambient-occlusion-algorithm-glsl-shader-implementation/)
- Intel ASSAO (Godot's basis): [Intel article](https://www.intel.com/content/www/us/en/developer/articles/technical/adaptive-screen-space-ambient-occlusion.html), [github.com/GameTechDev/ASSAO](https://github.com/GameTechDev/ASSAO)
- Blender EEVEE AO/GTAO + raytracing: [Blender 5.1 raytracing manual](https://docs.blender.org/manual/en/latest/render/eevee/render_settings/raytracing.html), [EEVEE-Next AO PR #108398](https://projects.blender.org/blender/blender/pulls/108398)
- Interleaved Gradient Noise (formula, low-discrepancy, animation): [demofox](https://blog.demofox.org/2022/01/01/interleaved-gradient-noise-a-different-kind-of-low-discrepancy-sequence/); [Jimenez, Next-Gen Post in CoD:AW, SIGGRAPH 2014](https://www.iryoku.com/next-generation-post-processing-in-call-of-duty-advanced-warfare/)
- SSAO banding causes & fixes: [Inigo Quilez, SSAO](https://iquilezles.org/articles/ssao/); [IceFall, Know your SSAO artifacts](https://mtnphil.wordpress.com/2013/06/26/know-your-ssao-artifacts/); [Godot SSAO banding issue #34624](https://github.com/godotengine/godot/issues/34624)
- Quantization dithering: [Bart Wronski, Dithering part 3](https://bartwronski.com/2016/10/30/dithering-part-three-real-world-2d-quantization-dithering/)
- WebGL2 render-target formats: [WebGL2 spec](https://registry.khronos.org/webgl/specs/latest/2.0/); [EXT_color_buffer_float (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/EXT_color_buffer_float)
- Depth-only SSAO for WebGL forward renderers (implementation reference): [Better Programming / Medium](https://medium.com/better-programming/depth-only-ssao-for-forward-renderers-1a3dcfa1873a)
