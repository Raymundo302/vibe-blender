/**
 * Shared screen-space RIBBON machinery for anti-aliased, proximity-thickened
 * wire lines (UR6-1). Both the mesh wirePass and the edit-cage editOverlayPass
 * expand their line segments into two-triangle ribbons whose PIXEL width scales
 * with view proximity and whose outer ~1px fades out for anti-aliasing — the
 * same technique intersectPass proved for the Intersections overlay (a 1px
 * gl.LINES wire is jagged and lineWidth is capped at 1 on ANGLE/core profiles).
 *
 * Each source segment (2 endpoints = 6 floats) becomes 6 ribbon verts
 * (2 triangles), extruded perpendicular to the segment's screen direction in
 * the vertex shader so the width stays constant in PIXELS at any depth.
 */

// --- Proximity width constants (ONE place; expect eyes-on tuning by the
// architect). Per-endpoint pixel HALF-width =
//   clamp(BASE_PX * REF_DIST / viewDist, MIN_PX, MAX_PX).
// REF_DIST is the camera's orbit distance, so at the orbit pivot the width is
// ~BASE_PX and the look stays stable as you zoom; edges nearer the eye than the
// pivot get fatter, farther ones thinner. Half-widths → full width is 2×. ------
export const WIRE_BASE_PX = 1.1;
export const WIRE_MIN_PX = 0.6;
export const WIRE_MAX_PX = 3.5;

/**
 * GLSL chunk: the width constants + the ribbon expansion helper, shared verbatim
 * by every ribbon vertex shader. `wireExpand` takes the two endpoints' clip
 * positions (c0 = THIS vertex's endpoint), THIS endpoint's view-space distance,
 * the camera orbit distance, the viewport in px, and the ribbon side sign (±1);
 * it offsets c0 sideways by the proximity half-width and returns the new clip
 * position, writing the half-width (px) to `hp` for the fragment's 1px AA.
 */
export const RIBBON_EXPAND_GLSL = /* glsl */ `
const float WIRE_BASE_PX = ${WIRE_BASE_PX};
const float WIRE_MIN_PX  = ${WIRE_MIN_PX};
const float WIRE_MAX_PX  = ${WIRE_MAX_PX};
float wireHalfPx(float viewDist, float refDist) {
  return clamp(WIRE_BASE_PX * refDist / max(viewDist, 1e-4), WIRE_MIN_PX, WIRE_MAX_PX);
}
vec4 wireExpand(vec4 c0, vec4 c1, float viewDist, float refDist,
                vec2 viewport, float extrudeSign, out float hp) {
  // Screen-space segment direction (guard degenerate/behind-eye projections).
  vec2 s0 = c0.xy / max(abs(c0.w), 1e-6) * viewport;
  vec2 s1 = c1.xy / max(abs(c1.w), 1e-6) * viewport;
  vec2 d = s1 - s0;
  vec2 n = dot(d, d) < 1e-12 ? vec2(1.0, 0.0) : normalize(vec2(-d.y, d.x));
  hp = wireHalfPx(viewDist, refDist);
  // px offset -> NDC (2/viewport) -> clip (×w, so the perspective divide lands
  // the ribbon at a constant pixel width at any depth).
  c0.xy += n * extrudeSign * hp * (2.0 / viewport) * c0.w;
  return c0;
}
`;

/**
 * GLSL: shared anti-aliased fragment. `v_side` runs -1..1 across the width,
 * `v_halfPx` is the ribbon half-width in px; the outer ~1px fades to 0 alpha
 * (soft edge instead of a 1-bit staircase — the intersectPass rim technique).
 * Final color = u_color * v_color (uniform tint × per-vertex color) so the mesh
 * wire (uniform dark, white per-vert) and the edit cage (white uniform,
 * per-endpoint orange/grey) share ONE fragment program. Blended, caller decides
 * depth-write.
 */
export const RIBBON_FRAG = /* glsl */ `#version 300 es
precision highp float;
in float v_side;
in float v_halfPx;
in vec3 v_color;
uniform vec3 u_color;
out vec4 outColor;
void main() {
  float edgeDistPx = (1.0 - abs(v_side)) * v_halfPx; // px in from the outer edge
  float alpha = clamp(edgeDistPx, 0.0, 1.0);         // ~1px soft AA falloff
  if (alpha <= 0.0) discard;
  outColor = vec4(u_color * v_color, alpha);
}
`;

