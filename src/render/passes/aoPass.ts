import { Shader } from '../gl/Shader';
import { EmptyVao } from '../gl/VertexArray';
import { Framebuffer, floatColorRenderable, type FboFormat } from '../gl/Framebuffer';
import type { Mat4 } from '../../core/math/mat4';
import { SDF_RES } from '../sdf';
import { MAX_SDF_OBJECTS, SDF_ATLAS_W, SDF_ATLAS_H, SDF_ATLAS_D, type SdfSceneData } from '../sdfAtlas';

/**
 * Screen-space ambient occlusion for the shaded viewport modes (the "AO"
 * checkbox in the shading dropdown). Three stages per frame when enabled:
 *
 *   1. prepass — the visible meshes into a canvas-sized target that writes BOTH
 *      a depth texture AND view-space normals into an RGBA8 color attachment
 *      (normal*0.5+0.5). Real geometric normals, not screen derivatives.
 *   2. GTAO — fullscreen horizon-based integrator (Jimenez 2016 "Ground-Truth
 *      AO"). For SLICES screen-space directions rotated per-pixel by Interleaved
 *      Gradient Noise, it marches STEPS/side finding the maximum horizon cosine,
 *      then integrates the cosine-weighted visible arc in closed form. This is a
 *      CONTINUOUS scalar in [0,1] — no k/N discrete levels — which is the cure
 *      for the "gradient wave" banding the old 16-sample scattered kernel showed.
 *      Output is a single-channel R8 (with ±0.5-LSB IGN dither) or R16F target.
 *   3. denoise — a 5×5 depth-aware bilateral whose edge weight is the sample's
 *      distance to the CENTER's tangent plane (predicted from depth+normal). A
 *      plane-relative weight survives grazing/receding floors where the old
 *      fixed abs(z-diff) threshold rejected every tap, leaving raw bands.
 *
 * The shaded passes then multiply their color by the denoised AO, sampled by
 * gl_FragCoord. Deliberately "viewport cavity" quality — not a beauty render.
 *
 * References: Jimenez et al. 2016 (GTAO), Intel XeGTAO, IGN (Jimenez CoD:AW 2014).
 */

const BLUR_TAPS = 6;   // separable denoise: taps each side, each blur pass

/** Map the "Samples" pref (spp = 2*slices*steps) to a (slices, steps) pair. */
export function sampleBudget(samples: number): { slices: number; steps: number } {
  if (samples <= 16) return { slices: 2, steps: 4 };
  if (samples <= 32) return { slices: 2, steps: 8 };
  if (samples <= 48) return { slices: 3, steps: 8 };
  if (samples <= 64) return { slices: 4, steps: 8 };
  if (samples <= 80) return { slices: 4, steps: 10 };
  return { slices: 4, steps: 12 };
}

const PRE_VERT = /* glsl */ `#version 300 es
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec3 a_normal;
uniform mat4 u_model;
uniform mat4 u_view;
uniform mat4 u_proj;
uniform mat3 u_normalMat; // view-space normal matrix (view * model)
out vec3 v_viewNormal;
void main() {
  v_viewNormal = u_normalMat * a_normal;
  gl_Position = u_proj * u_view * u_model * vec4(a_position, 1.0);
}`;

const PRE_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec3 v_viewNormal;
out vec4 outNormal;
void main() {
  // Stored RAW (signed). Do NOT flip against the screen axis here: a surface
  // can be half the FOV off the screen axis yet still face the camera, so a
  // screen-z flip inverts near-edge-on faces WHOLESALE — their AO then reads
  // the entire hemisphere as occluded (angle-dependent black faces; at grazing
  // pitch the FLOOR itself goes near-edge-on and its shadows vanish). Every
  // consumer flips per-pixel against its own view vector instead.
  outNormal = vec4(normalize(v_viewNormal) * 0.5 + 0.5, 1.0);
}`;

const FS_VERT = /* glsl */ `#version 300 es
void main() {
  vec2 pos = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}`;

// GTAO-lite horizon integrator. Continuous visibility per pixel, IGN jitter,
// output-dithered to hide the 8-bit write on wide soft gradients.
const GTAO_FRAG = /* glsl */ `#version 300 es
precision highp float;
// highp samplers are ESSENTIAL: sampler2D defaults to lowp in ES fragment
// shaders and AMD drivers honor it — depth read through fp16 reconstructs
// points centimetres off a flat surface (row-banded streaks on real GPUs;
// SwiftShader samples fp32 regardless, so the e2e rig can't catch it).
uniform highp sampler2D u_depth;     // depth prepass (0..1 window depth)
uniform highp sampler2D u_normal;    // view-space normals (normal*0.5+0.5)
uniform mat4 u_proj;
uniform mat4 u_invProj;
uniform vec2 u_texel;          // 1 / canvas size
uniform vec2 u_size;           // canvas size in pixels
uniform float u_radius;        // world/view units
uniform float u_strength;      // darkening multiplier (0 = off, 1 = default)
uniform float u_dither;        // 1.0 for R8 (apply dither), 0.0 for R16F
uniform int u_slices;          // horizon directions per pixel
uniform int u_steps;           // march steps per side
out vec4 outColor;

const float PI = 3.14159265359;
const float HALF_PI = 1.57079632679;

// View-space position of the fragment at uv with window depth d.
vec3 viewPos(vec2 uv, float d) {
  vec4 ndc = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec4 p = u_invProj * ndc;
  return p.xyz / p.w;
}

// Interleaved Gradient Noise — per-pixel, deterministic, low-discrepancy.
float ign(vec2 p) {
  return fract(52.9829189 * fract(0.06711056 * p.x + 0.00583715 * p.y));
}

// Tiny elevation floor: a tap must be at least fractionally in front of the
// tangent plane (above it toward the viewer) to occlude at all.
const float AO_BIAS = 0.02;

