import { Shader } from '../gl/Shader';
import { Vec3 } from '../../core/math/vec3';
import type { Mat4 } from '../../core/math/mat4';

/**
 * Mesh-mesh intersection lines ("Intersections" shading option): light grey
 * lines where two objects' geometry passes through each other.
 *
 * NOT gl.LINES: a 1px mid-grey hairline is invisible against the matcap greys
 * it usually sits on (and WebGL lineWidth is capped at 1 on ANGLE/core
 * profiles). Each segment is a screen-space RIBBON — two triangles extruded
 * perpendicular to the segment's screen direction in the vertex shader — a
 * solid light grey band with anti-aliased (alpha-faded) edges, wide enough to
 * read against the matcap greys. Drawn blended, depth writes off.
 *
 * Vertex layout (6 verts per segment, built by segmentsToRibbon):
 *   location 0  a_position  this endpoint (world space)
 *   location 1  a_other     the segment's other endpoint (world space)
 *   location 2  a_param     x = extrusion sign for THIS vertex along
 *                           perp(other − position) — the q end's perp is the
 *                           negation of the p end's, so the builder flips the
 *                           sign there to keep both ends on the same world
 *                           side; y = geometric side (±1), interpolated across
 *                           the ribbon width for the core/rim split.
 */

const VERT = /* glsl */ `#version 300 es
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec3 a_other;
layout(location = 2) in vec2 a_param;
uniform mat4 u_view;
uniform mat4 u_proj;
uniform float u_zBias;      // FRACTIONAL view-space pull toward the eye, so the
                            // intersection line wins the depth fight against
                            // BOTH surfaces it lies between (and any wire
                            // overlay). Fraction-of-distance, NOT a constant
                            // NDC shift — mirrors wirePass.
uniform vec2 u_viewport;    // canvas size in px
uniform float u_halfWidth;  // ribbon half-width in px
out float v_side;
vec4 clipOf(vec3 p) {
  vec4 viewPos = u_view * vec4(p, 1.0);
  viewPos.xyz *= (1.0 - u_zBias);          // radial: screen position unchanged
  vec4 c = u_proj * viewPos;
  c.z -= 2e-5 * c.w;                       // few-ULP epsilon for raster noise
  return c;
}
void main() {
  vec4 c0 = clipOf(a_position);
  vec4 c1 = clipOf(a_other);
  // Screen-space segment direction (guard degenerate/behind-eye projections).
  vec2 s0 = c0.xy / max(abs(c0.w), 1e-6) * u_viewport;
  vec2 s1 = c1.xy / max(abs(c1.w), 1e-6) * u_viewport;
  vec2 d = s1 - s0;
  vec2 n = dot(d, d) < 1e-12 ? vec2(1.0, 0.0) : normalize(vec2(-d.y, d.x));
  // px offset -> NDC (2/viewport) -> clip (×w, so the perspective divide lands
  // the ribbon at a constant pixel width at any depth).
  c0.xy += n * a_param.x * u_halfWidth * (2.0 / u_viewport) * c0.w;
  gl_Position = c0;
  v_side = a_param.y;
}`;

const FRAG = /* glsl */ `#version 300 es
precision highp float;
in float v_side;
uniform vec3 u_color;   // intersection line core color (from prefs)
out vec4 outColor;
void main() {
  // Solid core in u_color; the rim fades out through a TRANSLUCENT darkening
  // (~35% black at its strongest) so the line keeps contrast on surfaces close
  // to its own grey without reading as a second line. A full-opacity dark rim
  // read as "a grey line on top of a black line" (Ray, 2026-07-10); a plain
  // alpha fade washed out against the matcap mid-greys. Rim behavior stays.
  float t = abs(v_side);
  if (t < 0.5) {
    outColor = vec4(u_color, 1.0);
  } else {
    float a = 0.35 * (1.0 - smoothstep(0.5, 1.0, t));
    outColor = vec4(0.0, 0.0, 0.0, a);
  }
}`;

/**
 * Intersections overlay pass: the world-space ribbon VertexArray is owned +
 * cached by the Renderer (rebuilt only when geometry / transforms change); this
 * pass owns just the shader and per-frame uniforms. The caller draws the
 * ribbon VertexArray with gl.TRIANGLES.
 */
export class IntersectPass {
  readonly shader: Shader;

  constructor(gl: WebGL2RenderingContext) {
    this.shader = new Shader(gl, VERT, FRAG, 'mesh-intersect');
  }

  /** Bind per-frame state. `zBias` > 0 pulls the ribbon toward the camera;
   *  width/height = canvas size in px; `color` = the line core color (prefs). */
  begin(
    view: Mat4, proj: Mat4, zBias: number, width: number, height: number,
    color: Vec3 = new Vec3(0.45, 0.45, 0.48),
  ): void {
    this.shader.use();
    this.shader.setMat4('u_view', view);
    this.shader.setMat4('u_proj', proj);
    this.shader.setFloat('u_zBias', zBias);
    this.shader.setVec2('u_viewport', width, height);
    this.shader.setFloat('u_halfWidth', 1.6);
    this.shader.setVec3('u_color', color);
  }
}

/** Ribbon vertex stream as three planar arrays (VertexArray has no
 *  stride/offset support): positions, other-endpoints, params. */
export interface RibbonData {
  positions: Float32Array; // 3 / vert
  others: Float32Array;    // 3 / vert
  params: Float32Array;    // 2 / vert: [extrusion sign, geometric side]
}

/**
 * Expand flat intersection segments (6 floats each, from
 * meshIntersectionSegments) into the ribbon vertex stream: 6 verts per
 * segment. Quad corners pA(p,+1) pB(p,−1) qA(q,+1) qB(q,−1); the q end's
 * extrusion sign is flipped (its screen perp = −(p end's)) so A/B stay on the
 * same geometric side, while param y carries the un-flipped side for the
 * core/rim split. Triangles: pA·pB·qA and pB·qB·qA.
 */
export function segmentsToRibbon(segs: Float32Array | number[]): RibbonData {
  const nSeg = (segs.length / 6) | 0;
  const positions = new Float32Array(nSeg * 6 * 3);
  const others = new Float32Array(nSeg * 6 * 3);
  const params = new Float32Array(nSeg * 6 * 2);
  let v = 0;
  const put = (px: number, py: number, pz: number, ox: number, oy: number, oz: number,
    extrude: number, side: number): void => {
    positions[v * 3] = px; positions[v * 3 + 1] = py; positions[v * 3 + 2] = pz;
    others[v * 3] = ox; others[v * 3 + 1] = oy; others[v * 3 + 2] = oz;
    params[v * 2] = extrude; params[v * 2 + 1] = side;
    v++;
  };
  for (let s = 0; s < nSeg; s++) {
    const i = s * 6;
    const px = segs[i], py = segs[i + 1], pz = segs[i + 2];
    const qx = segs[i + 3], qy = segs[i + 4], qz = segs[i + 5];
    put(px, py, pz, qx, qy, qz, +1, +1);  // pA
    put(px, py, pz, qx, qy, qz, -1, -1);  // pB
    put(qx, qy, qz, px, py, pz, -1, +1);  // qA (extrusion flipped)
    put(px, py, pz, qx, qy, qz, -1, -1);  // pB
    put(qx, qy, qz, px, py, pz, +1, -1);  // qB (flipped)
    put(qx, qy, qz, px, py, pz, -1, +1);  // qA
  }
  return { positions, others, params };
}
