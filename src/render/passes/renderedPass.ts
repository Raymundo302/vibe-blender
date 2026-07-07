import { Shader } from '../gl/Shader';
import { VertexArray } from '../gl/VertexArray';
import { Vec3 } from '../../core/math/vec3';
import type { Mat4 } from '../../core/math/mat4';
import type { Scene } from '../../core/scene/Scene';
import { objectForward, type Material } from '../../core/scene/objectData';
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
  /** 0 point, 1 sun, 2 spot. */
  types: Float32Array;
  /** cos(inner), cos(outer) per light (spot cone). */
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
    const p = obj.transform.position;
    const d = objectForward(obj.transform);
    const scale = l.type === 'sun' ? 1 : 1 / (4 * Math.PI);
    set.positions.set([p.x, p.y, p.z], i * 3);
    set.directions.set([d.x, d.y, d.z], i * 3);
    set.energies.set(
      [l.color[0] * l.power * scale, l.color[1] * l.power * scale, l.color[2] * l.power * scale],
      i * 3,
    );
    set.types[i] = l.type === 'point' ? 0 : l.type === 'sun' ? 1 : 2;
    const outer = l.spotAngle / 2;
    const inner = outer * (1 - l.spotBlend);
    set.spots.set([Math.cos(inner), Math.cos(outer)], i * 2);
  }
  return set;
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
out vec3 v_worldPos;
out vec3 v_normal;
out vec3 v_tint;
out vec2 v_uv;
void main() {
  vec4 world = u_model * vec4(a_position, 1.0);
  v_worldPos = world.xyz;
  v_normal = u_normalMat * a_normal;
  v_tint = a_color;
  v_uv = a_uv;
  gl_Position = u_proj * u_view * world;
}`;

const FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec3 v_worldPos;
in vec3 v_normal;
in vec3 v_tint;
in vec2 v_uv;

uniform int u_texKind;      // 0 none, 1 checker, 2 image
uniform int u_hasTex;       // 1 when an image texture is bound
uniform sampler2D u_tex;    // base-color image (sRGB-encoded → sampled linear)

uniform vec3 u_eye;
uniform int u_lightCount;
uniform vec3 u_lightPos[${MAX_LIGHTS}];
uniform vec3 u_lightDir[${MAX_LIGHTS}];
uniform vec3 u_lightEnergy[${MAX_LIGHTS}];
uniform float u_lightType[${MAX_LIGHTS}]; // 0 point, 1 sun, 2 spot
uniform vec2 u_spot[${MAX_LIGHTS}];       // cos(inner), cos(outer)

uniform vec3 u_baseColor;
uniform float u_metallic;
uniform float u_roughness;
uniform vec3 u_emissive;
uniform vec3 u_ambient; // flat world-derived ambient (avg world color × strength × 0.3)

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

void main() {
  vec3 N = normalize(v_normal);
  vec3 V = normalize(u_eye - v_worldPos);
  float rough = clamp(u_roughness, 0.04, 1.0);
  vec3 baseColor = u_baseColor * v_tint;
  // Base-color texture through the UVs (matches the tracer's sampleMaterialTexture):
  // checker = 8×8 parity (even → 0.2 dark, odd → 1.0 light), image = bilinear.
  if (u_texKind == 1) {
    float parity = mod(floor(v_uv.x * 8.0) + floor(v_uv.y * 8.0), 2.0);
    baseColor *= mix(vec3(0.2), vec3(1.0), parity);
  } else if (u_texKind == 2 && u_hasTex == 1) {
    baseColor *= texture(u_tex, v_uv).rgb;
  }
  vec3 F0 = mix(vec3(0.04), baseColor, u_metallic);

  // Flat ambient from the world (honest approximation of image-based lighting:
  // average world color × strength × 0.3, computed on the CPU as u_ambient).
  vec3 color = u_ambient * baseColor;
  for (int i = 0; i < ${MAX_LIGHTS}; i++) {
    if (i >= u_lightCount) break;
    vec3 L;
    vec3 radiance;
    if (u_lightType[i] > 0.5 && u_lightType[i] < 1.5) { // sun
      L = -u_lightDir[i];
      radiance = u_lightEnergy[i];
    } else {
      vec3 toLight = u_lightPos[i] - v_worldPos;
      float d2 = max(dot(toLight, toLight), 1e-4);
      L = toLight * inversesqrt(d2);
      radiance = u_lightEnergy[i] / d2;
      if (u_lightType[i] > 1.5) { // spot cone falloff
        float cd = dot(-L, u_lightDir[i]);
        radiance *= smoothstep(u_spot[i].y, u_spot[i].x, cd);
      }
    }
    float NdotL = max(dot(N, L), 0.0);
    if (NdotL <= 0.0) continue;
    vec3 H = normalize(V + L);
    float NdotV = max(dot(N, V), 1e-4);
    float NdotH = max(dot(N, H), 0.0);
    float D = distributionGGX(NdotH, rough * rough);
    float G = geometrySmith(NdotV, NdotL, rough);
    vec3 F = fresnelSchlick(max(dot(H, V), 0.0), F0);
    vec3 specular = (D * G * F) / (4.0 * NdotV * NdotL + 1e-4);
    vec3 kd = (1.0 - F) * (1.0 - u_metallic);
    color += (kd * baseColor / PI + specular) * radiance * NdotL;
  }
  color += u_emissive;

  color = color / (color + vec3(1.0));   // Reinhard tonemap
  color = pow(color, vec3(1.0 / 2.2));   // gamma
  outColor = vec4(color, 1.0);
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

  /** Bind per-frame state: camera + the frame's light set + world ambient. */
  begin(view: Mat4, proj: Mat4, eye: Vec3, lights: LightSet, ambient: Vec3): void {
    const s = this.shader;
    s.use();
    s.setMat4('u_view', view);
    s.setMat4('u_proj', proj);
    s.setVec3('u_eye', eye);
    s.setVec3('u_ambient', ambient);
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
    float u = 0.5 + atan(dir.x, dir.z) / (2.0 * PI);
    float v = 0.5 - asin(clamp(dir.y, -1.0, 1.0)) / PI;
    c = texture(u_hdri, vec2(u, v)).rgb;
  } else {
    float t = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
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