// Ray-relative coplanarity band. A tap is treated as lying ON the center's
// tangent plane — and thus NOT an occluder — when the plane sits within this
// fraction along the tap's own view ray (see horizonTap). This is the cure for
// FLAT-SURFACE false self-occlusion: with exact depth a flat floor is coplanar
// everywhere (k == 1) and produces zero AO, but NEAREST/quantized depth jitters
// each tap ALONG its ray; a view-space elevation test amplifies that jitter into
// heavy occlusion stripes at grazing angles, whereas the ray-relative ratio k
// stays ~1 for a coplanar tap at ANY view angle. Real occluders (a cube wall, a
// torus rim) sit well off the plane (k far from 1) and still register.
// Band width note: 0.04 was tuned when the depth prepass was read through a
// driver fp16 path (pre-highp fix) and needed to swallow centimetre-scale
// reconstruction noise. With true fp32 depth the noise is tiny, and a wide
// band eats REAL mutual occlusion near creases — the floor strip closest to a
// wall is what shades the wall's base; rejecting it left walls bright to the
// contact line ("the cube glows underneath").
const float AO_COPLANAR = 0.015;

// Gate + score one candidate occluder position (already reconstructed).
// Returns its horizon cosine, or -1.0 if it is self, coplanar with the center
// surface, below the tangent plane, or beyond the radius. A smooth distance
// falloff toward the radius edge replaces the old hard cutoff so near-radius
// quantized taps cannot snap a false horizon and no contact ring forms.
float scoreTap(vec3 sP, vec3 P, vec3 N, vec3 V, float invRadius) {
  vec3 dv = sP - P;
  float d2 = dot(dv, dv);
  if (d2 < 1e-8) return -1.0;                 // reads our own texel

  // Where does the center tangent plane sit along THIS tap's view ray? Both P's
  // plane and the ray pass through the origin's frame, so k = dot(P,N)/dot(sP,N)
  // equals 1 exactly when sP is on the plane. Depth quantization slides sP along
  // its ray, so a genuinely coplanar tap keeps k within a narrow band of 1
  // regardless of grazing — the well-conditioned coplanarity test.
  float denom = dot(sP, N);
  if (abs(denom) > 1e-4) {
    float k = dot(P, N) / denom;
    if (abs(k - 1.0) < AO_COPLANAR) return -1.0;   // on the plane → not an occluder
  }

  float invd = inversesqrt(d2);
  float above = dot(dv, N) * invd;            // sin(elevation above tangent plane)
  if (above <= AO_BIAS) return -1.0;          // below / level with the plane
  float r = sqrt(d2) * invRadius;
  if (r >= 1.0) return -1.0;                  // beyond the AO radius
  // Radius-edge softening must NOT touch the cosine domain: the old
  // mix(-1, cos, falloff) pushed near-perpendicular horizons (cos ~ 0 — a
  // wall towering over a pixel AT the contact crease) toward -1, deleting
  // exactly the strongest occlusion. The crease rendered BRIGHTER than the
  // floor half a radius out: a detached shadow with a glow line under every
  // object. Soften in ANGLE space instead: pull the horizon angle toward
  // open (PI) by the falloff amount.
  float t = acos(clamp(dot(dv, V) * invd, -1.0, 1.0));
  float soft = smoothstep(0.5, 1.0, r);
  return cos(mix(t, PI, soft));
}

// One marched tap: score the visible surface at the tap pixel. Deliberately
// NO slab/thickness reconstruction of hidden geometry: every guessed-matter
// variant tried (fixed slab, incidence-scaled, elevation-gated) manufactured
// phantom occluders across empty depth gaps — ball shadows at silhouettes,
// grey wash over grazing floors, whole camera-facing faces going black at
// axis-aligned yaws (see research/ao-orbit-sweep.png history, 2026-07-08).
// The cost: occluders whose camera-facing surfaces sit beyond the radius
// (a cube's far wall at extreme grazing) fade — the classic screen-space AO
// information limit, shared by EEVEE-class viewports.
float horizonTap(vec2 suv, vec3 P, vec3 N, vec3 V, float invRadius) {
  // Off-screen: unknown, NOT occluding. Sampling the edge-clamped depth there
  // conjured occlusion that swam as geometry crossed the frame edge — one of
  // the "shadow changes when I orbit" sources.
  if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) return -1.0;
  float sd = texture(u_depth, suv).r;
  if (sd >= 1.0) return -1.0;                 // background
  return scoreTap(viewPos(suv, sd), P, N, V, invRadius);
}

