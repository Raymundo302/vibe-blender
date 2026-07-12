/**
 * UR12-2 — GLSL kernel v1 for the WebGL2 fragment-shader path tracer.
 *
 * THE CPU TRACER (src/renderEngine/tracer.ts) IS THE SPEC. This kernel mirrors
 * `traceRay` bounce-for-bounce: BVH closest-hit, emission (mesh-light gated),
 * direct lighting / NEE with shadow rays over all 4 light types + soft shadows,
 * emissive-mesh-light NEE (area-weighted CDF), a cosine-diffuse / GGX-ish metal /
 * dielectric-glass / SSS bounce chain, Russian roulette after depth 2, and the
 * flat/gradient world/sky on a miss. Thin-lens DoF matches renderSample.
 *
 * MAX_DEPTH 4 and EPS 1e-4 match the CPU. Because both engines are unbiased MC
 * estimators of the same integral, at high spp their IMAGES CONVERGE even though
 * the per-sample RNG streams differ (documented below).
 *
 * ── RNG DIVERGENCE (documented) ──────────────────────────────────────────────
 * The CPU seeds a mulberry32 per pixel from (pixel, sampleIndex, seed) and draws
 * numbers in a fixed order. This kernel uses a PCG stepper seeded from the SAME
 * triple — same seed PHILOSOPHY, different generator and draw order — so images
 * are NOT bit-identical to the CPU tracer. They converge to the same expectation
 * (the e2e parity harness checks downsampled-luminance mean-abs-diff, not bytes).
 *
 * ── FEATURES CUT ON THE GPU (documented; the stage-4 parity harness holds us to
 *    this list) ────────────────────────────────────────────────────────────────
 *   • IMAGE textures + NORMAL/BUMP/ROUGH/METAL maps + ALPHA-cutout: need a
 *     TEXTURE_2D_ARRAY atlas upload not built in v1. texKind 'checker' (procedural)
 *     IS supported through packed UVs; 'image' falls back to white (no tint).
 *   • NODE-graph materials: evaluated by a whole TS interpreter (evaluate.ts) that
 *     cannot run in GLSL — a node material falls back to its flat baseColor/rough/
 *     metal, no procedural pattern. (buildEmitters already excludes node emitters,
 *     so mesh-light NEE agrees.)
 *   • HDRI world: equirect texture upload not built in v1 — mode 2 falls back to
 *     the gradient (exactly what the CPU does when hdri pixels are absent).
 *   • SSS is ported (wrapped-diffuse direct + dipole-ish dip continuation).
 *
 * highp EVERYWHERE (repo AO-saga lesson: lowp/mediump samplers on real drivers
 * silently corrupt depth/position math; see CLAUDE.md 2026-07-08).
 */

import {
  TRI_TEXELS, MAT_TEXELS, LIGHT_TEXELS, NODE_TEXELS, TRIIDX_PER_TEXEL,
  UV_TEXELS, EMIT_TEXELS,
} from './pack';

/** Fixed traversal stack depth (task spec: max depth 64). */
export const MAX_STACK = 64;
/** Path bounce depth — matches CPU MAX_DEPTH. */
export const MAX_DEPTH = 4;

/** Fullscreen-quad vertex shader. */
export const VERTEX_SRC = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

/** Build the trace+accumulate fragment shader. Layout constants are interpolated
 *  from pack.ts so the two files can never drift. */