export interface WireRibbonData {
  positions: Float32Array; // 3 / vert (this endpoint)
  others: Float32Array;    // 3 / vert (the segment's other endpoint)
  params: Float32Array;    // 2 / vert  [extrusion sign, geometric side]
  faceN1: Float32Array;    // 3 / vert  (hideBack cull; default 0,0,1)
  faceN2: Float32Array;    // 3 / vert
  colors: Float32Array;    // 3 / vert  (per-endpoint tint; default white)
}

/**
 * Expand flat line SEGMENTS (2 endpoints = 6 floats each) into the ribbon vertex
 * stream (6 verts / segment). Optional per-ENDPOINT face normals (for the mesh
 * wire's hideBack cull) and per-endpoint colors (edit-cage selection) are laid
 * out PARALLEL to `positions`: 6 floats (2×vec3) per segment. Missing arrays
 * default to (0,0,1) normals and white color.
 *
 * Quad corners pA(p,+1) pB(p,−1) qA(q,+1) qB(q,−1); the q end's extrusion sign
 * is flipped (its screen perp = −(p end's)) so A/B stay on the same geometric
 * side, while param.y carries the un-flipped side for the core/rim split.
 * Triangles: pA·pB·qA and pB·qB·qA (mirrors intersectPass.segmentsToRibbon).
 */
export function buildWireRibbon(
  segs: Float32Array | number[],
  opts: { faceN1?: Float32Array; faceN2?: Float32Array; colors?: Float32Array } = {},
): WireRibbonData {
  const nSeg = (segs.length / 6) | 0;
  const positions = new Float32Array(nSeg * 6 * 3);
  const others = new Float32Array(nSeg * 6 * 3);
  const params = new Float32Array(nSeg * 6 * 2);
  const faceN1 = new Float32Array(nSeg * 6 * 3);
  const faceN2 = new Float32Array(nSeg * 6 * 3);
  const colors = new Float32Array(nSeg * 6 * 3);
  let v = 0;
  // `end` = which endpoint of the segment this vert sits at (0 = p, 1 = q); it
  // selects the per-endpoint normal/color from the parallel input arrays.
  const put = (
    px: number, py: number, pz: number,
    ox: number, oy: number, oz: number,
    extrude: number, side: number,
    seg: number, end: number,
  ): void => {
    positions[v * 3] = px; positions[v * 3 + 1] = py; positions[v * 3 + 2] = pz;
    others[v * 3] = ox; others[v * 3 + 1] = oy; others[v * 3 + 2] = oz;
    params[v * 2] = extrude; params[v * 2 + 1] = side;
    const src = seg * 6 + end * 3; // parallel-array offset of this endpoint
    faceN1[v * 3] = opts.faceN1 ? opts.faceN1[src] : 0;
    faceN1[v * 3 + 1] = opts.faceN1 ? opts.faceN1[src + 1] : 0;
    faceN1[v * 3 + 2] = opts.faceN1 ? opts.faceN1[src + 2] : 1;
    faceN2[v * 3] = opts.faceN2 ? opts.faceN2[src] : 0;
    faceN2[v * 3 + 1] = opts.faceN2 ? opts.faceN2[src + 1] : 0;
    faceN2[v * 3 + 2] = opts.faceN2 ? opts.faceN2[src + 2] : 1;
    colors[v * 3] = opts.colors ? opts.colors[src] : 1;
    colors[v * 3 + 1] = opts.colors ? opts.colors[src + 1] : 1;
    colors[v * 3 + 2] = opts.colors ? opts.colors[src + 2] : 1;
    v++;
  };
  for (let s = 0; s < nSeg; s++) {
    const i = s * 6;
    const px = segs[i], py = segs[i + 1], pz = segs[i + 2];
    const qx = segs[i + 3], qy = segs[i + 4], qz = segs[i + 5];
    put(px, py, pz, qx, qy, qz, +1, +1, s, 0);  // pA
    put(px, py, pz, qx, qy, qz, -1, -1, s, 0);  // pB
    put(qx, qy, qz, px, py, pz, -1, +1, s, 1);  // qA (extrusion flipped)
    put(px, py, pz, qx, qy, qz, -1, -1, s, 0);  // pB
    put(qx, qy, qz, px, py, pz, +1, -1, s, 1);  // qB (flipped)
    put(qx, qy, qz, px, py, pz, -1, +1, s, 1);  // qA
  }
  return { positions, others, params, faceN1, faceN2, colors };
}