void main() {
  vec2 uv = gl_FragCoord.xy * u_texel;
  float d = texture(u_depth, uv).r;
  if (d >= 1.0) { outColor = vec4(1.0); return; } // background: unoccluded

  vec3 P = viewPos(uv, d);
  vec3 N = normalize(texture(u_normal, uv).xyz * 2.0 - 1.0);
  vec3 V = normalize(-P);           // view vector (toward camera)
  if (dot(N, V) < 0.0) N = -N;      // face the camera per-pixel (see prepass)
  float viewDepth = -P.z;

  // Project the world-space radius to a screen march length in pixels at this
  // depth (u_proj[0][0] = 1/(aspect*tan(fov/2))). Clamp so big radii stay cheap
  // and small ones still cover a few pixels.
  float pxRadius = clamp(u_radius * u_proj[0][0] * 0.5 * u_size.x / max(viewDepth, 1e-3),
                         4.0, 180.0);

  float noiseDir = ign(gl_FragCoord.xy);                  // slice rotation [0,1)
  float noiseOff = fract(noiseDir * 1.6180339887 + 0.5);  // decorrelated step jitter

  float invRadius = 1.0 / max(u_radius, 1e-4);

  float visibility = 0.0;
  float weightSum = 0.0;

  for (int s = 0; s < u_slices; s++) {
    float phi = (float(s) + noiseDir) * PI / float(u_slices);
    vec2 omega = vec2(cos(phi), sin(phi));   // unit screen/pixel direction

    // View-space slice direction: unproject a neighbour along omega at the SAME
    // depth (cheap, no extra depth fetch), giving the in-plane marching axis.
    vec3 sliceVS = viewPos(uv + omega * u_texel, d) - P;
    if (dot(sliceVS, sliceVS) < 1e-12) continue;
    sliceVS = normalize(sliceVS);

    // Orthonormal 2D frame in the slice plane: axisV = V, axisT ⟂ V toward +omega.
    vec3 axisT = sliceVS - V * dot(sliceVS, V);
    float axisTLen = length(axisT);
    if (axisTLen < 1e-5) continue;
    axisT /= axisTLen;

    // Normal projected into the slice plane, and its signed angle gamma from V.
    vec3 sliceN = normalize(cross(axisT, V));   // plane normal
    vec3 projN = N - sliceN * dot(N, sliceN);
    float projLen = length(projN);
    if (projLen < 1e-4) continue;
    projN /= projLen;
    float gamma = atan(dot(projN, axisT), dot(projN, V));

    // Horizon cosines per side. Init -1 → no occluder → full visible arc.
    float cH0 = -1.0;   // +omega side
    float cH1 = -1.0;   // -omega side
    for (int k = 0; k < u_steps; k++) {
      float t = (float(k) + noiseOff) / float(u_steps); // (0,1]
      vec2 offs = omega * (t * pxRadius) * u_texel;
      // Each side: a tap raises the horizon only if it clears the tangent-plane
      // bias and lies within the radius (distance falloff, no hard ring). The
      // bias rejects coplanar/quantized taps → a flat floor stays unoccluded;
      // the angular arc term still does the contact-shadow softening.
      cH0 = max(cH0, horizonTap(uv + offs, P, N, V, invRadius));
      cH1 = max(cH1, horizonTap(uv - offs, P, N, V, invRadius));
    }

    // Signed horizon angles, clamped to the hemisphere around the normal, then
    // the Jimenez cosine-weighted arc integral.
    float t1 =  acos(clamp(cH0, -1.0, 1.0)); // +side (positive)
    float t2 = -acos(clamp(cH1, -1.0, 1.0)); // -side (negative)
    float h1 = gamma + min(t1 - gamma,  HALF_PI);
    float h2 = gamma + max(t2 - gamma, -HALF_PI);
    float arc = 0.25 * (-cos(2.0 * h1 - gamma) + cos(gamma) + 2.0 * h1 * sin(gamma))
              + 0.25 * (-cos(2.0 * h2 - gamma) + cos(gamma) + 2.0 * h2 * sin(gamma));
    // Normalize by THIS slice's unoccluded arc. The closed form integrates to
    // cos(g) + g*sin(g) for an open slice — 1.0 only at g = 0. At grazing view
    // |g| -> pi/2 and the open arc grows to pi/2, so averaging raw arcs and
    // clamping to 1 buries real occlusion under ~57% of fake headroom: contact
    // shadows faded with view angle and vanished at grazing (the "boomerang" —
    // strong on camera-side edges, nothing at the far corner). Per-slice
    // normalization makes an open slice exactly 1 at EVERY view angle.
    float g = abs(gamma);
    arc /= max(cos(g) + g * sin(g), 1e-3);
    visibility += projLen * arc;
    weightSum += projLen;
  }

  visibility = weightSum > 0.0 ? visibility / weightSum : 1.0;
  visibility = clamp(visibility, 0.0, 1.0);

  // Fade AO out with distance so far geometry stays clean.
  visibility = mix(1.0, visibility, 1.0 - smoothstep(30.0, 60.0, viewDepth));

  // Deepen contacts a touch, then apply the strength slider (0 → off, 1 →
  // default, 2 → strong; clamped so heavy settings can't over-darken to black).
  float ao = pow(visibility, 1.15);
  ao = clamp(1.0 - (1.0 - ao) * u_strength, 0.0, 1.0);

  // ±0.5-LSB IGN dither before the 8-bit write turns residual quantization
  // steps into sub-perceptual noise. No-op for the R16F target (u_dither = 0).
  ao += (ign(gl_FragCoord.xy + 0.5) - 0.5) * (1.0 / 255.0) * u_dither;
  outColor = vec4(vec3(clamp(ao, 0.0, 1.0)), 1.0);
}`;

// Separable plane-aware Gaussian denoise (X pass then Y pass). Edge weight =
// the tap's distance to the CENTER's tangent plane (predicted from depth +
// normal), relative to depth — alive on receding/grazing floors, still
// silhouette/crease-preserving. Run at the half-res AO resolution the two
// 13-tap passes cover a ~24×24 canvas-pixel footprint, which is what melts
// the IGN stipple into the smooth Blender-like gradient.
const BLUR_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform highp sampler2D u_src;
uniform highp sampler2D u_depth;   // highp: see GTAO_FRAG — lowp default = fp16 depth on AMD
uniform highp sampler2D u_normal;
uniform mat4 u_invProj;
uniform vec2 u_dir;      // one-texel step along this pass's axis (x or y)
out vec4 outColor;

uniform vec2 u_texel;    // 1 / AO-resolution size (for gl_FragCoord → uv)

vec3 viewPos(vec2 uv, float d) {
  vec4 p = u_invProj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  return p.xyz / p.w;
}

void main() {
  vec2 uv = gl_FragCoord.xy * u_texel;
  float cd = texture(u_depth, uv).r;
  if (cd >= 1.0) { outColor = vec4(texture(u_src, uv).r); return; }
  vec3 cP = viewPos(uv, cd);
  vec3 cN = normalize(texture(u_normal, uv).xyz * 2.0 - 1.0);
  if (dot(cN, cP) > 0.0) cN = -cN;  // face the camera per-pixel (see prepass)
  // Plane-distance tolerance scales with depth (relative), so a receding floor
  // whose neighbours differ a lot in z still blurs, while a real depth cliff or
  // crease (points off the plane) is rejected.
  float tol = 0.05 * abs(cP.z) + 0.01;

  float sum = texture(u_src, uv).r;
  float wsum = 1.0;
  for (int i = 1; i <= ${BLUR_TAPS}; i++) {
    float g = exp(-float(i * i) * 0.08);       // gaussian falloff, sigma ~2.5
    for (float side = -1.0; side <= 1.0; side += 2.0) {
      vec2 o = u_dir * (float(i) * side);
      vec2 tuv = uv + o;
      if (tuv.x < 0.0 || tuv.x > 1.0 || tuv.y < 0.0 || tuv.y > 1.0) continue;
      float sd = texture(u_depth, tuv).r;
      if (sd >= 1.0) continue;
      vec3 sP = viewPos(uv + o, sd);
      float planeDist = abs(dot(sP - cP, cN));
      // Normal agreement: at a 90-degree crease the OTHER surface's points sit
      // arbitrarily close to this plane (the planes MEET there) — the plane
      // test alone lets the wall's bright AO bleed over the floor's contact
      // shadow, erasing it for a full blur radius past the crease line.
      vec3 sN = normalize(texture(u_normal, tuv).xyz * 2.0 - 1.0);
      float nw = abs(dot(cN, sN));
      float w = g * exp(-planeDist / tol) * nw * nw;
      sum += texture(u_src, uv + o).r * w;
      wsum += w;
    }
  }
  outColor = vec4(vec3(sum / wsum), 1.0);
}`;

