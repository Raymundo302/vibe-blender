import { Shader } from '../gl/Shader';
import { VertexArray } from '../gl/VertexArray';
import { Vec3 } from '../../core/math/vec3';
import { Mat4 } from '../../core/math/mat4';
import type { Scene } from '../../core/scene/Scene';
import { objectForward, emitStrengthOf, type Material } from '../../core/scene/objectData';
import type { World } from '../../core/scene/worldData';

/**
 * "Rendered" viewport shading (Phase 8): forward PBR-lite lit by the scene's
 * actual light objects. Cook-Torrance GGX specular + Lambert diffuse, Reinhard
 * tonemap + gamma. Deliberately NO fallback light rig — an unlit scene is near
 * black (tiny ambient), so adding your first light is the payoff moment.
 */

export const MAX_LIGHTS = 8;

/** Flat uniform-ready snapshot of the scene's enabled lights. */
export interface LightSet {
  count: number;
  /** xyz per light. */
  positions: Float32Array;
  /** Aim direction (local -Z rotated), xyz per light. */
  directions: Float32Array;
  /** color × power, premultiplied per type (see collectLights). */
  energies: Float32Array;
  /** 0 point, 1 sun, 2 spot, 3 area. */
  types: Float32Array;
  /** cos(inner), cos(outer) per light (spot cone); (width, height) for area. */
  spots: Float32Array;
}

/**
 * Gather up to MAX_LIGHTS visible light objects into shader-ready arrays.
 * Point/spot energy is power/(4π) so radiance = energy/d² matches Blender's
 * watt-ish falloff scale; sun energy is direct irradiance (no falloff).
 */
export function collectLights(scene: Scene): LightSet {
  const set: LightSet = {
    count: 0,
    positions: new Float32Array(MAX_LIGHTS * 3),
    directions: new Float32Array(MAX_LIGHTS * 3),
    energies: new Float32Array(MAX_LIGHTS * 3),
    types: new Float32Array(MAX_LIGHTS),
    spots: new Float32Array(MAX_LIGHTS * 2),
  };
  for (const obj of scene.objects) {
    if (obj.kind !== 'light' || !scene.effectiveVisible(obj) || !obj.light) continue;
    if (set.count >= MAX_LIGHTS) break;
    const i = set.count++;
    const l = obj.light;
    const pose = scene.worldTransformOf(obj);
    const p = pose.position;
    const d = objectForward(pose);
    const scale = l.type === 'sun' ? 1 : 1 / (4 * Math.PI);
    set.positions.set([p.x, p.y, p.z], i * 3);
    set.directions.set([d.x, d.y, d.z], i * 3);
    set.energies.set(
      [l.color[0] * l.power * scale, l.color[1] * l.power * scale, l.color[2] * l.power * scale],
      i * 3,
    );
    set.types[i] = l.type === 'point' ? 0 : l.type === 'sun' ? 1 : l.type === 'spot' ? 2 : 3;
    const outer = l.spotAngle / 2;
    const inner = outer * (1 - l.spotBlend);
    if (l.type === 'area') {
      // Area lights reuse the spot vec2 slot to carry (width, height) so the
      // shader can wrap N·L by the rect size (UR10-1). No cone math applies.
      set.spots.set([l.width ?? 1, l.height ?? 1], i * 2);
    } else {
      set.spots.set([Math.cos(inner), Math.cos(outer)], i * 2);
    }
  }
  return set;
}

/**
 * Which lights cast real-time shadows this frame: suns and spots in scene
 * order, up to `slots`. Returns their light indices; the array position IS the
 * shadow-map slot. Point lights are skipped (no cube maps in the viewport);
 * area lights (type 3) are skipped too — the viewport area approximation has no
 * shadow map in v1 (UR10-1), only cube/spot-map casters get one.
 */
export function shadowCasterIndices(lights: LightSet, slots: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < lights.count && out.length < slots; i++) {
    if (lights.types[i] === 1 || lights.types[i] === 2) out.push(i);
  }
  return out;
}

/** Point lights that cast cube shadows this frame (scene order, capped). */
export function cubeCasterIndices(lights: LightSet, slots: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < lights.count && out.length < slots; i++) {
    if (lights.types[i] === 0) out.push(i);
  }
  return out;
}

