# Not Wasting Unused Credits

The standing backlog. Whenever Ray has spare time/credits, any session can open this
file, pick the top unchecked item that fits the remaining budget, and run it through
the usual loop: Fable specs → Opus workers implement → adversarial verify → check it
off here with a one-line result + date. Items are ordered by (video value × user
value) / cost. Add new items at the appropriate rank, don't just append.

## How to run an item
1. Read CLAUDE.md (orchestration rules) — Fable architects, Opus implements.
2. Write a `tasks/CR-<n>.md` spec referencing REAL current code.
3. Workflow: implement → adversarially verify; screenshots mandatory for anything
   visual (the AO lesson); real-GPU e2e (`E2E_GPU=1`) for anything shader-touching.
4. Check the item off with date + commit hash. Freeze a beta build if it's a big beat.

## The list

### Rendering
- [ ] **GPU rendering (the big one).** Move the F12 path tracer off the CPU worker
      onto the GPU: WebGL2 fragment-shader progressive path tracer (accumulate into
      a float target, same seeded-RNG determinism goals; BVH in textures). Reuse the
      existing tracer's scene/material extraction so F12 gets an engine picker:
      CPU (reference) / GPU. Expect 10–50× on the Vega 7 and a monster video beat.
      Stretch: WebGPU compute backend behind the same picker. Break into ~4 specs:
      scene→texture packing, kernel port, accumulation/present + render window
      wiring, parity harness (SSIM vs CPU reference on the donut).
- [ ] **Tracer denoiser** — post-accumulation bilateral/à-trous pass (normal+albedo
      guided) so low-sample previews look clean; pairs with GPU tracer.
- [ ] **Studio light rig parity** — our studio mode fills inward-facing walls darker
      than Blender's studiolight (known residual from the AO saga). Calibrate rig
      against EEVEE screenshots like we did for AO.
- [ ] **Viewport EEVEE-look upgrades** — soft shadow PCF radius control, contact
      shadows toggle, bloom for emissive.

### Modeling
- [ ] **Boolean modifier (union/difference/intersect)** — builds directly on
      `embedIntersections` (UR3-2): after embedding the intersection loops, classify
      faces inside/outside and discard/flip per operation. The natural sequel to the
      Intersect tool.
- [ ] **Interior-loop embedding for Intersect** — lift the documented v1 limitation
      (face crossed only through its interior gains nothing) via face-with-hole
      splitting (bridge cut from loop to boundary).
- [ ] **Bevel modifier** (non-destructive, reuse ops/bevel core), **Weld** and
      **Decimate-lite** modifiers.
- [ ] **Curve objects** — bezier curves with extrude/bevel profile → mesh; unlocks
      text-on-curve and lathe workflows.
- [ ] **Text objects** — typed text → tessellated glyph meshes (opentype parsing or
      canvas-tracing hack; decide in spec).
- [ ] **Sculpt expansion** — smooth/crease/clay brushes, X-axis symmetry, brush
      falloff curves (we have Inflate/Grab).
- [ ] **Snapping upgrades** — vertex/edge/face snap targets during G/R/S (we only
      have grid snap), with the magnet-chip UI extended to a target picker.

### Animation
- [ ] **Shape keys** — basis + named targets, value sliders, keyframeable.
- [ ] **Follow-path constraint** — object rides a curve (needs Curve objects).
- [ ] **Playback improvements** — frame-rate-locked playback, loop region, audio
      scrub stub.

### IO / infra
- [ ] **glTF import/export** — the interchange format everyone actually uses;
      export unlocks "model in Vibe Blender, use anywhere" for the video outro.
- [ ] **Typed-array mesh core** — EditableMesh on flat arrays; profile first, only
      if big scenes actually hurt.
- [ ] **UV: island pack quality + pinning + live unwrap.**

### Video production support
- [ ] **Demo-scene gallery** — a `?scene=` index page of bundled showcase scenes
      (donut, fly-through, AO comparison) for filming.
- [ ] **In-app shortcut cheat overlay polish** for on-screen capture.

## Done
(move checked items here: date, commit, one line)
