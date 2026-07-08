# ANIM-RUN — the camera fly-through dry run (P15-4)

The end-to-end proof that Phase-15 animation works on a real scene: a keyed
camera fly-through over the donut, plus animated key-light power and animated
icing base-colour, scrubbed through the Timeline pane, played back, saved, and
reloaded byte-identically.

Driver: `e2e/p15-flythrough.mjs` (run under flock). Saved scene:
`research/donut-flythrough.vibe.json`. Fixture: `research/donut.vibe.json`
(9 objects — Torus, Icing, Plate, Table, Sprinkle, Camera, Sun, SkyFill,
Bounce; materials Material.001 / DonutBrown / Ceramic / TableGrey).

## What the run does

1. **Load** the frozen donut fixture through the deep-link loader
   (`__app.io.apply`). It already ships a `Camera`, so we just make it active
   (`activeCameraId`) and look through it (`renderer.cameraViewId`). Frame range
   pinned to `[1, 48]`.
2. **Author three animations:**
   - **Camera move** — LocRotScale keyed at frame 1 (the fixture pose) and
     frame 48 (a distinct arc pose: `pos (-2.6, 1.4, -2.2)`, yaw ~-2.4 rad),
     via `InsertKeysCommand` on the camera object (spec allows I / command).
   - **Key-light power** — the `Sun` light, `light.power` keyed **50 → 400**
     via the NEW ● button on the Light tab (channel `light.power`).
   - **Icing base colour** — `material.baseColor.r` keyed **0.9 → 0.1** via the
     NEW ● button on the Material tab (keys r/g/b together).
3. **Scrub** through the **Timeline pane** frame input to frames 1, 24, 48. At
   each frame the posed values match `evalFCurve` of each object's own curves to
   1e-4:

   | frame | camera pos (x,y,z)              | light.power | baseColor.r |
   |------:|--------------------------------|------------:|------------:|
   | 1     | 2.300, 2.115, 2.383            | 50.00       | 0.900       |
   | 24    | -0.098, 1.765, 0.140           | 221.28      | 0.509       |
   | 48    | -2.600, 1.400, -2.200          | 400.00      | 0.100       |

   Rendered-viewport frames 1 vs 48 differ by **587,115** changed pixels
   (camera move + light ramp + colour shift all visible at once).
4. **Playback** — ▶ advances `frameCurrent` (reached ~29 in ~0.5 s) and never
   leaves `[frameStart, frameEnd]`; ⏸ stops it.
5. **Save / reload** — `research/donut-flythrough.vibe.json` (≈379 KB) reloads
   and re-serialises **byte-identical**; all three fcurves and the frame-48 pose
   survive.

Wall time ≈ 12.5 s.

## FIXED-HERE

- **Light tab ● insert-key buttons** (`src/ui/lightTab.ts`) beside **Power** and
  **Color** — one undoable `InsertKeysCommand` at `scene.frameCurrent` for
  `light.power` / `light.color.{r,g,b}`. No-ops with no active light.
- **Material tab ● insert-key buttons** (`src/ui/materialTab.ts`) beside **Base
  Color** (`material.baseColor.{r,g,b}`) and **Roughness** (`material.roughness`).
  No-ops when the active mesh has no assigned material (the frozen default
  `id === -1` is unresolvable, so nothing is keyed — correct).
- The buttons reuse the existing `readChannel`/`writeChannel` channel resolver
  and the `InsertKeysCommand` undo entry — no new core. This is the missing UI
  affordance the P15-4 spec called out ("payload animation WORKS — what's
  missing is UI affordances + proof").

## PUNCH-LIST (gaps found, not fixed — out of P15-4's file scope)

- **One-time euler↔quat settle on transform curves.** Transform rotation is
  stored as a **quaternion** in the object transform but keyed as **euler**
  (`rotation.{x,y,z}`). The sampler (`applyAnimation`) rebuilds the quaternion
  from the euler channels — and, because ANY transform key makes it rebuild the
  WHOLE transform, it re-derives the quat from the *base* rotation's euler too.
  Numbers are serialised rounded to 6 decimals (`sceneJson.num`). Net effect:
  the very first save straight after authoring stores a quat derived from
  full-precision euler, but every reload re-derives it from the 6-dp-rounded
  euler keys — a **<1e-6 one-time drift**. Measured: `A ≠ B` but `B == C`
  (stable after the first reload). The dry run settles once (apply→serialize)
  **before** writing the file, so the shipped `donut-flythrough.vibe.json` is
  the round-trip fixed point and reloads byte-identical. A real fix belongs in
  core (`sampler.ts` / `sceneJson.ts`, both out of this task's file set): either
  store rotation curves as quats, or only rebuild the rotation when a rotation
  channel is actually keyed, or round euler keys and quats consistently.
- **No dope sheet.** The Timeline pane shows one diamond per keyed frame per
  object (union of channels) but there is no per-CHANNEL row expansion, no
  channel-name gutter, and no F-curve graph editor — so you cannot see or edit
  an individual channel's handles. Curve interpolation (`bezier`/`linear`/
  `constant`) is authorable in data + honoured by `evalFCurve`, but there is no
  UI to pick it or to edit bezier tangents (they are auto/flat only).
- **Easing wishes.** Keys default to `bezier` with flat auto-tangents, so a
  two-key ramp is a smooth ease-in/ease-out (visible in the 221.28 power / 0.509
  colour midpoints above — not the linear 225 / 0.5). There is no easing preset
  menu (ease-in only, ease-out only, back, bounce) and no per-key handle drag.
- **Camera look-through vs viewport camera.** The fly-through is only visible in
  the viewport when `renderer.cameraViewId` points at the animated camera; there
  is no one-click "look through active camera + play" affordance from the
  Timeline pane (Numpad0 exists in the viewport but is a separate gesture).
- **Perf.** Scrubbing re-poses via `applyAnimation` over every object every
  frame (fine here — 9 objects). No dependency-graph gating: an object with no
  curves is skipped, but a heavy modifier stack on a keyed object re-evaluates
  each scrubbed frame. The F12 path tracer does not animate — it renders the
  current posed frame only (no keyframe-range batch render / turntable export).

## Honesty notes

- The payload channels (light power, material base colour) are keyed through the
  **actual new UI buttons**, so the run exercises the P15-4 deliverable rather
  than the underlying command. The camera transform is keyed via
  `InsertKeysCommand` (an in-page dynamic import), which the spec explicitly
  permits ("I / InsertKeysCommand on the camera object").
- The frame-1-vs-48 render diff is non-vacuous: three independent things change
  (camera pose, light power, base colour). Even a static viewport camera would
  differ on the light+colour alone; the look-through makes the camera move
  visible too.
- No core files were modified. The euler↔quat settle above is a pre-existing
  engine property surfaced (not introduced) by this run; it is documented rather
  than papered over, and the saved scene is settled so its round-trip is genuine.