// Depth-aware upsample of the half-res denoised AO back to canvas resolution.
// Plain LINEAR upsampling wobbles at silhouettes: the AO term is quantized to
// half-res texels, and at depth edges the 2px staircase reads as a wavy edge.
// Here each full-res pixel manually blends the 4 surrounding half-res texels
// with bilinear × plane-consistency weights (same tangent-plane test as the
// denoise), so edges follow FULL-res geometry. Falls back to plain bilinear
// where no neighbour matches (isolated pixels, extreme grazing).
const UPSAMPLE_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform highp sampler2D u_src;     // half-res denoised AO (LINEAR filterable)
uniform highp sampler2D u_depth;   // FULL-res depth prepass
uniform highp sampler2D u_normal;  // FULL-res view-space normals
uniform mat4 u_invProj;
uniform vec2 u_texel;      // 1 / canvas size
uniform vec2 u_srcSize;    // half-res size in texels
out vec4 outColor;

vec3 viewPos(vec2 uv, float d) {
  vec4 p = u_invProj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  return p.xyz / p.w;
}

void main() {
  vec2 uv = gl_FragCoord.xy * u_texel;
  float cd = texture(u_depth, uv).r;
  if (cd >= 1.0) { outColor = vec4(1.0); return; }   // background: unoccluded
  vec3 cP = viewPos(uv, cd);
  vec3 cN = normalize(texture(u_normal, uv).xyz * 2.0 - 1.0);
  if (dot(cN, cP) > 0.0) cN = -cN;  // face the camera per-pixel (see prepass)
  float tol = 0.05 * abs(cP.z) + 0.01;

  // The 4 half-res texel centers around this pixel + their bilinear weights.
  vec2 st = uv * u_srcSize - 0.5;
  vec2 base = floor(st);
  vec2 f = st - base;
  float sum = 0.0;
  float wsum = 0.0;
  float bestW = -1.0;
  float bestV = 1.0;
  for (int j = 0; j <= 1; j++) {
    for (int i = 0; i <= 1; i++) {
      vec2 suv = (base + vec2(float(i), float(j)) + 0.5) / u_srcSize;
      float bilin = (i == 0 ? 1.0 - f.x : f.x) * (j == 0 ? 1.0 - f.y : f.y);
      // Consistency: compare against the FULL-res surface under that texel.
      float sd = texture(u_depth, suv).r;
      float planeW = 0.0;
      if (sd < 1.0) {
        vec3 sP = viewPos(suv, sd);
        float planeDist = abs(dot(sP - cP, cN));
        // Same normal-agreement term as the denoise: the plane test cannot
        // separate the two surfaces of a crease near their meeting line.
        vec3 sN = normalize(texture(u_normal, suv).xyz * 2.0 - 1.0);
        float nw = abs(dot(cN, sN));
        planeW = exp(-planeDist / tol) * nw * nw;
      }
      float v = texture(u_src, suv).r;
      float w = bilin * planeW;
      sum += v * w;
      wsum += w;
      if (planeW > bestW) { bestW = planeW; bestV = v; }
    }
  }
  // Weak everywhere (3-plane corners, deep creases): take the SINGLE most
  // plane-consistent texel. A plain-bilinear fallback smeared the dark corner
  // value outward into a blob and left a bright "glow" line at contact creases.
  outColor = vec4(vec3(wsum > 1e-3 ? sum / wsum : bestV), 1.0);
}`;

/** Map the shared "Samples" pref (16–96) to Object-AO march taps (3–16). */
export function objectAoTaps(samples: number): number {
  return Math.max(3, Math.min(16, Math.round(samples / 6)));
}

// Per-method calibration gains: raw estimator occlusion × gain, tuned on the
// cube-on-floor reference so the three methods and GTAO agree at the default
// sliders (see the Object AO entry in CLAUDE.md for the probe numbers).
const GAIN_BASE = 1.0;
const GAIN_HEMI = 0.57;
const GAIN_EXP = 1.44;

// Object AO (Ray's AO-Prototype technique, ported from ao-hybrid.html): instead
// of hunting occluders in the depth buffer, march a WORLD-SPACE distance field
// of the scene — per-object voxel SDFs in a 3D atlas (sdfAtlas.ts). The field
// is camera-independent, so the shadows are pinned to the geometry and cannot
// swim, fade, or pop with view angle — the structural weakness of every
// screen-space method. Position + normal still come from the same depth
// prepass; the six estimators are the prototype's aoLive() methods verbatim.
const OBJAO_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform highp sampler2D u_depth;     // depth prepass (0..1 window depth)
uniform highp sampler2D u_normal;    // view-space normals (normal*0.5+0.5)
uniform highp sampler3D u_sdf;       // SDF slot atlas (R8: 0.5 = surface)
uniform mat4 u_invProj;
uniform mat4 u_invView;
uniform vec2 u_texel;                // 1 / AO-target size
uniform int u_count;                 // active SDF objects
uniform mat4 u_w2uvw[${MAX_SDF_OBJECTS}];  // world → slot grid uvw [0,1]
uniform vec4 u_info[${MAX_SDF_OBJECTS}];   // boxSize.xyz (local), min axis scale
uniform vec4 u_slot[${MAX_SDF_OBJECTS}];   // slot origin in atlas voxels, encode range R
uniform int u_method;                // 0..5 — the prototype's estimator menu
uniform int u_taps;                  // march taps (3..16)
uniform float u_radius;              // world units
uniform float u_strength;
uniform float u_bias;                // self-occlusion offset along the normal
uniform float u_dither;              // 1.0 for the R8 target
out vec4 outColor;

const vec3 ATLAS = vec3(${SDF_ATLAS_W}.0, ${SDF_ATLAS_H}.0, ${SDF_ATLAS_D}.0);
#define MAX_TAPS 16
#define GAIN_BASE ${GAIN_BASE.toFixed(3)}
#define GAIN_HEMI ${GAIN_HEMI.toFixed(3)}
#define GAIN_EXP ${GAIN_EXP.toFixed(3)}

vec3 viewPos(vec2 uv, float d) {
  vec4 ndc = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec4 p = u_invProj * ndc;
  return p.xyz / p.w;
}

// Scene distance field: min over the per-object SDFs. Points outside a slot's
// box use clamp-to-box + euclidean remainder (conservative lower bound). The
// (outside - R) early-out skips the 3D fetch for objects that cannot beat the
// current best — most of the loop for most pixels.
float map(vec3 p) {
  float best = 1e9;
  for (int i = 0; i < ${MAX_SDF_OBJECTS}; i++) {
    if (i >= u_count) break;
    vec3 u = (u_w2uvw[i] * vec4(p, 1.0)).xyz;
    vec3 q = clamp(u, 0.0, 1.0);
    vec3 dl = (u - q) * u_info[i].xyz;
    float outside = length(dl);
    float scale = u_info[i].w;
    float R = u_slot[i].w;
    if ((outside - R) * scale >= best) continue;
    vec3 tc = (u_slot[i].xyz + q * ${SDF_RES - 1}.0 + 0.5) / ATLAS;
    float ds = (textureLod(u_sdf, tc, 0.0).r - 0.5) * 2.0 * R;
    // Debias by half this object's voxel size: trilinear interpolation of a
    // quantized field UNDERESTIMATES distance near curved / sub-voxel detail,
    // which reads as phantom occlusion (blotchy floors, blackened scatter
    // islands). Half a cell is the error bound; real contacts lose only a
    // sliver of reach.
    float cell = max(u_info[i].x, max(u_info[i].y, u_info[i].z)) * ${(0.5 / (SDF_RES - 1)).toFixed(6)};
    best = min(best, (ds + outside + cell) * scale);
  }
  return best;
}

float ign(vec2 p) {
  return fract(52.9829189 * fract(0.06711056 * p.x + 0.00583715 * p.y));
}
void basis(vec3 n, out vec3 t, out vec3 b) {
  vec3 up = abs(n.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  t = normalize(cross(up, n));
  b = cross(n, t);
}

// ---- the prototype's estimators (aoLive), trimmed to the keepers ----
// (Dithered / Cone cut on looks, Supersample x4 on perf, 2026-07-09.)
// Each method's raw occlusion is scaled by a calibration GAIN so that at the
// same Radius/Strength sliders all three read the same as each other AND as
// the Screen (GTAO) mode on the reference cube-on-floor scene.
float aoBase(vec3 p, vec3 n) {                 // 0 — linear march along the normal
  float occ = 0.0, sca = 1.0;
  for (int i = 0; i < MAX_TAPS; i++) { if (i >= u_taps) break;
    float h = u_bias + u_radius * float(i) / float(u_taps - 1);
    occ += (h - map(p + n * h)) * sca; sca *= 0.6;
  }
  return clamp(1.0 - u_strength * GAIN_BASE * occ, 0.0, 1.0);
}
float aoHemi(vec3 p, vec3 n) {                 // 1 — golden-angle hemisphere spread
  vec3 t, b; basis(n, t, b);
  float a0 = ign(gl_FragCoord.xy) * 6.2831853, occ = 0.0, N = float(u_taps);
  for (int i = 0; i < MAX_TAPS; i++) { if (i >= u_taps) break;
    float fi = (float(i) + 0.5) / N, rr = sqrt(fi), phi = a0 + float(i) * 2.3999632;
    vec3 dir = normalize(n + (t * cos(phi) + b * sin(phi)) * rr * 1.3);
    float h = u_radius;
    occ += clamp((h - map(p + dir * h)) / h, 0.0, 1.0);
  }
  return clamp(1.0 - u_strength * GAIN_HEMI * occ / N, 0.0, 1.0);
}
float aoExp(vec3 p, vec3 n) {                  // 2 — taps dense near surface, smooth weights
  float occ = 0.0, w = 0.0;
  for (int i = 0; i < MAX_TAPS; i++) { if (i >= u_taps) break;
    float fi = float(i) / float(u_taps - 1);
    float h = u_bias + u_radius * fi * fi;
    float wi = exp(-2.5 * fi);
    occ += clamp((h - map(p + n * h)) / max(h, 1e-3), 0.0, 1.0) * wi; w += wi;
  }
  return clamp(1.0 - u_strength * GAIN_EXP * occ / max(w, 1e-3), 0.0, 1.0);
}

float aoLive(vec3 p, vec3 n) {
  if (u_method == 0)      return aoBase(p, n);
  else if (u_method == 1) return aoHemi(p, n);
  return aoExp(p, n);
}

void main() {
  vec2 uv = gl_FragCoord.xy * u_texel;
  float d = texture(u_depth, uv).r;
  if (d >= 1.0 || u_count == 0) { outColor = vec4(1.0); return; }

  vec3 P = viewPos(uv, d);
  vec3 N = normalize(texture(u_normal, uv).xyz * 2.0 - 1.0);
  vec3 V = normalize(-P);
  if (dot(N, V) < 0.0) N = -N;      // face the camera per-pixel (see prepass)

  // To world space: the field lives there, so the result is view-independent.
  vec3 W = (u_invView * vec4(P, 1.0)).xyz;
  vec3 Wn = normalize(mat3(u_invView) * N);

  float ao = aoLive(W, Wn);
  ao += (ign(gl_FragCoord.xy + 0.5) - 0.5) * (1.0 / 255.0) * u_dither;
  outColor = vec4(vec3(clamp(ao, 0.0, 1.0)), 1.0);
}`;