const VERT = /* glsl */ `#version 300 es
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec3 a_normal;
layout(location = 2) in vec3 a_color; // per-face tint (white when unset)
layout(location = 3) in vec2 a_uv;    // per-corner UV ((0,0) when un-uvd)
uniform mat4 u_model;
uniform mat4 u_view;
uniform mat4 u_proj;
uniform mat3 u_normalMat; // WORLD-space normal matrix (model only)
uniform mat4 u_shadowVP[4]; // per-slot shadow view-projections (identity when unused)
out vec3 v_worldPos;
out vec3 v_localPos; // object-LOCAL position (UR16-1 gradient eval)
out vec3 v_normal;
out vec3 v_tint;
out vec2 v_uv;
out vec4 v_shadowCoord[4];
void main() {
  vec4 world = u_model * vec4(a_position, 1.0);
  v_worldPos = world.xyz;
  v_localPos = a_position;
  v_normal = u_normalMat * a_normal;
  v_tint = a_color;
  v_uv = a_uv;
  for (int i = 0; i < 4; i++) v_shadowCoord[i] = u_shadowVP[i] * world;
  gl_Position = u_proj * u_view * world;
}`;

const FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec3 v_worldPos;
in vec3 v_localPos;
in vec3 v_normal;
in vec3 v_tint;
in vec2 v_uv;
in vec4 v_shadowCoord[4];

// UR16-1 color gradient (object space) + alpha channel value.
uniform int u_colorGrad;      // 1 = color channel is an object-space gradient
uniform vec3 u_gradA;
uniform vec3 u_gradB;
uniform float u_gradAxis;     // 0 x | 1 y | 2 z
uniform float u_gradOffset;
uniform float u_gradScale;
uniform float u_matAlpha;     // material alpha value (1 = opaque)

uniform int u_texKind;      // 0 none, 1 checker, 2 image
uniform int u_hasTex;       // 1 when an image texture is bound
uniform sampler2D u_tex;    // base-color image (sRGB-encoded → sampled linear)

// P13 map slots (all LINEAR uploads — these are data, not color):
uniform int u_normKind;        // 0 off, 1 tangent-space normal map, 2 bump height
uniform float u_normStrength;  // 0..2
uniform sampler2D u_normTex;   // unit 1
uniform int u_hasRough;
uniform sampler2D u_roughTex;  // unit 2 (grayscale in .r, multiplies roughness)
uniform int u_hasMetal;
uniform sampler2D u_metalTex;  // unit 3 (grayscale in .r, multiplies metallic)

uniform vec3 u_eye;
uniform int u_lightCount;
uniform vec3 u_lightPos[${MAX_LIGHTS}];
uniform vec3 u_lightDir[${MAX_LIGHTS}];
uniform vec3 u_lightEnergy[${MAX_LIGHTS}];
uniform float u_lightType[${MAX_LIGHTS}]; // 0 point, 1 sun, 2 spot, 3 area
uniform vec2 u_spot[${MAX_LIGHTS}];       // cos(inner), cos(outer); (w,h) for area

// Shadow maps (units 4-7). u_shadowSlot[i] = which map light i casts through
// (suns/spots, first-come), or -1 for no shadow. GLSL ES 3.0 forbids dynamic
// sampler indexing, so the four maps are separate uniforms + a slot switch.
uniform float u_shadowSlot[${MAX_LIGHTS}];
uniform highp sampler2DShadow u_shadowMap0;
uniform highp sampler2DShadow u_shadowMap1;
uniform highp sampler2DShadow u_shadowMap2;
uniform highp sampler2DShadow u_shadowMap3;

// Point-light cube shadow maps (units 8-9). u_shadowCubeSlot[i] = cube slot for
// light i, or -1. u_cubeNF[slot] = the cube camera's (near, far) — needed to
// rebuild the face's clip depth from the world-space light distance.
uniform float u_shadowCubeSlot[${MAX_LIGHTS}];
uniform highp samplerCubeShadow u_shadowCube0;
uniform highp samplerCubeShadow u_shadowCube1;
uniform vec2 u_cubeNF[2];

