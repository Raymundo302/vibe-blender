import { EditableMesh } from './EditableMesh';

/** Blender's default cube: 2 units on a side, centered at origin. */
export function makeCube(halfExtent = 1): EditableMesh {
  const h = halfExtent;
  return EditableMesh.fromData(
    [
      [-h, -h, -h], [h, -h, -h], [h, h, -h], [-h, h, -h],
      [-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h],
    ],
    [
      [4, 5, 6, 7], // +Z
      [1, 0, 3, 2], // -Z
      [5, 1, 2, 6], // +X
      [0, 4, 7, 3], // -X
      [7, 6, 2, 3], // +Y
      [0, 1, 5, 4], // -Y
    ],
  );
}