// Cavity (Blender viewport "Cavity", screen-space curvature). Reads the SAME
// depth+normal prepass as AO, at FULL canvas resolution (fine convex edges are
// the whole point — no half-res chain). Curvature = the 4-neighbourhood
// divergence of the view-space normals: for each neighbour, dot(nᵢ−n₀, dirᵢ)
// with dirᵢ the view-space direction toward that neighbour. Positive sum →
// convex RIDGE (brighten), negative → concave VALLEY (darken). Neighbours across
// a depth cliff or off the background are skipped so silhouettes don't fake huge
// curvature. Output = aoFactor · (1 − valley·k_v) · (1 + ridge·k_r): folds into
// the SAME single-channel factor the shaded passes already multiply, so cavity
// and AO compose for free (aoFactor = 1 when AO is off). r16f target holds the
// >1 ridge brightening (both SwiftShader and radeonsi are float-renderable).
const CAVITY_GAIN = 0.5;   // curvature → shading scale (eyes-on calibrated)
const CAVITY_FRAG = /* glsl */ `#version 300 es
precision highp float;
// highp samplers: same lowp-default lesson as GTAO — fp16 depth on AMD would
// jitter the reconstructed neighbour positions and speckle the curvature.
uniform highp sampler2D u_depth;   // full-res depth prepass (0..1 window depth)
uniform highp sampler2D u_normal;  // full-res view-space normals (n*0.5+0.5)
uniform highp sampler2D u_ao;      // AO factor to compose with (ignored if u_hasAo=0)
uniform mat4 u_invProj;
uniform vec2 u_texel;              // 1 / canvas size
uniform float u_ridge;            // convex brightening amount (pref)
uniform float u_valley;           // concave darkening amount (pref)
uniform float u_hasAo;            // 1 → multiply by u_ao, 0 → AO off
out vec4 outColor;

const float GAIN = ${CAVITY_GAIN.toFixed(3)};

vec3 viewPos(vec2 uv, float d) {
  vec4 p = u_invProj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  return p.xyz / p.w;
}

void main() {
  vec2 uv = gl_FragCoord.xy * u_texel;
  float d = texture(u_depth, uv).r;
  float aoF = u_hasAo > 0.5 ? texture(u_ao, uv).r : 1.0;
  if (d >= 1.0) { outColor = vec4(vec3(aoF), 1.0); return; } // background: no cavity

  vec3 P = viewPos(uv, d);
  vec3 N = normalize(texture(u_normal, uv).xyz * 2.0 - 1.0);
  if (dot(N, -P) < 0.0) N = -N;   // face the camera per-pixel (see prepass)

  vec2 offs[4];
  offs[0] = vec2( u_texel.x, 0.0);
  offs[1] = vec2(-u_texel.x, 0.0);
  offs[2] = vec2(0.0,  u_texel.y);
  offs[3] = vec2(0.0, -u_texel.y);
  float depthTol = 0.03 * abs(P.z) + 0.02;   // relative depth-cliff reject
  float curv = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 nuv = uv + offs[i];
    if (nuv.x < 0.0 || nuv.x > 1.0 || nuv.y < 0.0 || nuv.y > 1.0) continue;
    float sd = texture(u_depth, nuv).r;
    if (sd >= 1.0) continue;                  // background neighbour
    vec3 sP = viewPos(nuv, sd);
    if (abs(sP.z - P.z) > depthTol) continue; // depth cliff → silhouette, skip
    vec3 dir = sP - P;
    float dl = length(dir);
    if (dl < 1e-7) continue;
    dir /= dl;
    vec3 sN = normalize(texture(u_normal, nuv).xyz * 2.0 - 1.0);
    if (dot(sN, -sP) < 0.0) sN = -sN;         // same camera-facing convention
    curv += dot(sN - N, dir);                 // divergence contribution
  }

  float c = curv * GAIN;
  float ridge = max(c, 0.0);
  float valley = max(-c, 0.0);
  // valley term clamped so heavy sliders can't drive the factor negative;
  // overall factor clamped so a sharp ridge can't blow the color out to inf.
  float factor = (1.0 - clamp(valley * u_valley, 0.0, 1.0)) * (1.0 + ridge * u_ridge);
  factor = clamp(factor, 0.0, 4.0);
  outColor = vec4(vec3(aoF * factor), 1.0);
}`;

