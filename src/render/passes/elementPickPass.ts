import { Shader } from '../gl/Shader';
import { VertexArray } from '../gl/VertexArray';
import { Framebuffer } from '../gl/Framebuffer';
import { encodeId } from './pickingPass';
import { elementIndexMaps, type ElementIndexMaps } from '../../core/mesh/editOverlayData';
import type { EditableMesh } from '../../core/mesh/EditableMesh';
import type { ElementMode } from '../../core/scene/EditMode';
import type { Mat4 } from '../../core/math/mat4';

/**
 * Element color-ID picking (architecture decision A3, mesh side): renders the
 * edit object's verts/edges/faces in unique flat colors to an offscreen buffer
 * so a pixel read under the cursor identifies the clicked element.
 *
 * Pick-id namespaces (see tasks/P2-CONVENTIONS.md): the encoded id is
 * `<BASE> + idx`, where `idx` indexes into `elementIndexMaps(mesh)`. The bases
 * are spaced far apart so decode can recover the element kind from the id alone,
 * and all stay below `GIZMO_PICK_BASE` (0xf00000). id 0 = background.
 */
export const VERT_PICK_BASE = 0x000001;
export const EDGE_PICK_BASE = 0x100000;
export const FACE_PICK_BASE = 0x200000;

export type ElementPickResult =
  | { kind: 'vert'; id: number }
  | { kind: 'edge'; key: string }
  | { kind: 'face'; id: number };

/**
 * Decode a raw pick id into an element handle using the SAME index maps the
 * pass was built from. Pure — unit-tested independently of GL.
 */
export function decodePick(id: number, maps: ElementIndexMaps): ElementPickResult | null {
  if (id >= FACE_PICK_BASE) {
    const fid = maps.faceIds[id - FACE_PICK_BASE];
    return fid === undefined ? null : { kind: 'face', id: fid };
  }
  if (id >= EDGE_PICK_BASE) {
    const key = maps.edgeKeys[id - EDGE_PICK_BASE];
    return key === undefined ? null : { kind: 'edge', key };
  }
  if (id >= VERT_PICK_BASE) {
    const vid = maps.vertIds[id - VERT_PICK_BASE];
    return vid === undefined ? null : { kind: 'vert', id: vid };
  }
  return null;
}

/**
 * From a w×h RGBA region, return the non-zero pick id nearest the center
 * (cx, cy) by Chebyshev distance; 0 if the region is all background. Pure —
 * gives the click a few pixels of tolerance so tiny verts/edges are grabbable.
 */
export function closestNonZeroId(
  region: Uint8Array,
  w: number,
  h: number,
  cx: number,
  cy: number,
): number {
  let best = 0;
  let bestDist = Infinity;
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const i = (r * w + c) * 4;
      const id = region[i] | (region[i + 1] << 8) | (region[i + 2] << 16);
      if (id === 0) continue;
      const d = Math.max(Math.abs(c - cx), Math.abs(r - cy));
      if (d < bestDist) {
        bestDist = d;
        best = id;
      }
    }
  }
  return best;
}

const VERT = /* glsl */ `#version 300 es
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec3 a_color;
uniform mat4 u_mvp;
uniform float u_depthBias; // pull toward the camera so points/lines beat coplanar faces
uniform float u_pointSize;
out vec3 v_color;
void main() {
  v_color = a_color;
  gl_Position = u_mvp * vec4(a_position, 1.0);
  gl_Position.z -= u_depthBias * gl_Position.w;
  gl_PointSize = u_pointSize;
}`;

const FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec3 v_color;
out vec4 outColor;
void main() { outColor = vec4(v_color, 1.0); }`;

export class ElementPickPass {
  private readonly shader: Shader;
  private readonly fbo: Framebuffer;
  private cacheVersion = -1;
  private cacheMesh: EditableMesh | null = null;
  private faceVa: VertexArray | null = null;
  private occluderVa: VertexArray | null = null;
  private edgeVa: VertexArray | null = null;
  private vertVa: VertexArray | null = null;

  constructor(private readonly gl: WebGL2RenderingContext, width: number, height: number) {
    this.shader = new Shader(gl, VERT, FRAG, 'element-pick');
    this.fbo = new Framebuffer(gl, width, height, true);
  }

  resize(width: number, height: number): void {
    this.fbo.resize(width, height);
  }

  /** Build the id geometry, cached on (mesh identity, mesh.version). */
  private rebuild(mesh: EditableMesh): void {
    if (this.cacheMesh === mesh && this.cacheVersion === mesh.version) return;
    this.cacheVersion = mesh.version;
    this.cacheMesh = mesh;
    this.faceVa?.dispose();
    this.occluderVa?.dispose();
    this.edgeVa?.dispose();
    this.vertVa?.dispose();

    const maps = elementIndexMaps(mesh);
    const gl = this.gl;

    // Faces: fan-triangulated, one flat color per face (+ an all-black occluder
    // copy so front faces can hide verts/edges behind them).
    let triCount = 0;
    for (const fid of maps.faceIds) triCount += mesh.faces.get(fid)!.verts.length - 2;
    const facePos = new Float32Array(triCount * 9);
    const faceCol = new Float32Array(triCount * 9);
    const occCol = new Float32Array(triCount * 9); // zeros == id 0
    let p = 0;
    maps.faceIds.forEach((fid, idx) => {
      const vs = mesh.faces.get(fid)!.verts;
      const [r, g, b] = encodeId(FACE_PICK_BASE + idx);
      for (let i = 1; i < vs.length - 1; i++) {
        for (const vid of [vs[0], vs[i], vs[i + 1]]) {
          const co = mesh.verts.get(vid)!.co;
          facePos[p] = co.x; facePos[p + 1] = co.y; facePos[p + 2] = co.z;
          faceCol[p] = r; faceCol[p + 1] = g; faceCol[p + 2] = b;
          p += 3;
        }
      }
    });
    this.faceVa = new VertexArray(gl, [
      { location: 0, size: 3, data: facePos },
      { location: 1, size: 3, data: faceCol },
    ]);
    this.occluderVa = new VertexArray(gl, [
      { location: 0, size: 3, data: facePos },
      { location: 1, size: 3, data: occCol },
    ]);

    // Edges: one flat color per edge segment.
    const edges = mesh.edges();
    const edgePos = new Float32Array(maps.edgeKeys.length * 6);
    const edgeCol = new Float32Array(maps.edgeKeys.length * 6);
    maps.edgeKeys.forEach((key, idx) => {
      const e = edges.get(key)!;
      const a = mesh.verts.get(e.v0)!.co;
      const b = mesh.verts.get(e.v1)!.co;
      const [r, g, bl] = encodeId(EDGE_PICK_BASE + idx);
      edgePos.set([a.x, a.y, a.z, b.x, b.y, b.z], idx * 6);
      edgeCol.set([r, g, bl, r, g, bl], idx * 6);
    });
    this.edgeVa = new VertexArray(gl, [
      { location: 0, size: 3, data: edgePos },
      { location: 1, size: 3, data: edgeCol },
    ]);

    // Verts: one point per vert.
    const vertPos = new Float32Array(maps.vertIds.length * 3);
    const vertCol = new Float32Array(maps.vertIds.length * 3);
    maps.vertIds.forEach((vid, idx) => {
      const co = mesh.verts.get(vid)!.co;
      const [r, g, b] = encodeId(VERT_PICK_BASE + idx);
      vertPos.set([co.x, co.y, co.z], idx * 3);
      vertCol.set([r, g, b], idx * 3);
    });
    this.vertVa = new VertexArray(gl, [
      { location: 0, size: 3, data: vertPos },
      { location: 1, size: 3, data: vertCol },
    ]);
  }

  /**
   * Render the id buffer for `mode`. Blender semantics: only the current element
   * kind is clickable, and front elements win. Leaves the id FBO unbound; the
   * caller reads a region and restores the main viewport.
   */
  render(mvp: Mat4, mesh: EditableMesh, mode: ElementMode): void {
    const gl = this.gl;
    this.rebuild(mesh);
    this.fbo.bind();
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    this.shader.use();
    this.shader.setMat4('u_mvp', mvp);
    this.shader.setFloat('u_pointSize', 1);

    if (mode === 'face') {
      this.shader.setFloat('u_depthBias', 0);
      this.faceVa!.draw(gl.TRIANGLES);
    } else {
      // Opaque black occluders first so hidden verts/edges read as background.
      this.shader.setFloat('u_depthBias', 0);
      this.occluderVa!.draw(gl.TRIANGLES);
      if (mode === 'edge') {
        this.shader.setFloat('u_depthBias', 0.001);
        this.edgeVa!.draw(gl.LINES);
      } else {
        this.shader.setFloat('u_depthBias', 0.0015);
        this.shader.setFloat('u_pointSize', 10);
        this.vertVa!.draw(gl.POINTS);
      }
    }
    this.fbo.unbind();
  }

  get width(): number { return this.fbo.width; }
  get height(): number { return this.fbo.height; }

  /** Read a w×h RGBA block from the id buffer (GL bottom-up, like readPixel). */
  readRegion(x: number, y: number, w: number, h: number): Uint8Array {
    return this.fbo.readRegion(x, y, w, h);
  }
}
