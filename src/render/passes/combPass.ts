import { Shader } from '../gl/Shader';
import { VertexArray } from '../gl/VertexArray';
import { combFor } from '../combPrefs';
import { fromCurveData, curveDomain, curvatureAt, type NCurve } from '../../core/nurbs/curve';
import type { Mat4 } from '../../core/math/mat4';
import type { Scene, SceneObject } from '../../core/scene/Scene';

/**
 * Curvature combs (NB-B1) — the Alias/Rhino "porcupine" for curve objects. For
 * every visible curve whose per-object comb pref is ON, we sample κ (curvature)
 * at `samples` uniform domain parameters and, at each sample, draw a TOOTH:
 * a world-space line from the curve point outward along the convex side (the
 * −principal-normal direction — the principal normal points TOWARD the centre of
 * curvature, so the comb sticks out the far side), with length = κ·0.35·scale.
 * The teeth tips are joined by an ENVELOPE polyline. Straight spans (κ≈0 / zero
 * normal) draw a zero-length tooth (the envelope passes through the base point).
 *
 * Teeth are drawn slightly transparent, the envelope solid, in a teal accent
 * distinct from the curve's own orange/grey ribbon. World-space via u_modelView
 * (the curveEditPass pattern), depth test on, blended. Buffers cache per object,
 * keyed by (curve signature, scale, samples).
 */
const VERT = /* glsl */ `#version 300 es
layout(location = 0) in vec3 a_position;
uniform mat4 u_modelView;
uniform mat4 u_proj;
void main() {
  vec4 viewPos = u_modelView * vec4(a_position, 1.0);
  viewPos.xyz *= (1.0 - 0.0015); // fractional pull toward the eye (win z-fight vs the ribbon)
  gl_Position = u_proj * viewPos;
}`;

const FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform vec4 u_color;
out vec4 outColor;
void main() { outColor = u_color; }`;

/** Teal comb accent (distinct from the wire/ribbon orange + grid grey). */
const TEETH: [number, number, number, number] = [0.16, 0.78, 0.95, 0.55];
const ENVELOPE: [number, number, number, number] = [0.16, 0.78, 0.95, 1.0];

/** Tooth length per unit curvature (world units at scale 1). */
const KAPPA_SCALE = 0.35;

interface CombGpu {
  key: string;
  teeth: VertexArray | null;
  envelope: VertexArray | null;
}

export class CombPass {
  private readonly shader: Shader;
  private readonly cache = new Map<number, CombGpu>();

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.shader = new Shader(gl, VERT, FRAG, 'curve-comb');
  }

  /** Build (or reuse) the comb buffers for one curve. */
  private gpuFor(obj: SceneObject): CombGpu | null {
    const curve = obj.curve;
    if (!curve || curve.points.length < 2) return null;
    const pref = combFor(obj.id);
    const key = `${JSON.stringify(curve)}:${pref.scale}:${pref.samples}`;
    const cached = this.cache.get(obj.id);
    if (cached && cached.key === key) return cached;
    cached?.teeth?.dispose();
    cached?.envelope?.dispose();

    const nc = fromCurveData(curve);
    if (!nc) {
      const empty: CombGpu = { key, teeth: null, envelope: null };
      this.cache.set(obj.id, empty);
      return empty;
    }
    const built = this.buildBuffers(nc, curve.cyclic ?? false, pref.scale, pref.samples, key);
    this.cache.set(obj.id, built);
    return built;
  }

  private buildBuffers(nc: NCurve, cyclic: boolean, scale: number, samples: number, key: string): CombGpu {
    const [lo, hi] = curveDomain(nc);
    const span = hi - lo;
    const teethPos: number[] = [];
    const tips: number[] = []; // flat [x,y,z] per sample, in order (for the envelope)

    // Cyclic curves sample the half-open domain [lo, hi) so the envelope closes
    // without a doubled endpoint; open curves include both ends.
    const count = Math.max(2, samples | 0);
    for (let i = 0; i < count; i++) {
      const u = cyclic ? lo + (span * i) / count : lo + (span * i) / (count - 1);
      const s = curvatureAt(nc, u);
      const len = s.kappa * KAPPA_SCALE * scale;
      // Draw along the CONVEX side: −principal-normal (normal points inward,
      // toward the centre of curvature). Straight spans → zero-length tooth.
      const tx = s.point.x - s.normal.x * len;
      const ty = s.point.y - s.normal.y * len;
      const tz = s.point.z - s.normal.z * len;
      if (len > 1e-9) {
        teethPos.push(s.point.x, s.point.y, s.point.z, tx, ty, tz);
      }
      tips.push(tx, ty, tz);
    }

    // Envelope: consecutive tips, as explicit line segments (closed for cyclic).
    const envPos: number[] = [];
    const n = tips.length / 3;
    const segEnd = cyclic ? n : n - 1;
    for (let i = 0; i < segEnd; i++) {
      const a = i * 3;
      const b = ((i + 1) % n) * 3;
      envPos.push(tips[a], tips[a + 1], tips[a + 2], tips[b], tips[b + 1], tips[b + 2]);
    }

    const gl = this.gl;
    const teeth = teethPos.length > 0
      ? new VertexArray(gl, [{ location: 0, size: 3, data: new Float32Array(teethPos) }])
      : null;
    const envelope = envPos.length > 0
      ? new VertexArray(gl, [{ location: 0, size: 3, data: new Float32Array(envPos) }])
      : null;
    return { key, teeth, envelope };
  }

  /**
   * Draw combs for every visible curve object with `on`. Called right after
   * drawCurves in each shading mode. World-space, depth test on, blended.
   */
  render(scene: Scene, visible: SceneObject[], view: Mat4, proj: Mat4): void {
    const combs = visible.filter((o) =>
      o.kind === 'curve' && o.curve && o.curve.points.length >= 2 && combFor(o.id).on);
    if (combs.length === 0) return;

    const gl = this.gl;
    this.shader.use();
    this.shader.setMat4('u_proj', proj);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    for (const obj of combs) {
      const g = this.gpuFor(obj);
      if (!g || (!g.teeth && !g.envelope)) continue;
      this.shader.setMat4('u_modelView', view.mul(scene.worldMatrix(obj)));
      if (g.teeth) {
        this.shader.setVec4('u_color', TEETH[0], TEETH[1], TEETH[2], TEETH[3]);
        g.teeth.draw(gl.LINES);
      }
      if (g.envelope) {
        this.shader.setVec4('u_color', ENVELOPE[0], ENVELOPE[1], ENVELOPE[2], ENVELOPE[3]);
        g.envelope.draw(gl.LINES);
      }
    }
    gl.disable(gl.BLEND);
  }
}