export class AoPass {
  private readonly preShader: Shader;
  private readonly gtaoShader: Shader;
  private readonly blurShader: Shader;
  private readonly upsampleShader: Shader;
  /** Object AO (SDF-march) program — compiled on first use of the mode. */
  private objAoShader: Shader | null = null;
  /** Cavity (screen-space curvature) program — compiled on first use. */
  private cavityShader: Shader | null = null;
  private readonly fullscreen: EmptyVao;
  private readonly ssaoFbo: Framebuffer;
  private readonly blurFbo: Framebuffer;
  private readonly finalFbo: Framebuffer;
  private readonly fullFbo: Framebuffer;
  /** Full-res target for the composed AO·cavity factor (cavity output). */
  private readonly cavityFbo: Framebuffer;
  private preFbo: WebGLFramebuffer;
  private depthTex: WebGLTexture;
  private normalTex: WebGLTexture;
  private width = 0;
  private height = 0;
  /** 'r16f' when EXT_color_buffer_float is present, else 'r8' (+ dither). */
  private aoFormat: FboFormat;
  /** 1×1 white — bound by the shaded passes when AO is off. */
  readonly white: WebGLTexture;

  constructor(private readonly gl: WebGL2RenderingContext, width: number, height: number) {
    this.preShader = new Shader(gl, PRE_VERT, PRE_FRAG, 'ao-prepass');
    this.gtaoShader = new Shader(gl, FS_VERT, GTAO_FRAG, 'ao-gtao');
    this.blurShader = new Shader(gl, FS_VERT, BLUR_FRAG, 'ao-blur');
    this.upsampleShader = new Shader(gl, FS_VERT, UPSAMPLE_FRAG, 'ao-upsample');
    this.fullscreen = new EmptyVao(gl);

    // Single-channel AO targets: R16F removes 8-bit quantization outright where
    // the float-render extension exists; R8 + dither is the core fallback.
    // The whole AO chain runs at HALF the canvas resolution (like EEVEE's 1:2
    // raytracing) — 4× cheaper per tap, and the LINEAR upsample of the final
    // target is itself a smoothing stage. ssao = raw GTAO, blur = X-pass,
    // final = Y-pass (the texture the shaded passes multiply by).
    this.aoFormat = floatColorRenderable(gl) ? 'r16f' : 'r8';
    const aoW = Math.max(1, Math.round(width / 2));
    const aoH = Math.max(1, Math.round(height / 2));
    this.ssaoFbo = new Framebuffer(gl, aoW, aoH, false, this.aoFormat);
    this.blurFbo = new Framebuffer(gl, aoW, aoH, false, this.aoFormat);
    this.finalFbo = new Framebuffer(gl, aoW, aoH, false, this.aoFormat, true);
    this.fullFbo = new Framebuffer(gl, width, height, false, this.aoFormat);
    // Cavity runs at FULL resolution (fine convex edges are the point); its
    // r16f target holds the >1 ridge brightening the shaded passes multiply in.
    this.cavityFbo = new Framebuffer(gl, width, height, false, this.aoFormat);

    this.white = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.white);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([255, 255, 255, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    // Depth + normal targets built by allocate (resize recreates them).
    this.depthTex = gl.createTexture()!;
    this.normalTex = gl.createTexture()!;
    this.preFbo = gl.createFramebuffer()!;
    this.allocateTargets(width, height);
  }

  /** True LSB dither is only meaningful for the 8-bit target. */
  private get ditherFlag(): number {
    return this.aoFormat === 'r8' ? 1 : 0;
  }

  /** Test hook: force the AO target format so e2e can exercise the R8 + dither
   *  path deterministically regardless of the headless GL's extension support. */
  overrideFormatForTest(format: FboFormat): void {
    this.aoFormat = format;
    this.ssaoFbo.setFormat(format);
    this.blurFbo.setFormat(format);
    this.finalFbo.setFormat(format);
    this.fullFbo.setFormat(format);
    this.cavityFbo.setFormat(format);
  }

  private allocateTargets(width: number, height: number): void {
    const gl = this.gl;
    this.width = width;
    this.height = height;

    gl.bindTexture(gl.TEXTURE_2D, this.depthTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, width, height, 0,
      gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.bindTexture(gl.TEXTURE_2D, this.normalTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.preFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.depthTex, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.normalTex, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.allocateTargets(width, height);
    const aoW = Math.max(1, Math.round(width / 2));
    const aoH = Math.max(1, Math.round(height / 2));
    this.ssaoFbo.resize(aoW, aoH);
    this.blurFbo.resize(aoW, aoH);
    this.finalFbo.resize(aoW, aoH);
    this.fullFbo.resize(width, height);
    this.cavityFbo.resize(width, height);
  }

  /** Stage 1: bind the prepass FBO; the Renderer then draws every mesh through
   *  setObject() and calls compute() to run stages 2+3. */
  beginDepth(view: Mat4, proj: Mat4): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.preFbo);
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(0.5, 0.5, 1.0, 1.0); // decodes to +Z; irrelevant (background rejected by depth)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    this.preShader.use();
    this.preShader.setMat4('u_view', view);
    this.preShader.setMat4('u_proj', proj);
  }

  setObject(model: Mat4, view: Mat4): void {
    this.preShader.setMat4('u_model', model);
    this.preShader.setMat3('u_normalMat', view.mul(model).normalMatrix());
  }

  /** Stages 2+3: GTAO from the depth+normal prepass, then the bilateral denoise.
   *  Leaves the default framebuffer bound at (canvasW, canvasH). */
  compute(proj: Mat4, invProj: Mat4, radius = 0.55, strength = 1, samples = 48): void {
    const gl = this.gl;
    const depthWasOn = gl.isEnabled(gl.DEPTH_TEST);
    gl.disable(gl.DEPTH_TEST);

    const aoW = this.ssaoFbo.width;
    const aoH = this.ssaoFbo.height;

    this.ssaoFbo.bind(); // sets the half-res viewport
    this.gtaoShader.use();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.depthTex);
    this.gtaoShader.setInt('u_depth', 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.normalTex);
    this.gtaoShader.setInt('u_normal', 1);
    gl.activeTexture(gl.TEXTURE0);
    this.gtaoShader.setMat4('u_proj', proj);
    this.gtaoShader.setMat4('u_invProj', invProj);
    this.gtaoShader.setVec2('u_texel', 1 / aoW, 1 / aoH);
    this.gtaoShader.setVec2('u_size', aoW, aoH);
    this.gtaoShader.setFloat('u_radius', radius);
    this.gtaoShader.setFloat('u_strength', strength);
    this.gtaoShader.setFloat('u_dither', this.ditherFlag);
    const { slices, steps } = sampleBudget(samples);
    this.gtaoShader.setInt('u_slices', slices);
    this.gtaoShader.setInt('u_steps', steps);
    this.fullscreen.drawTriangles(3);

    this.denoiseAndUpsample(invProj);
    if (depthWasOn) gl.enable(gl.DEPTH_TEST);
  }