uniform vec3 u_baseColor;
uniform float u_metallic;
uniform float u_roughness;
uniform vec3 u_emissive;
uniform int u_shadeless;   // 1 = output base/texture color directly (no BRDF)
uniform float u_emitStrength; // UR16-4 emit shader: shadeless output × this (1 = exact pixels)
uniform float u_transmission; // UR10-3 glass: >0 → alpha-blend + Fresnel rim
uniform vec3 u_ambient; // flat world-derived ambient (avg world color × strength × 0.3)
uniform sampler2D u_ao;   // blurred SSAO, sampled by fragment coord (white when off)
uniform vec2 u_aoTexel;

out vec4 outColor;

const float PI = 3.14159265359;

// Cook-Torrance GGX (Trowbridge-Reitz) — the standard real-time PBR trio.
float distributionGGX(float NdotH, float a) {
  float a2 = a * a;
  float d = NdotH * NdotH * (a2 - 1.0) + 1.0;
  return a2 / max(PI * d * d, 1e-6);
}
float geometrySmith(float NdotV, float NdotL, float rough) {
  float k = (rough + 1.0) * (rough + 1.0) / 8.0;
  float gv = NdotV / (NdotV * (1.0 - k) + k);
  float glt = NdotL / (NdotL * (1.0 - k) + k);
  return gv * glt;
}
vec3 fresnelSchlick(float cosTheta, vec3 F0) {
  return F0 + (1.0 - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

// 0 = fully shadowed, 1 = lit. sampler2DShadow does the depth compare with
// hardware 2×2 PCF; slope-scaled bias fights acne on grazing faces. Anything
// outside the map's frustum (or behind a spot's apex, w <= 0) is treated as lit.
float shadowFactor(int slot, float NdotL) {
  vec4 c = v_shadowCoord[slot];
  if (c.w <= 0.0) return 1.0;
  vec3 sc = c.xyz / c.w * 0.5 + 0.5;
  if (sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0 || sc.z > 1.0) return 1.0;
  float bias = max(0.003 * (1.0 - NdotL), 0.0008);
  vec3 s = vec3(sc.xy, sc.z - bias);
  if (slot == 0) return texture(u_shadowMap0, s);
  if (slot == 1) return texture(u_shadowMap1, s);
  if (slot == 2) return texture(u_shadowMap2, s);
  return texture(u_shadowMap3, s);
}

// Point-light shadow: sample the cube map by the light→fragment direction and
// compare against the face's clip depth rebuilt from the major-axis distance
// (each face was rendered with a 90° perspective at (near, far)). The bias is
// applied in WORLD units on the distance, scaled with distance so far
// geometry doesn't acne.
float cubeShadowFactor(int slot, vec3 lightPos, float NdotL) {
  vec3 L = v_worldPos - lightPos;
  vec3 a = abs(L);
  float d = max(a.x, max(a.y, a.z));
  vec2 nf = u_cubeNF[slot];
  float bias = (0.02 + 0.05 * (1.0 - NdotL)) * max(1.0, d * 0.2);
  float dz = max(d - bias, nf.x + 1e-4);
  float ndc = (nf.y + nf.x) / (nf.y - nf.x) - 2.0 * nf.y * nf.x / ((nf.y - nf.x) * dz);
  float ref = clamp(ndc * 0.5 + 0.5, 0.0, 1.0);
  if (slot == 0) return texture(u_shadowCube0, vec4(L, ref));
  return texture(u_shadowCube1, vec4(L, ref));
}

void main() {
  vec3 N = normalize(v_normal);
  if (!gl_FrontFacing) N = -N; // two-sided solid shading — light the back face too
  vec3 V = normalize(u_eye - v_worldPos);

  // P13: perturb N by the normal/bump map using a screen-space-derivative TBN
  // (no per-vertex tangents needed; standard dFdx/dFdy construction).
  if (u_normKind != 0) {
    vec3 dpx = dFdx(v_worldPos);
    vec3 dpy = dFdy(v_worldPos);
    vec2 dux = dFdx(v_uv);
    vec2 duy = dFdy(v_uv);
    float det = dux.x * duy.y - duy.x * dux.y;
    if (abs(det) > 1e-12) {
      vec3 T = normalize(dpx * duy.y - dpy * dux.y) * sign(det);
      T = normalize(T - N * dot(N, T));
      vec3 B = cross(N, T);
      if (u_normKind == 1) {
        vec3 nTex = texture(u_normTex, v_uv).rgb * 2.0 - 1.0;
        nTex.xy *= u_normStrength;
        N = normalize(T * nTex.x + B * nTex.y + N * max(nTex.z, 0.05));
      } else {
        vec2 texel = 1.0 / vec2(textureSize(u_normTex, 0));
        float hL = texture(u_normTex, v_uv - vec2(texel.x, 0.0)).r;
        float hR = texture(u_normTex, v_uv + vec2(texel.x, 0.0)).r;
        float hD = texture(u_normTex, v_uv - vec2(0.0, texel.y)).r;
        float hU = texture(u_normTex, v_uv + vec2(0.0, texel.y)).r;
        vec2 grad = vec2(hR - hL, hU - hD) * u_normStrength * 4.0;
        N = normalize(N - T * grad.x - B * grad.y);
      }
    }
  }

  float rough = clamp(u_roughness, 0.04, 1.0);
  if (u_hasRough == 1) rough = clamp(rough * texture(u_roughTex, v_uv).r, 0.04, 1.0);
  float metallic = u_metallic;
  if (u_hasMetal == 1) metallic *= texture(u_metalTex, v_uv).r;
  vec3 baseColor = u_baseColor * v_tint;
  // UR16-1: object-space color GRADIENT overrides baseColor (and the texture).
  if (u_colorGrad == 1) {
    float c = u_gradAxis < 0.5 ? v_localPos.x : u_gradAxis < 1.5 ? v_localPos.y : v_localPos.z;
    float t = clamp(c * u_gradScale + u_gradOffset, 0.0, 1.0);
    baseColor = mix(u_gradA, u_gradB, t) * v_tint;
  } else if (u_texKind == 1) {
    // Base-color texture through the UVs (matches the tracer's sampleMaterialTexture):
    // checker = 8×8 parity (even → 0.2 dark, odd → 1.0 light), image = bilinear.
    float parity = mod(floor(v_uv.x * 8.0) + floor(v_uv.y * 8.0), 2.0);
    baseColor *= mix(vec3(0.2), vec3(1.0), parity);
  } else if (u_texKind == 2 && u_hasTex == 1) {
    baseColor *= texture(u_tex, v_uv).rgb;
  }
  // Shadeless (UR4-3): the base/texture color IS the output — no lights, no
  // shadows, no BRDF. Screen-space AO still multiplies (documented). baseColor
  // is linear (image sampled from an sRGB texture); gamma-encode for display so
  // the plane reads back exactly as the source image (blueprints/refs).
  if (u_shadeless == 1) {
    // UR16-4: emit radiance = colorSocket × strength. At strength 1 the gamma-
    // encoded output equals the source image (exact pixels — a screen). Above 1 the
    // linear color is scaled before gamma so the surface reads full-bright and
    // Camera Glare blooms it (no real GI in the live viewport — glare sells it).
    vec3 c = baseColor * max(u_emitStrength, 0.0);
    c *= texture(u_ao, gl_FragCoord.xy * u_aoTexel).r;
    c = pow(c, vec3(1.0 / 2.2));
    outColor = vec4(c, u_matAlpha);
    return;
  }
  vec3 F0 = mix(vec3(0.04), baseColor, metallic);

  // Flat ambient from the world (honest approximation of image-based lighting:
  // average world color × strength × 0.3, computed on the CPU as u_ambient).
  vec3 color = u_ambient * baseColor;
  for (int i = 0; i < ${MAX_LIGHTS}; i++) {
    if (i >= u_lightCount) break;
    vec3 L;
    vec3 radiance;
    // Area lights (type 3, UR10-1) are approximated as a point light at the rect
    // CENTER with a clamped-distance falloff plus an N·L WRAP scaled by the rect
    // size (softens the terminator so a big soft light doesn't read as a hard
    // point). NO shadow map (skipped in renderShadows) — this is the v1 stopgap
    // until LTC. u_spot carries (width, height) for area lights.
    float ndlWrap = 0.0;
    if (u_lightType[i] > 0.5 && u_lightType[i] < 1.5) { // sun
      L = -u_lightDir[i];
      radiance = u_lightEnergy[i];
    } else {
      vec3 toLight = u_lightPos[i] - v_worldPos;
      float minD2 = 1e-4;
      if (u_lightType[i] > 2.5) { // area: clamp falloff + wrap by rect size
        float sz = 0.5 * (u_spot[i].x + u_spot[i].y);
        minD2 = max(minD2, sz * sz * 0.25);
        ndlWrap = clamp(sz * 0.25, 0.0, 0.5);
      }
      float d2 = max(dot(toLight, toLight), minD2);
      L = toLight * inversesqrt(d2);
      radiance = u_lightEnergy[i] / d2;
      if (u_lightType[i] > 1.5 && u_lightType[i] < 2.5) { // spot cone falloff
        float cd = dot(-L, u_lightDir[i]);
        radiance *= smoothstep(u_spot[i].y, u_spot[i].x, cd);
      }
    }
    float rawNdotL = dot(N, L);
    float NdotL = ndlWrap > 0.0
      ? max((rawNdotL + ndlWrap) / (1.0 + ndlWrap), 0.0)
      : max(rawNdotL, 0.0);
    if (NdotL <= 0.0) continue;
    int slot = int(u_shadowSlot[i]);
    if (slot >= 0) {
      float shadow = shadowFactor(slot, NdotL);
      if (shadow <= 0.0) continue;
      radiance *= shadow;
    }
    int cubeSlot = int(u_shadowCubeSlot[i]);
    if (cubeSlot >= 0) {
      float shadow = cubeShadowFactor(cubeSlot, u_lightPos[i], NdotL);
      if (shadow <= 0.0) continue;
      radiance *= shadow;
    }
    vec3 H = normalize(V + L);
    float NdotV = max(dot(N, V), 1e-4);
    float NdotH = max(dot(N, H), 0.0);
    float D = distributionGGX(NdotH, rough * rough);
    float G = geometrySmith(NdotV, NdotL, rough);
    vec3 F = fresnelSchlick(max(dot(H, V), 0.0), F0);
    vec3 specular = (D * G * F) / (4.0 * NdotV * NdotL + 1e-4);
    vec3 kd = (1.0 - F) * (1.0 - metallic);
    color += (kd * baseColor / PI + specular) * radiance * NdotL;
  }
  // SSAO darkens the lit result but never self-lit emission.
  color *= texture(u_ao, gl_FragCoord.xy * u_aoTexel).r;

  color = color / (color + vec3(1.0));   // Reinhard tonemap (lit only)
  color = pow(color, vec3(1.0 / 2.2));   // gamma
  // UR10-2 Part A: emission is added AFTER tonemap as HDR-ish — a glowing surface
  // reads full-bright (emissive·strength clamps to white in the 8-bit viewport),
  // and when Camera Glare (Part B) captures the frame to a float target its >1
  // values survive so the bright-pass can bloom them.
  color += u_emissive;
  // UR10-3 glass approximation (viewport only — no refraction): a transmission
  // material draws alpha-blended so whatever is behind shows through, with a
  // view-angle (Fresnel) rim highlight so the silhouette reads as glass. alpha ≈
  // 1 − 0.85·transmission at face-on, rising to fully opaque at the grazing rim;
  // the rim also adds a bright specular sheen. Opaque materials (u_transmission
  // 0) keep alpha 1 and no rim — byte-identical.
  float alpha = 1.0;
  if (u_transmission > 0.0) {
    float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0);
    alpha = mix(1.0 - 0.85 * u_transmission, 1.0, fres);
    color += vec3(fres * u_transmission * 0.4);
  }
  // UR16-1: the material alpha channel multiplies the final coverage (opaque
  // materials pass u_matAlpha 1 → byte-identical).
  outColor = vec4(color, alpha * u_matAlpha);
}`;

/** Forward PBR solid pass driven by the scene's light objects + materials. */
export class RenderedPass {
  readonly shader: Shader;
  /** 1×1 opaque white — bound to the sampler when no image texture is present,
   * so the sampler unit is never left pointing at nothing. */
  private readonly white: WebGLTexture;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.shader = new Shader(gl, VERT, FRAG, 'mesh-rendered');
    this.white = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.white);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([255, 255, 255, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  }

  /**
   * Bind per-frame state: camera + the frame's light set + world ambient +
   * the shadow maps. `shadowMaps` is ALWAYS the ShadowPass's 4 depth textures
   * (their compare mode makes them valid for sampler2DShadow even when
   * unused); `casters` lists the lights that actually rendered a map this
   * frame — casters[slot] = { light-space matrix, light index }. Lights not
   * in it get u_shadowSlot = -1 (no shadow sampling).
   */
  begin(
    view: Mat4, proj: Mat4, eye: Vec3, lights: LightSet, ambient: Vec3,
    shadowMaps: readonly WebGLTexture[],
    casters: readonly { viewProj: Mat4; lightIndex: number }[],
    cubeMaps: readonly WebGLTexture[],
    cubeCasters: readonly { lightIndex: number; near: number; far: number }[],
    ao: WebGLTexture,
    aoW: number,
    aoH: number,
  ): void {
    const s = this.shader;
    s.use();
    s.setMat4('u_view', view);
    s.setMat4('u_proj', proj);
    s.setVec3('u_eye', eye);
    s.setVec3('u_ambient', ambient);
    const gl = this.gl;
    for (let slot = 0; slot < 4; slot++) {
      gl.activeTexture(gl.TEXTURE4 + slot);
      gl.bindTexture(gl.TEXTURE_2D, shadowMaps[slot]);
      s.setInt(`u_shadowMap${slot}`, 4 + slot);
      s.setMat4(`u_shadowVP[${slot}]`, casters[slot]?.viewProj ?? Mat4.identity());
    }
    // Cube maps on units 8-9 (always bound — compare mode makes them valid
    // samplerCubeShadow targets even when no point light casts).
    for (let slot = 0; slot < 2; slot++) {
      gl.activeTexture(gl.TEXTURE8 + slot);
      gl.bindTexture(gl.TEXTURE_CUBE_MAP, cubeMaps[slot]);
      s.setInt(`u_shadowCube${slot}`, 8 + slot);
      const cc = cubeCasters[slot];
      s.setVec2(`u_cubeNF[${slot}]`, cc?.near ?? 0.05, cc?.far ?? 100);
    }
    gl.activeTexture(gl.TEXTURE10);
    gl.bindTexture(gl.TEXTURE_2D, ao);
    gl.activeTexture(gl.TEXTURE0);
    s.setInt('u_ao', 10);
    s.setVec2('u_aoTexel', 1 / aoW, 1 / aoH);
    const slotOf = new Map(casters.map((c, slot) => [c.lightIndex, slot]));
    const cubeSlotOf = new Map(cubeCasters.map((c, slot) => [c.lightIndex, slot]));
    for (let i = 0; i < MAX_LIGHTS; i++) {
      s.setFloat(`u_shadowSlot[${i}]`, slotOf.get(i) ?? -1);
      s.setFloat(`u_shadowCubeSlot[${i}]`, cubeSlotOf.get(i) ?? -1);
    }
    s.setInt('u_lightCount', lights.count);
    // Shader has no array setters; set array uniforms element by element.
    for (let i = 0; i < lights.count; i++) {
      s.setVec3(`u_lightPos[${i}]`, vec3At(lights.positions, i));
      s.setVec3(`u_lightDir[${i}]`, vec3At(lights.directions, i));
      s.setVec3(`u_lightEnergy[${i}]`, vec3At(lights.energies, i));
      s.setFloat(`u_lightType[${i}]`, lights.types[i]);
      s.setVec2(`u_spot[${i}]`, lights.spots[i * 2], lights.spots[i * 2 + 1]);
    }
  }

  setObject(model: Mat4, mat: Material): void {
    const s = this.shader;
    s.setMat4('u_model', model);
    s.setMat3('u_normalMat', model.normalMatrix());
    s.setVec3('u_baseColor', new Vec3(mat.baseColor[0], mat.baseColor[1], mat.baseColor[2]));
    s.setFloat('u_metallic', mat.metallic);
    s.setFloat('u_roughness', mat.roughness);
    s.setVec3(
      'u_emissive',
      new Vec3(
        mat.emissive[0] * mat.emissiveStrength,
        mat.emissive[1] * mat.emissiveStrength,
        mat.emissive[2] * mat.emissiveStrength,
      ),
    );
    s.setInt('u_texKind', mat.texKind === 'checker' ? 1 : mat.texKind === 'image' ? 2 : 0);
    s.setInt('u_shadeless', mat.shadeless ? 1 : 0);
    // UR16-4: the emit shader's light strength scales the shadeless output (1 =
    // exact pixels). Non-emit shadeless refs (legacy) emit at 1.
    s.setFloat('u_emitStrength', emitStrengthOf(mat));
    s.setFloat('u_transmission', mat.transmission ?? 0);
    s.setFloat('u_normStrength', mat.normalStrength);
    // UR16-1: object-space color gradient + alpha channel value. A material with
    // no gradient/alpha passes u_colorGrad 0 / u_matAlpha 1 → byte-identical.
    const cg = mat.colorGradient;
    s.setInt('u_colorGrad', cg ? 1 : 0);
    if (cg) {
      s.setVec3('u_gradA', new Vec3(cg.a[0], cg.a[1], cg.a[2]));
      s.setVec3('u_gradB', new Vec3(cg.b[0], cg.b[1], cg.b[2]));
      s.setFloat('u_gradAxis', cg.axis === 'x' ? 0 : cg.axis === 'y' ? 1 : 2);
      s.setFloat('u_gradOffset', cg.offset);
      s.setFloat('u_gradScale', cg.scale);
    }
    // Alpha VALUE only in the viewport (gradient/image alpha → opaque here, a
    // documented viewport cut; the F12 tracer/GPU evaluate the full channel).
    const a = mat.alpha;
    s.setFloat('u_matAlpha', a && a.kind === 'value' ? Math.max(0, Math.min(1, a.value)) : 1);
  }

  /**
   * Bind the base-color image for the next draw on texture unit 0 (the Renderer
   * owns the per-material upload cache). Pass null for checker / none — the 1×1
   * white fallback binds so the sampler unit is always valid.
   */
  bindTexture(tex: WebGLTexture | null): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex ?? this.white);
    this.shader.setInt('u_hasTex', tex ? 1 : 0);
    this.shader.setInt('u_tex', 0);
  }

  /**
   * Bind the P13 map textures (units 1-3) for the next draw. A slot whose
   * texture is null (no map, or its async decode is still in flight) binds the
   * 1×1 white fallback AND disables the feature — u_normKind is forced to 0
   * here even if the material has a normalDataUrl, so a mid-decode frame
   * renders unperturbed instead of sampling garbage.
   */
  bindMaps(mat: Material, norm: WebGLTexture | null, rough: WebGLTexture | null, metal: WebGLTexture | null): void {
    const gl = this.gl;
    const s = this.shader;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, norm ?? this.white);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, rough ?? this.white);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, metal ?? this.white);
    gl.activeTexture(gl.TEXTURE0);
    s.setInt('u_normTex', 1);
    s.setInt('u_roughTex', 2);
    s.setInt('u_metalTex', 3);
    s.setInt('u_normKind', norm ? (mat.normalIsBump ? 2 : 1) : 0);
    s.setInt('u_hasRough', rough ? 1 : 0);
    s.setInt('u_hasMetal', metal ? 1 : 0);
  }
}

function vec3At(a: Float32Array, i: number): Vec3 {
  return new Vec3(a[i * 3], a[i * 3 + 1], a[i * 3 + 2]);
}

// ---------------------------------------------------------------------------
// World background (P10-4): a fullscreen pass that paints the environment as
// the Rendered-viewport backdrop. Per fragment it reconstructs the view ray
// (from the inverse view-projection) and evaluates flat / gradient / HDRI —
// the exact same math the path tracer's ray-miss uses (worldSky / equirectUV),
// so the viewport preview and the F12 render agree. Tonemap+gamma match the
// mesh pass so lit geometry and sky sit in one display space.
// ---------------------------------------------------------------------------

const BG_VERT = /* glsl */ `#version 300 es
layout(location = 0) in vec2 a_pos;
out vec2 v_ndc;
void main() {
  v_ndc = a_pos;
  gl_Position = vec4(a_pos, 1.0, 1.0);
}`;

const BG_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_ndc;
uniform mat4 u_invViewProj;
uniform vec3 u_eye;
uniform int u_mode;        // 0 flat, 1 gradient, 2 hdri
uniform vec3 u_color;
uniform vec3 u_horizon;
uniform vec3 u_zenith;
uniform float u_strength;
uniform int u_hasHdri;     // 1 when the equirect texture is ready
uniform sampler2D u_hdri;  // sRGB-encoded equirect (sampled as linear)
out vec4 outColor;

const float PI = 3.14159265359;

void main() {
  vec4 farP = u_invViewProj * vec4(v_ndc, 1.0, 1.0);
  vec4 nearP = u_invViewProj * vec4(v_ndc, -1.0, 1.0);
  vec3 dir = normalize(farP.xyz / farP.w - nearP.xyz / nearP.w);

  vec3 c;
  if (u_mode == 0) {
    c = u_color;
  } else if (u_mode == 2 && u_hasHdri == 1) {
    // Z-up equirect — must mirror worldData.equirectUV exactly.
    float u = 0.5 + atan(dir.x, -dir.y) / (2.0 * PI);
    float v = 0.5 - asin(clamp(dir.z, -1.0, 1.0)) / PI;
    c = texture(u_hdri, vec2(u, v)).rgb;
  } else {
    float t = clamp(dir.z * 0.5 + 0.5, 0.0, 1.0);
    c = mix(u_horizon, u_zenith, t);
  }
  c *= u_strength;
  c = c / (c + vec3(1.0));      // Reinhard tonemap (matches the mesh pass)
  c = pow(c, vec3(1.0 / 2.2));  // gamma
  outColor = vec4(c, 1.0);
}`;

const WORLD_MODE_CODE: Record<World['mode'], number> = { flat: 0, gradient: 1, hdri: 2 };

/** Fullscreen environment backdrop for Rendered viewport mode. */
export class WorldBackgroundPass {
  private readonly shader: Shader;
  private readonly tri: VertexArray;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.shader = new Shader(gl, BG_VERT, BG_FRAG, 'world-bg');
    // A single oversized triangle covering the NDC square.
    this.tri = new VertexArray(gl, [
      { location: 0, size: 2, data: new Float32Array([-1, -1, 3, -1, -1, 3]) },
    ]);
  }

  /**
   * Paint the world into the whole viewport. `invViewProj` = inverse(proj·view)
   * of the current frame; `hdri` is the uploaded equirect texture (or null).
   * Runs with depth test off and no depth write, so meshes draw over it.
   */
  render(invViewProj: Mat4, eye: Vec3, world: World, hdri: WebGLTexture | null): void {
    const gl = this.gl;
    const s = this.shader;
    s.use();
    s.setMat4('u_invViewProj', invViewProj);
    s.setVec3('u_eye', eye);
    s.setInt('u_mode', WORLD_MODE_CODE[world.mode]);
    s.setVec3('u_color', new Vec3(world.color[0], world.color[1], world.color[2]));
    s.setVec3('u_horizon', new Vec3(world.horizon[0], world.horizon[1], world.horizon[2]));
    s.setVec3('u_zenith', new Vec3(world.zenith[0], world.zenith[1], world.zenith[2]));
    s.setFloat('u_strength', world.strength);
    const hasHdri = world.mode === 'hdri' && hdri !== null;
    s.setInt('u_hasHdri', hasHdri ? 1 : 0);
    if (hasHdri) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, hdri);
      s.setInt('u_hdri', 0);
    }
    const depthWasOn = gl.isEnabled(gl.DEPTH_TEST);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    this.tri.draw(gl.TRIANGLES);
    gl.depthMask(true);
    if (depthWasOn) gl.enable(gl.DEPTH_TEST);
  }
}
