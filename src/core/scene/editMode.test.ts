import { describe, it, expect } from 'vitest';
import { Scene } from './Scene';
import { EditModeState } from './EditMode';
import { makeCube } from '../mesh/primitives';
import { EditableMesh } from '../mesh/EditableMesh';
import { MeshEditCommand } from '../undo/meshCommands';
import { UndoStack } from '../undo/UndoStack';
import { editOverlayData, elementIndexMaps } from '../mesh/editOverlayData';

function cubeScene() {
  const scene = new Scene();
  const obj = scene.add('Cube', makeCube());
  scene.selectOnly(obj.id);
  return { scene, obj };
}

describe('Scene edit mode', () => {
  it('enters on the active object and exits cleanly', () => {
    const { scene, obj } = cubeScene();
    expect(scene.mode).toBe('object');
    expect(scene.enterEditMode()).toBe(true);
    expect(scene.mode).toBe('edit');
    expect(scene.editObject).toBe(obj);
    scene.exitEditMode();
    expect(scene.editMode).toBeNull();
  });

  it('refuses to enter with no active object', () => {
    const scene = new Scene();
    expect(scene.enterEditMode()).toBe(false);
  });

  it('deleting the edited object exits edit mode', () => {
    const { scene, obj } = cubeScene();
    scene.enterEditMode();
    scene.remove(obj.id);
    expect(scene.editMode).toBeNull();
  });
});

describe('EditModeState', () => {
  it('selectedVertIds expands edges and faces to their verts', () => {
    const mesh = makeCube();
    const sel = new EditModeState(0);

    sel.elementMode = 'edge';
    sel.edges.add(EditableMesh.edgeKey(0, 1));
    expect([...sel.selectedVertIds(mesh)].sort()).toEqual([0, 1]);

    sel.elementMode = 'face';
    sel.edges.clear();
    const faceId = [...mesh.faces.keys()][0];
    sel.faces.add(faceId);
    expect(sel.selectedVertIds(mesh).size).toBe(4);
  });

  it('mode switch derives selection Blender-style', () => {
    const mesh = makeCube();
    const sel = new EditModeState(0);
    const face = [...mesh.faces.values()][0];
    // select all 4 verts of one face in vert mode
    for (const v of face.verts) sel.verts.add(v);

    sel.setElementMode('edge', mesh);
    expect(sel.edges.size).toBe(4); // the face's 4 boundary edges

    sel.setElementMode('face', mesh);
    expect([...sel.faces]).toEqual([face.id]);

    sel.setElementMode('vert', mesh);
    expect(sel.verts.size).toBe(4);
  });

  it('selectAll / clearSelection / prune', () => {
    const mesh = makeCube();
    const sel = new EditModeState(0);
    sel.selectAll(mesh);
    expect(sel.verts.size).toBe(8);
    sel.elementMode = 'face';
    sel.selectAll(mesh);
    expect(sel.faces.size).toBe(6);

    mesh.deleteFaces([...sel.faces].slice(0, 2));
    sel.prune(mesh);
    expect(sel.faces.size).toBe(4);
  });
});

describe('EditableMesh topology ops', () => {
  it('deleteFaces keeps verts as floating points', () => {
    const mesh = makeCube();
    mesh.deleteFaces([...mesh.faces.keys()]);
    expect(mesh.faces.size).toBe(0);
    expect(mesh.verts.size).toBe(8);
    expect(mesh.edges().size).toBe(0);
  });

  it('deleteVerts cascades to faces using them', () => {
    const mesh = makeCube();
    mesh.deleteVerts([0]);
    expect(mesh.verts.size).toBe(7);
    expect(mesh.faces.size).toBe(3); // vert 0 touches 3 cube faces
  });

  it('deleteEdges cascades to bordering faces, keeps verts', () => {
    const mesh = makeCube();
    mesh.deleteEdges([EditableMesh.edgeKey(0, 1)]);
    expect(mesh.faces.size).toBe(4); // an edge borders 2 faces
    expect(mesh.verts.size).toBe(8);
  });

  it('mergeVertsAtCenter collapses an edge and degenerate faces', () => {
    const mesh = makeCube();
    const kept = mesh.mergeVertsAtCenter([0, 1]);
    expect(kept).toBe(0);
    expect(mesh.verts.size).toBe(7);
    // the 2 faces sharing edge 0-1 become triangles; none disappear
    expect(mesh.faces.size).toBe(6);
    const co = mesh.verts.get(0)!.co;
    expect(co.y).toBe(-1);
    expect(co.x).toBe(0); // midpoint of (-1,..) and (1,..)
  });
});

describe('MeshEditCommand', () => {
  it('snapshots around a mutation and round-trips undo/redo', () => {
    const mesh = makeCube();
    const undo = new UndoStack();
    const cmd = MeshEditCommand.capture('Delete Faces', mesh, () => {
      mesh.deleteFaces([[...mesh.faces.keys()][0]]);
    });
    undo.push(cmd);
    expect(mesh.faces.size).toBe(5);
    undo.undo();
    expect(mesh.faces.size).toBe(6);
    undo.redo();
    expect(mesh.faces.size).toBe(5);
  });
});

describe('editOverlayData', () => {
  it('builds arrays sized to the cube and colors selected elements', () => {
    const mesh = makeCube();
    const sel = new EditModeState(0);
    sel.verts.add(0);
    sel.touch();
    const data = editOverlayData(mesh, sel);
    expect(data.vertCount).toBe(8);
    expect(data.edgeVertexCount).toBe(24);
    expect(data.selFaceVertexCount).toBe(0);
    // vert 0 is first in insertion order → its color is selection orange
    expect(data.vertColors[0]).toBeCloseTo(0.996, 2);
    // an unselected vert stays dark
    expect(data.vertColors[3]).toBeLessThan(0.2);
  });

  it('fills selected faces and prunes dead elements', () => {
    const mesh = makeCube();
    const sel = new EditModeState(0);
    sel.elementMode = 'face';
    const fid = [...mesh.faces.keys()][0];
    sel.faces.add(fid);
    expect(editOverlayData(mesh, sel).selFaceVertexCount).toBe(6); // quad = 2 tris

    mesh.deleteFaces([fid]);
    expect(editOverlayData(mesh, sel).selFaceVertexCount).toBe(0);
    expect(sel.faces.size).toBe(0); // pruned
  });

  it('elementIndexMaps ordering is stable across clone/copyFrom', () => {
    const mesh = makeCube();
    const before = elementIndexMaps(mesh);
    const snapshot = mesh.clone();
    mesh.deleteFaces([before.faceIds[0]]);
    mesh.copyFrom(snapshot);
    const after = elementIndexMaps(mesh);
    expect(after).toEqual(before);
  });
});
