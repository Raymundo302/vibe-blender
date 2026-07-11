import { EditableMesh } from './EditableMesh';
import type { EditModeState } from '../scene/EditMode';

/**
 * Stable element orderings shared by the edit overlay and the element-picking
 * pass: pick ids are indexes into these arrays, so both sides MUST build them
 * from the same (mesh.version) snapshot. Map iteration order is insertion
 * order in JS, which our Maps preserve across clone/copyFrom.
 */
export interface ElementIndexMaps {
  vertIds: number[];
  edgeKeys: string[];
  faceIds: number[];
}

export function elementIndexMaps(mesh: EditableMesh): ElementIndexMaps {
  return {
    vertIds: [...mesh.verts.keys()],
    edgeKeys: [...mesh.edges().keys()],
    faceIds: [...mesh.faces.keys()],
  };
}

/** Flat arrays for the edit-mode cage: wire edges, vert points, selected-face fill. */
export interface EditOverlayData {
  vertPositions: Float32Array;
  vertColors: Float32Array;
  vertCount: number;
  edgePositions: Float32Array;
  edgeColors: Float32Array;
  /** Segment endpoints (2 per edge). */
  edgeVertexCount: number;
  /** Fan-triangulated corners of SELECTED faces only (translucent fill). */
  selFacePositions: Float32Array;
  selFaceVertexCount: number;
  /**
   * Face-center dots — ONE per face at its centroid, emitted only in face
   * element mode (empty / dotCount 0 in vert & edge modes). Orange when that
   * face is selected, vert-default grey otherwise. Rendered like vert points.
   */
  dotPositions: Float32Array;
  dotColors: Float32Array;
  dotCount: number;
}

const VERT_DEFAULT = [0.06, 0.06, 0.06] as const;
const EDGE_DEFAULT = [0.12, 0.12, 0.12] as const;
const SELECTED = [0.996, 0.451, 0.062] as const; // Blender selection orange

export function editOverlayData(mesh: EditableMesh, sel: EditModeState): EditOverlayData {
  sel.prune(mesh);

  const vertIds = [...mesh.verts.keys()];
  const vertPositions = new Float32Array(vertIds.length * 3);
  const vertColors = new Float32Array(vertIds.length * 3);
  vertIds.forEach((id, i) => {
    const co = mesh.verts.get(id)!.co;
    vertPositions.set([co.x, co.y, co.z], i * 3);
    vertColors.set(sel.isVertSelected(id) ? SELECTED : VERT_DEFAULT, i * 3);
  });

  const edges = [...mesh.edges().values()];
  const edgePositions = new Float32Array(edges.length * 6);
  const edgeColors = new Float32Array(edges.length * 6);
  edges.forEach((e, i) => {
    const a = mesh.verts.get(e.v0)!.co;
    const b = mesh.verts.get(e.v1)!.co;
    edgePositions.set([a.x, a.y, a.z, b.x, b.y, b.z], i * 6);
    // An edge draws orange when itself selected (edge mode) or when both
    // endpoints are (vert mode) — matches Blender's visual feedback.
    const hot =
      sel.edges.has(e.key) ||
      (sel.elementMode === 'vert' && sel.isVertSelected(e.v0) && sel.isVertSelected(e.v1));
    const c = hot ? SELECTED : EDGE_DEFAULT;
    edgeColors.set([...c, ...c], i * 6);
  });

  let triCount = 0;
  for (const fid of sel.faces) {
    const f = mesh.faces.get(fid);
    if (f) triCount += f.verts.length - 2;
  }
  const selFacePositions = new Float32Array(triCount * 9);
  let p = 0;
  for (const fid of sel.faces) {
    const f = mesh.faces.get(fid);
    if (!f) continue;
    const vs = f.verts;
    for (let i = 1; i < vs.length - 1; i++) {
      for (const vid of [vs[0], vs[i], vs[i + 1]]) {
        const co = mesh.verts.get(vid)!.co;
        selFacePositions[p++] = co.x;
        selFacePositions[p++] = co.y;
        selFacePositions[p++] = co.z;
      }
    }
  }

  // Face-center dots — one per face at its centroid, face element mode only.
  let dotPositions = new Float32Array(0);
  let dotColors = new Float32Array(0);
  let dotCount = 0;
  if (sel.elementMode === 'face') {
    const faceIds = [...mesh.faces.keys()];
    dotCount = faceIds.length;
    dotPositions = new Float32Array(dotCount * 3);
    dotColors = new Float32Array(dotCount * 3);
    faceIds.forEach((id, i) => {
      const f = mesh.faces.get(id)!;
      let cx = 0, cy = 0, cz = 0;
      for (const vid of f.verts) {
        const co = mesh.verts.get(vid)!.co;
        cx += co.x; cy += co.y; cz += co.z;
      }
      const n = f.verts.length;
      dotPositions.set([cx / n, cy / n, cz / n], i * 3);
      dotColors.set(sel.isFaceSelected(id) ? SELECTED : VERT_DEFAULT, i * 3);
    });
  }

  return {
    vertPositions,
    vertColors,
    vertCount: vertIds.length,
    edgePositions,
    edgeColors,
    edgeVertexCount: edges.length * 2,
    selFacePositions,
    selFaceVertexCount: triCount * 3,
    dotPositions,
    dotColors,
    dotCount,
  };
}