export function fragmentSource(): string {
  return `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

// Scene textures + their row widths (see pack.ts layouts).
uniform highp sampler2D uTris;    uniform int uTrisW;
uniform highp sampler2D uNodes;   uniform int uNodesW;   uniform int uNodeCount;
uniform highp sampler2D uTriIdx;  uniform int uTriIdxW;
uniform highp sampler2D uMats;    uniform int uMatsW;
uniform highp sampler2D uUVs;     uniform int uUVsW;
uniform highp sampler2D uLights;  uniform int uLightsW;  uniform int uNumLights;
uniform highp sampler2D uEmit;    uniform int uEmitW;
uniform int   uNumEmitters;       uniform float uEmitTotalArea;

// Camera (thin-lens; aperture 0 = pinhole).
uniform vec3  uEye;
uniform vec3  uForward;
uniform vec3  uRight;
uniform vec3  uUp;
uniform float uFovY;
uniform float uAperture;
uniform float uFocus;

// World/sky (flat/gradient; hdri falls back to gradient — documented).
uniform int   uWorldMode;
uniform vec3  uWorldColor;
uniform vec3  uWorldHorizon;
uniform vec3  uWorldZenith;
uniform float uWorldStrength;

uniform vec2  uResolution;
uniform int   uSampleIndex;
uniform uint  uFrameSeed;
uniform float uJitter;            // 1.0 = sub-pixel jitter on, 0.0 = center rays
uniform highp sampler2D uPrevAccum;

out vec4 fragColor;

const int   TRI_TEXELS   = ${TRI_TEXELS};
const int   MAT_TEXELS   = ${MAT_TEXELS};
const int   UV_TEXELS    = ${UV_TEXELS};
const int   LIGHT_TEXELS = ${LIGHT_TEXELS};
const int   EMIT_TEXELS  = ${EMIT_TEXELS};
const int   NODE_TEXELS  = ${NODE_TEXELS};
const int   IDX_PER_TEXEL= ${TRIIDX_PER_TEXEL};
const int   MAX_STACK    = ${MAX_STACK};
const int   MAX_DEPTH    = ${MAX_DEPTH};
const float EPS          = 1e-4;
const float PI           = 3.14159265358979;

// ---- data-texture fetch ----------------------------------------------------
vec4 fetchTexel(highp sampler2D s, int w, int lin) {
  return texelFetch(s, ivec2(lin % w, lin / w), 0);
}
float triIndexAt(int k) {
  vec4 t = fetchTexel(uTriIdx, uTriIdxW, k / IDX_PER_TEXEL);
  int c = k % IDX_PER_TEXEL;
  return c == 0 ? t.x : c == 1 ? t.y : c == 2 ? t.z : t.w;
}
vec4 matT(int mat, int j) { return fetchTexel(uMats, uMatsW, mat * MAT_TEXELS + j); }
vec3 triVert(int tri, int corner) { return fetchTexel(uTris, uTrisW, tri * TRI_TEXELS + corner).xyz; }

// ---- PCG per-pixel RNG -----------------------------------------------------
uint rngState;
uint pcgStep(uint s) {
  uint state = s * 747796405u + 2891336453u;
  uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
float rand() {
  rngState = rngState * 747796405u + 2891336453u;
  uint word = ((rngState >> ((rngState >> 28u) + 4u)) ^ rngState) * 277803737u;
  return float((word >> 22u) ^ word) * (1.0 / 4294967296.0);
}

// ---- ray / AABB / triangle -------------------------------------------------
bool hitAABB(vec3 mn, vec3 mx, vec3 o, vec3 invD, float tMax) {
  vec3 ta = (mn - o) * invD;
  vec3 tb = (mx - o) * invD;
  vec3 t0v = min(ta, tb);
  vec3 t1v = max(ta, tb);
  float t0 = max(max(t0v.x, t0v.y), max(t0v.z, EPS));
  float t1 = min(min(t1v.x, t1v.y), min(t1v.z, tMax));
  return t0 <= t1;
}

// Double-sided Möller–Trumbore (matches tracer.ts intersectTri, cull=false).
// Returns t (>EPS) or -1.0; writes the geometric normal (unnormalized) to n and
// the barycentrics (u for corner B, v for corner C) to uv.
float intersectTri(vec3 o, vec3 d, vec3 a, vec3 b, vec3 c, out vec3 n, out vec2 uv) {
  vec3 e1 = b - a;
  vec3 e2 = c - a;
  vec3 p = cross(d, e2);
  float det = dot(e1, p);
  if (det > -1e-12 && det < 1e-12) return -1.0;
  float inv = 1.0 / det;
  vec3 tv = o - a;
  float u = dot(tv, p) * inv;
  if (u < 0.0 || u > 1.0) return -1.0;
  vec3 q = cross(tv, e1);
  float v = dot(d, q) * inv;
  if (v < 0.0 || u + v > 1.0) return -1.0;
  float t = dot(e2, q) * inv;
  if (t <= EPS) return -1.0;
  n = cross(e1, e2);
  uv = vec2(u, v);
  return t;
}

// ---- closest-hit BVH traversal (stack based, fixed depth) ------------------
struct Hit { float t; int tri; vec3 n; vec2 uv; };

Hit traceClosest(vec3 orig, vec3 dir) {
  Hit h;
  h.t = 1e30; h.tri = -1; h.n = vec3(0.0); h.uv = vec2(0.0);
  if (uNodeCount == 0) return h;
  vec3 invD = 1.0 / dir;
  int stack[MAX_STACK];
  int sp = 0;
  stack[sp++] = 0;
  while (sp > 0) {
    int ni = stack[--sp];
    int nb = ni * NODE_TEXELS;
    vec4 t0 = fetchTexel(uNodes, uNodesW, nb);
    vec4 t1 = fetchTexel(uNodes, uNodesW, nb + 1);
    if (!hitAABB(t0.xyz, t1.xyz, orig, invD, h.t)) continue;
    vec4 t2 = fetchTexel(uNodes, uNodesW, nb + 2);
    if (t0.w > 0.5) {
      int off = int(t2.x + 0.5);
      int cnt = int(t2.y + 0.5);
      for (int k = 0; k < cnt; k++) {
        int ti = int(triIndexAt(off + k) + 0.5);
        vec3 a = triVert(ti, 0);
        vec3 b = triVert(ti, 1);
        vec3 c = triVert(ti, 2);
        vec3 n; vec2 uv;
        float t = intersectTri(orig, dir, a, b, c, n, uv);
        if (t > 0.0 && t < h.t) { h.t = t; h.tri = ti; h.n = n; h.uv = uv; }
      }
    } else {
      int l = int(t2.x);
      int r = int(t2.y);
      if (r >= 0 && sp < MAX_STACK) stack[sp++] = r;
      if (l >= 0 && sp < MAX_STACK) stack[sp++] = l;
    }
  }
  return h;
}

// Any-hit shadow test — mirrors tracer.ts occluded(): something in (EPS,maxDist-EPS)?
bool traceAny(vec3 orig, vec3 dir, float maxDist) {
  if (uNodeCount == 0) return false;
  vec3 invD = 1.0 / dir;
  int stack[MAX_STACK];
  int sp = 0;
  stack[sp++] = 0;
  while (sp > 0) {
    int ni = stack[--sp];
    int nb = ni * NODE_TEXELS;
    vec4 t0 = fetchTexel(uNodes, uNodesW, nb);
    vec4 t1 = fetchTexel(uNodes, uNodesW, nb + 1);
    if (!hitAABB(t0.xyz, t1.xyz, orig, invD, maxDist)) continue;
    vec4 t2 = fetchTexel(uNodes, uNodesW, nb + 2);
    if (t0.w > 0.5) {
      int off = int(t2.x + 0.5);
      int cnt = int(t2.y + 0.5);
      for (int k = 0; k < cnt; k++) {
        int ti = int(triIndexAt(off + k) + 0.5);
        vec3 a = triVert(ti, 0);
        vec3 b = triVert(ti, 1);
        vec3 c = triVert(ti, 2);
        vec3 n; vec2 uv;
        float t = intersectTri(orig, dir, a, b, c, n, uv);
        if (t > EPS && t < maxDist - EPS) return true;
      }
    } else {
      int l = int(t2.x);
      int r = int(t2.y);
      if (r >= 0 && sp < MAX_STACK) stack[sp++] = r;
      if (l >= 0 && sp < MAX_STACK) stack[sp++] = l;
    }
  }
  return false;
}

// ---- ONB + cosine hemisphere (Duff et al., matches tracer.ts) --------------
void onbBasis(vec3 n, out vec3 t1, out vec3 t2) {
  float sign = n.z >= 0.0 ? 1.0 : -1.0;
  float aa = -1.0 / (sign + n.z);
  float bb = n.x * n.y * aa;
  t1 = vec3(1.0 + sign * n.x * n.x * aa, sign * bb, -sign * n.x);
  t2 = vec3(bb, sign + n.y * n.y * aa, -n.y);
}
vec3 cosineHemisphere(vec3 n) {
  float r1 = rand(), r2 = rand();
  float phi = 2.0 * PI * r1;
  float r = sqrt(r2);
  float x = r * cos(phi), y = r * sin(phi), z = sqrt(max(0.0, 1.0 - r2));
  vec3 t1, t2; onbBasis(n, t1, t2);
  return x * t1 + y * t2 + z * n;
}

// ---- textures (procedural checker; image falls back to white — documented) --
vec3 sampleTexture(int texKind, vec2 uv) {
  if (texKind == 1) {
    float sum = floor(uv.x * 8.0) + floor(uv.y * 8.0);
    float parity = mod(mod(sum, 2.0) + 2.0, 2.0);
    float s = parity < 0.5 ? 0.2 : 1.0;
    return vec3(s);
  }
  return vec3(1.0);
}

// ---- world/sky (flat / gradient; hdri → gradient fallback) -----------------
vec3 worldSky(vec3 d) {
  if (uWorldMode == 0) return uWorldColor * uWorldStrength;
  float t = clamp(d.z * 0.5 + 0.5, 0.0, 1.0);
  return mix(uWorldHorizon, uWorldZenith, t) * uWorldStrength;
}

// ---- direct lighting (all 4 types, soft shadows, wrapped-diffuse SSS) -------
// Mirrors tracer.ts directLighting. P = hit point, N = shading normal, offN =
// geometric normal (self-shadow bias), wrap softens NdotL for SSS.
vec3 directLighting(vec3 P, vec3 N, vec3 albedo, vec3 offN, float wrap) {
  vec3 outc = vec3(0.0);
  for (int li = 0; li < uNumLights; li++) {
    int base = li * LIGHT_TEXELS;
    vec4 l0 = fetchTexel(uLights, uLightsW, base);       // position.xyz, type
    vec4 l1 = fetchTexel(uLights, uLightsW, base + 1);   // direction.xyz, radius
    vec4 l2 = fetchTexel(uLights, uLightsW, base + 2);   // energy.rgb, cosInner
    vec4 l3 = fetchTexel(uLights, uLightsW, base + 3);   // cosOuter, width, height, _
    int ltype = int(l0.w + 0.5);
    float radius = l1.w;
    bool soft = radius > 0.0;
    vec3 Lpos = l0.xyz; vec3 Ldir = l1.xyz; vec3 energy = l2.xyz;
    vec3 L; float dist; vec3 radiance;

    if (ltype == 3) {
      // Area rect: uniform point sample (center when radius acts elsewhere; here
      // we always jitter — matches the CPU's rng-present branch used by renders).
      vec4 l4 = fetchTexel(uLights, uLightsW, base + 4);
      vec4 l5 = fetchTexel(uLights, uLightsW, base + 5);
      vec3 uAxis = l4.xyz; vec3 vAxis = l5.xyz;
      vec3 e = Lpos;
      float su = (rand() - 0.5) * l3.y;
      float sv = (rand() - 0.5) * l3.z;
      e += uAxis * su + vAxis * sv;
      vec3 dl = e - P;
      float d2 = dot(dl, dl);
      dist = sqrt(d2);
      L = dl / dist;
      float cosLight = -dot(L, Ldir);
      if (cosLight <= 0.0) continue;
      float f = cosLight / max(d2, 1e-6);
      radiance = energy * f;
    } else if (ltype == 1) {
      // sun: L = -direction, no falloff.
      L = normalize(-Ldir);
      if (soft) {
        float cosMax = cos(radius);
        float cosT = 1.0 - rand() * (1.0 - cosMax);
        float sinT = sqrt(max(0.0, 1.0 - cosT * cosT));
        float phi = 2.0 * PI * rand();
        vec3 b1, b2; onbBasis(L, b1, b2);
        L = cos(phi) * sinT * b1 + sin(phi) * sinT * b2 + cosT * L;
      }
      dist = 1e30;
      radiance = energy;
    } else {
      // point / spot: sample sphere of the given radius when soft.
      vec3 e = Lpos;
      if (soft) {
        float z = 2.0 * rand() - 1.0;
        float rp = sqrt(max(0.0, 1.0 - z * z));
        float phi = 2.0 * PI * rand();
        e += vec3(radius * rp * cos(phi), radius * rp * sin(phi), radius * z);
      }
      vec3 dl = e - P;
      float d2 = dot(dl, dl);
      dist = sqrt(d2);
      L = dl / dist;
      float f = 1.0 / max(d2, 1e-6);
      radiance = energy * f;
      if (ltype == 2) {
        float cd = -dot(L, Ldir);
        float cosInner = l2.w, cosOuter = l3.x;
        float s = cosInner == cosOuter ? (cd < cosOuter ? 0.0 : 1.0)
          : clamp((cd - cosOuter) / (cosInner - cosOuter), 0.0, 1.0);
        s = s * s * (3.0 - 2.0 * s);
        radiance *= s;
      }
    }
    float ndotl = dot(N, L);
    float nl = wrap > 0.0 ? max(0.0, (ndotl + wrap) / (1.0 + wrap)) : ndotl;
    if (nl <= 0.0) continue;
    vec3 so = P + offN * EPS;
    if (traceAny(so, L, dist)) continue;
    float k = nl / PI;
    outc += albedo * radiance * k;
  }
  return outc;
}

// ---- emissive mesh-light NEE (area CDF) ------------------------------------
vec3 sampleEmitters(vec3 P, vec3 N, vec3 albedo, vec3 offN) {
  float u = rand();
  int e = 0;
  for (int i = 0; i < uNumEmitters - 1; i++) {
    if (u <= fetchTexel(uEmit, uEmitW, i * EMIT_TEXELS).y) break;
    e = i + 1;
  }
  vec4 e0 = fetchTexel(uEmit, uEmitW, e * EMIT_TEXELS);
  vec3 radiance = fetchTexel(uEmit, uEmitW, e * EMIT_TEXELS + 1).xyz;
  int tri = int(e0.x + 0.5);
  vec3 a = triVert(tri, 0), b = triVert(tri, 1), c = triVert(tri, 2);
  float r1 = rand(), r2 = rand();
  float su = sqrt(r1);
  float w0 = 1.0 - su, w1 = su * (1.0 - r2), w2 = su * r2;
  vec3 sp = a * w0 + b * w1 + c * w2;
  vec3 en = normalize(cross(b - a, c - a));
  vec3 dl = sp - P;
  float d2 = dot(dl, dl);
  float dist = sqrt(d2);
  if (dist < 1e-6) return vec3(0.0);
  vec3 L = dl / dist;
  float cosSurf = dot(N, L);
  if (cosSurf <= 0.0) return vec3(0.0);
  float cosLight = abs(-dot(L, en));
  if (cosLight <= 0.0) return vec3(0.0);
  vec3 so = P + offN * EPS;
  if (traceAny(so, L, dist)) return vec3(0.0);
  float G = (cosSurf * cosLight) / max(d2, 1e-6);
  float k = (G * uEmitTotalArea) / PI;
  return albedo * radiance * k;
}

// ---- dielectric glass BSDF (Fresnel-Schlick + Snell + TIR) ------------------
struct Scatter { vec3 dir; bool refracted; };
Scatter dielectricScatter(vec3 d, vec3 ng, bool frontFace, float ior, float u) {
  Scatter s;
  vec3 nl = frontFace ? ng : -ng;
  float nnt = frontFace ? 1.0 / ior : ior;
  float ddn = dot(d, nl);
  float cos2t = 1.0 - nnt * nnt * (1.0 - ddn * ddn);
  if (cos2t < 0.0) {
    s.dir = d - 2.0 * ddn * nl; s.refracted = false; return s;
  }
  float a = ior - 1.0, b = ior + 1.0;
  float R0 = (a * a) / (b * b);
  float sq = sqrt(cos2t);
  float sign = frontFace ? 1.0 : -1.0;
  vec3 td = d * nnt - ng * (sign * (ddn * nnt + sq));
  td = normalize(td);
  float cf = 1.0 - (frontFace ? -ddn : dot(td, ng));
  float Re = R0 + (1.0 - R0) * cf * cf * cf * cf * cf;
  if (u < Re) {
    s.dir = d - 2.0 * ddn * nl; s.refracted = false; return s;
  }
  s.dir = td; s.refracted = true; return s;
}

// ---- full path trace (mirrors tracer.ts traceRay) --------------------------
// Returns vec4(radiance.rgb, primaryHitFlag) — the alpha carries whether the
// depth-0 primary ray hit geometry (== the CPU renderHitMask), so main() needs
// no second trace.
vec4 traceRay(vec3 orig, vec3 dir) {
  vec3 thr = vec3(1.0);   // throughput
  vec3 rad = vec3(0.0);   // radiance
  bool countEmission = true;
  float primaryHit = 0.0;
  vec3 ox = orig, dd = dir;

  for (int depth = 0; depth < MAX_DEPTH; depth++) {
    Hit h = traceClosest(ox, dd);
    if (depth == 0) primaryHit = h.tri >= 0 ? 1.0 : 0.0;
    if (h.tri < 0) { rad += thr * worldSky(dd); break; }
    int mat = int(fetchTexel(uTris, uTrisW, h.tri * TRI_TEXELS).w + 0.5);
    vec4 m0 = matT(mat, 0), m1 = matT(mat, 1), m2 = matT(mat, 2), m3 = matT(mat, 3);
    vec3 albedo = m0.rgb;
    float matRough = m0.w;
    float matMetal = m1.x;
    float transmission = m1.y;
    float ior = m1.z;
    float es = m1.w;
    vec3 emissive = m2.rgb;
    int texKind = int(m2.w + 0.5);
    bool shadeless = m3.x > 0.5;
    float ssw = m3.y;
    float ssr = m3.z;
    float dw = 1.0 - transmission;

    // Interpolated UV (barycentric A=1-u-v, B=u, C=v) for the checker texture.
    if (texKind != 0) {
      vec4 uvA = fetchTexel(uUVs, uUVsW, h.tri * UV_TEXELS);
      vec2 uv2 = fetchTexel(uUVs, uUVsW, h.tri * UV_TEXELS + 1).xy;
      float w0 = 1.0 - h.uv.x - h.uv.y;
      vec2 uv = uvA.xy * w0 + uvA.zw * h.uv.x + uv2 * h.uv.y;
      albedo *= sampleTexture(texKind, uv);
    }

    // Shadeless: emit base×texture and terminate.
    if (shadeless) { rad += thr * albedo; break; }

    // Emission (mesh-light-gated to avoid NEE double count).
    bool emissiveIsMeshLight = uNumEmitters > 0 && es > 0.0;
    if (es > 0.0 && (!emissiveIsMeshLight || countEmission)) {
      rad += thr * emissive * es;
    }

    bool frontFace = dot(h.n, dd) < 0.0;
    // Normalized geometric normal in ORIGINAL orientation (the CPU passes this to
    // dielectricScatter, which flips internally via frontFace); h.n is the raw
    // unnormalized cross product, so normalize before any BSDF math uses it.
    vec3 ngUnit = normalize(h.n);
    vec3 n = frontFace ? ngUnit : -ngUnit;
    vec3 hp = ox + dd * h.t;
    vec3 gN = n;

    // SSS decision (front face only; draws rng only when ssw > 0).
    bool isSSS = frontFace && ssw > 0.0 && rand() < ssw;

    // Direct lighting (soft shadows via rng; wrapped-diffuse when SSS).
    rad += thr * directLighting(hp, n, albedo, gN, isSSS ? 1.0 : 0.0) * dw;

    // Emissive mesh-light NEE.
    if (uNumEmitters > 0) {
      rad += thr * sampleEmitters(hp, n, albedo, gN) * dw;
    }

    // Russian roulette after a couple of bounces.
    if (depth >= 2) {
      float p = max(max(thr.x, thr.y), max(thr.z, 0.05));
      if (rand() > p) break;
      thr /= p;
    }

    // Bounce: glass → metal → SSS → diffuse (matching the CPU branch order).
    if (transmission > 0.0 && rand() < transmission) {
      Scatter sc = dielectricScatter(dd, ngUnit, frontFace, ior, rand());
      vec3 nd = sc.dir;
      float j = matRough * matRough;
      if (j > 0.0) nd += vec3((rand() * 2.0 - 1.0) * j, (rand() * 2.0 - 1.0) * j, (rand() * 2.0 - 1.0) * j);
      dd = normalize(nd);
      if (sc.refracted) thr *= albedo;
      float os = dot(dd, gN) >= 0.0 ? EPS : -EPS;
      ox = hp + gN * os;
      countEmission = true;
    } else if (rand() < matMetal) {
      float dt = dot(dd, n);
      vec3 b = dd - 2.0 * dt * n;
      float j = matRough * matRough;
      if (j > 0.0) b += vec3((rand() * 2.0 - 1.0) * j, (rand() * 2.0 - 1.0) * j, (rand() * 2.0 - 1.0) * j);
      dd = normalize(b);
      if (dot(dd, n) < 0.0) dd = -dd;
      thr *= albedo;
      ox = hp + gN * EPS;
      countEmission = true;
    } else if (isSSS) {
      float dScatter = ssr * rand();
      dd = cosineHemisphere(n);
      thr *= min(vec3(1.0), albedo);
      ox = hp - gN * dScatter + dd * EPS;
      countEmission = false;
    } else {
      dd = cosineHemisphere(n);
      thr *= albedo;
      ox = hp + gN * EPS;
      countEmission = false;
    }
  }
  return vec4(rad, primaryHit);
}

void main() {
  int px = int(gl_FragCoord.x);
  int py = int(gl_FragCoord.y);
  uint pixel = uint(py * int(uResolution.x) + px);
  rngState = pcgStep(pixel ^ pcgStep(uint(uSampleIndex) * 2654435761u ^ uFrameSeed));

  float jx = uJitter > 0.5 ? rand() - 0.5 : 0.0;
  float jy = uJitter > 0.5 ? rand() - 0.5 : 0.0;
  float fx = gl_FragCoord.x + jx;
  float fy = gl_FragCoord.y + jy;   // gl_FragCoord.y is bottom-up == CPU sy sense
  float aspect = uResolution.x / uResolution.y;
  float th = tan(uFovY * 0.5);
  float sx = (fx / uResolution.x) * 2.0 - 1.0;
  float sy = (fy / uResolution.y) * 2.0 - 1.0;
  vec3 dir = normalize(uForward + uRight * (sx * aspect * th) + uUp * (sy * th));
  vec3 orig = uEye;

  // Thin-lens DoF (parity with the CPU tracer). aperture 0 = pinhole.
  if (uAperture > 0.0) {
    float cosF = dot(dir, uForward);
    float ft = uFocus / max(1e-4, cosF);
    vec3 fp = orig + dir * ft;
    float lr = uAperture * sqrt(rand());
    float la = 6.28318530718 * rand();
    vec3 lo = orig + uRight * (lr * cos(la)) + uUp * (lr * sin(la));
    dir = normalize(fp - lo);
    orig = lo;
  }

  vec4 result = traceRay(orig, dir);

  vec4 prev = texelFetch(uPrevAccum, ivec2(px, py), 0);
  fragColor = prev + result;
}
`;
}
