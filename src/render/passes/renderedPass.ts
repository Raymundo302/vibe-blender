import { Shader } from '../gl/Shader';
import { Vec3 } from '../../core/math/vec3';
import type { Mat4 } from '../../core/math/mat4';
import type { Scene } from '../../core/scene/Scene';
import { objectForward, type Material } from '../../core/scene/objectData';

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
uniform mat4 u_model;
uniform mat4 u_view;
uniform mat4 u_proj;
uniform mat3 u_normalMat; // WORLD-space normal matrix (model only)
out vec3 v_worldPos;
out vec3 v_normal;
out vec3 v_tint;
void main() {
  vec4 world = u_model * vec4(a_position, 1.0);
  v_worldPos = world.xyz;
  v_normal = u_normalMat * a_normal;
  v_tint = a_color;
  gl_Position = u_proj * u_view * world;
}`;

const FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec3 v_worldPos;
in vec3 v_normal;
in vec3 v_tint;

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
  vec3 F0 = mix(vec3(0.04), baseColor, u_metallic);

  vec3 color = vec3(0.03) * baseColor; // whisper of ambient so shapes read
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

  constructor(gl: WebGL2RenderingContext) {
    this.shader = new Shader(gl, VERT, FRAG, 'mesh-rendered');
  }

  /** Bind per-frame state: camera + the frame's light set. */
  begin(view: Mat4, proj: Mat4, eye: Vec3, lights: LightSet): void {
    const s = this.shader;
    s.use();
    s.setMat4('u_view', view);
    s.setMat4('u_proj', proj);
    s.setVec3('u_eye', eye);
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
  }
}

function vec3At(a: Float32Array, i: number): Vec3 {
  return new Vec3(a[i * 3], a[i * 3 + 1], a[i * 3 + 2]);
}