  /** Object AO (Ray's SDF-march technique): same prepass, same denoise +
   *  upsample chain as GTAO — only stage 2's estimator differs. */
  computeObject(
    invProj: Mat4, invView: Mat4, sdf: SdfSceneData,
    radius: number, strength: number, samples: number, method: number,
  ): void {
    const gl = this.gl;
    const depthWasOn = gl.isEnabled(gl.DEPTH_TEST);
    gl.disable(gl.DEPTH_TEST);

    if (!this.objAoShader) this.objAoShader = new Shader(gl, FS_VERT, OBJAO_FRAG, 'ao-object');
    const sh = this.objAoShader;
    const aoW = this.ssaoFbo.width;
    const aoH = this.ssaoFbo.height;

    this.ssaoFbo.bind();
    sh.use();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.depthTex);
    sh.setInt('u_depth', 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.normalTex);
    sh.setInt('u_normal', 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_3D, sdf.texture);
    sh.setInt('u_sdf', 2);
    gl.activeTexture(gl.TEXTURE0);
    sh.setMat4('u_invProj', invProj);
    sh.setMat4('u_invView', invView);
    sh.setVec2('u_texel', 1 / aoW, 1 / aoH);
    sh.setInt('u_count', sdf.count);
    if (sdf.count > 0) {
      sh.setMat4Array('u_w2uvw', sdf.worldToUvw);
      sh.setVec4Array('u_info', sdf.info);
      sh.setVec4Array('u_slot', sdf.slot);
    }
    sh.setInt('u_method', method);
    sh.setInt('u_taps', objectAoTaps(samples));
    sh.setFloat('u_radius', radius);
    sh.setFloat('u_strength', strength);
    sh.setFloat('u_bias', 0.05);
    sh.setFloat('u_dither', this.ditherFlag);
    this.fullscreen.drawTriangles(3);

    this.denoiseAndUpsample(invProj);
    if (depthWasOn) gl.enable(gl.DEPTH_TEST);
  }

  /** Stage 3 shared by both estimators: separable plane-aware denoise then the
   *  depth-aware upsample to canvas resolution. Leaves the default framebuffer
   *  bound at (canvasW, canvasH). */
  private denoiseAndUpsample(invProj: Mat4): void {
    const gl = this.gl;
    const aoW = this.ssaoFbo.width;
    const aoH = this.ssaoFbo.height;

    // Separable plane-aware denoise: X pass into blurFbo, Y pass into finalFbo.
    const blurPass = (src: Framebuffer, dst: Framebuffer, dx: number, dy: number) => {
      dst.bind();
      this.blurShader.use();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.texture);
      this.blurShader.setInt('u_src', 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.depthTex);
      this.blurShader.setInt('u_depth', 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.normalTex);
      this.blurShader.setInt('u_normal', 2);
      gl.activeTexture(gl.TEXTURE0);
      this.blurShader.setMat4('u_invProj', invProj);
      this.blurShader.setVec2('u_texel', 1 / aoW, 1 / aoH);
      this.blurShader.setVec2('u_dir', dx / aoW, dy / aoH);
      this.fullscreen.drawTriangles(3);
    };
    blurPass(this.ssaoFbo, this.blurFbo, 1, 0);
    blurPass(this.blurFbo, this.finalFbo, 0, 1);

    // Depth-aware upsample to canvas resolution — kills the wavy half-res
    // staircase at silhouettes that plain LINEAR sampling shows.
    this.fullFbo.bind();
    this.upsampleShader.use();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.finalFbo.texture);
    this.upsampleShader.setInt('u_src', 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.depthTex);
    this.upsampleShader.setInt('u_depth', 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.normalTex);
    this.upsampleShader.setInt('u_normal', 2);
    gl.activeTexture(gl.TEXTURE0);
    this.upsampleShader.setMat4('u_invProj', invProj);
    this.upsampleShader.setVec2('u_texel', 1 / this.width, 1 / this.height);
    this.upsampleShader.setVec2('u_srcSize', aoW, aoH);
    this.fullscreen.drawTriangles(3);

    this.fullFbo.unbind();
    gl.viewport(0, 0, this.width, this.height);
  }

  /**
   * Cavity (Blender viewport curvature): a single FULL-res pass over the depth+
   * normal prepass. Composes with AO — pass the AO factor texture as `aoTex`
   * (its texel-for-texel product is written) or `null` when AO is off (factor
   * starts at 1). Leaves the default framebuffer bound at (canvasW, canvasH).
   * Result is {@link cavityTexture}. `radius` is unused here (cavity is a fixed
   * 5-tap neighbourhood) — the look is driven by ridge/valley only.
   */
  computeCavity(
    invProj: Mat4, aoTex: WebGLTexture | null, ridge: number, valley: number,
  ): void {
    const gl = this.gl;
    const depthWasOn = gl.isEnabled(gl.DEPTH_TEST);
    gl.disable(gl.DEPTH_TEST);

    if (!this.cavityShader) this.cavityShader = new Shader(gl, FS_VERT, CAVITY_FRAG, 'ao-cavity');
    const sh = this.cavityShader;
    this.cavityFbo.bind(); // full-res viewport
    sh.use();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.depthTex);
    sh.setInt('u_depth', 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.normalTex);
    sh.setInt('u_normal', 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, aoTex ?? this.white);
    sh.setInt('u_ao', 2);
    gl.activeTexture(gl.TEXTURE0);
    sh.setMat4('u_invProj', invProj);
    sh.setVec2('u_texel', 1 / this.width, 1 / this.height);
    sh.setFloat('u_ridge', ridge);
    sh.setFloat('u_valley', valley);
    sh.setFloat('u_hasAo', aoTex ? 1 : 0);
    this.fullscreen.drawTriangles(3);

    this.cavityFbo.unbind();
    gl.viewport(0, 0, this.width, this.height);
    if (depthWasOn) gl.enable(gl.DEPTH_TEST);
  }

  /** The denoised, canvas-resolution AO texture (valid after compute()). */
  get texture(): WebGLTexture {
    return this.fullFbo.texture;
  }

  /** The full-res composed AO·cavity factor (valid after computeCavity()). */
  get cavityTexture(): WebGLTexture {
    return this.cavityFbo.texture;
  }
}
