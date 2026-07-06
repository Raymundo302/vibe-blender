import { Vec3 } from '../math/vec3';
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

/**
 * A single quad in the XZ plane (normal +Y), centered at origin.
 * Blender's plane is 2 units across by default.
 */
export function makePlane(size = 2): EditableMesh {
  const h = size / 2;
  // Order chosen so Newell's normal comes out +Y (CCW seen from above).
  return EditableMesh.fromData(
    [
      [-h, 0, -h], // 0
      [h, 0, -h],  // 1
      [h, 0, h],   // 2
      [-h, 0, h],  // 3
    ],
    [[0, 3, 2, 1]],
  );
}

/**
 * UV sphere: poles on the Y axis. Latitude is split into `rings` bands
 * (giving `rings - 1` interior circles + 2 poles) and longitude into
 * `segments`. Interior bands are quads; the two polar bands are triangle fans.
 */
export function makeUvSphere(radius = 1, segments = 32, rings = 16): EditableMesh {
  const positions: [number, number, number][] = [];
  const faces: number[][] = [];

  // North pole (index 0).
  const north = positions.length;
  positions.push([0, radius, 0]);

  // Interior latitude circles, i = 1 .. rings-1 (phi increasing = y decreasing).
  const ringBase = (i: number) => 1 + (i - 1) * segments;
  for (let i = 1; i < rings; i++) {
    const phi = (Math.PI * i) / rings;
    const y = Math.cos(phi) * radius;
    const r = Math.sin(phi) * radius;
    for (let j = 0; j < segments; j++) {
      const theta = (2 * Math.PI * j) / segments;
      positions.push([r * Math.cos(theta), y, r * Math.sin(theta)]);
    }
  }

  // South pole (last index).
  const south = positions.length;
  positions.push([0, -radius, 0]);

  // Top fan: pole + first interior ring.
  for (let j = 0; j < segments; j++) {
    const a = ringBase(1) + j;
    const b = ringBase(1) + ((j + 1) % segments);
    faces.push([north, b, a]);
  }

  // Middle quad bands between ring i (upper) and ring i+1 (lower).
  for (let i = 1; i < rings - 1; i++) {
    for (let j = 0; j < segments; j++) {
      const j1 = (j + 1) % segments;
      const top = ringBase(i);
      const bot = ringBase(i + 1);
      faces.push([top + j, top + j1, bot + j1, bot + j]);
    }
  }

  // Bottom fan: last interior ring + south pole.
  for (let j = 0; j < segments; j++) {
    const a = ringBase(rings - 1) + j;
    const b = ringBase(rings - 1) + ((j + 1) % segments);
    faces.push([a, b, south]);
  }

  return EditableMesh.fromData(positions, faces);
}

/**
 * Cylinder with its axis along Y. `depth` is the full height (top at +depth/2,
 * bottom at -depth/2). Sides are quads; each cap is a single n-gon face
 * (EditableMesh supports polygon faces).
 */
export function makeCylinder(radius = 1, depth = 2, segments = 32): EditableMesh {
  const positions: [number, number, number][] = [];
  const faces: number[][] = [];
  const hy = depth / 2;

  // Top ring [0 .. segments), then bottom ring [segments .. 2*segments).
  for (let j = 0; j < segments; j++) {
    const theta = (2 * Math.PI * j) / segments;
    positions.push([radius * Math.cos(theta), hy, radius * Math.sin(theta)]);
  }
  for (let j = 0; j < segments; j++) {
    const theta = (2 * Math.PI * j) / segments;
    positions.push([radius * Math.cos(theta), -hy, radius * Math.sin(theta)]);
  }

  const top = (j: number) => j;
  const bot = (j: number) => segments + j;

  // Side quads.
  for (let j = 0; j < segments; j++) {
    const j1 = (j + 1) % segments;
    faces.push([top(j), top(j1), bot(j1), bot(j)]);
  }

  // Top cap (+Y): reversed ring order so the normal points up.
  const topCap: number[] = [];
  for (let j = segments - 1; j >= 0; j--) topCap.push(top(j));
  faces.push(topCap);

  // Bottom cap (-Y): forward ring order so the normal points down.
  const botCap: number[] = [];
  for (let j = 0; j < segments; j++) botCap.push(bot(j));
  faces.push(botCap);

  return EditableMesh.fromData(positions, faces);
}

/**
 * Torus lying flat in the XZ plane (hole up the Y axis). `majorRadius` is the
 * ring radius, `minorRadius` the tube radius. All faces are quads.
 */
export function makeTorus(
  majorRadius = 1,
  minorRadius = 0.25,
  majorSegments = 48,
  minorSegments = 12,
): EditableMesh {
  const positions: [number, number, number][] = [];
  const faces: number[][] = [];

  for (let i = 0; i < majorSegments; i++) {
    const u = (2 * Math.PI * i) / majorSegments;
    const cu = Math.cos(u), su = Math.sin(u);
    for (let j = 0; j < minorSegments; j++) {
      const v = (2 * Math.PI * j) / minorSegments;
      const cv = Math.cos(v), sv = Math.sin(v);
      const r = majorRadius + minorRadius * cv;
      positions.push([r * cu, minorRadius * sv, r * su]);
    }
  }

  const idx = (i: number, j: number) =>
    (i % majorSegments) * minorSegments + (j % minorSegments);

  for (let i = 0; i < majorSegments; i++) {
    for (let j = 0; j < minorSegments; j++) {
      faces.push([idx(i, j), idx(i, j + 1), idx(i + 1, j + 1), idx(i + 1, j)]);
    }
  }

  return EditableMesh.fromData(positions, faces);
}

/**
 * Icosphere: an icosahedron subdivided 4-way `subdivisions` times, with every
 * vertex projected onto the sphere. Subdivision midpoints are shared, so there
 * are no duplicate verts. At subdivisions = n: `20 * 4^n` faces, `10 * 4^n + 2`
 * verts.
 */
export function makeIcoSphere(radius = 1, subdivisions = 2): EditableMesh {
  const t = (1 + Math.sqrt(5)) / 2;

  // Base icosahedron, projected onto the unit sphere.
  const verts: Vec3[] = [
    new Vec3(-1, t, 0), new Vec3(1, t, 0), new Vec3(-1, -t, 0), new Vec3(1, -t, 0),
    new Vec3(0, -1, t), new Vec3(0, 1, t), new Vec3(0, -1, -t), new Vec3(0, 1, -t),
    new Vec3(t, 0, -1), new Vec3(t, 0, 1), new Vec3(-t, 0, -1), new Vec3(-t, 0, 1),
  ].map((v) => v.normalize());

  let faces: [number, number, number][] = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];

  for (let s = 0; s < subdivisions; s++) {
    const midCache = new Map<string, number>();
    const midpoint = (a: number, b: number): number => {
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      const cached = midCache.get(key);
      if (cached !== undefined) return cached;
      const mid = verts[a].add(verts[b]).scale(0.5).normalize();
      const id = verts.length;
      verts.push(mid);
      midCache.set(key, id);
      return id;
    };

    const next: [number, number, number][] = [];
    for (const [a, b, c] of faces) {
      const ab = midpoint(a, b);
      const bc = midpoint(b, c);
      const ca = midpoint(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = next;
  }

  const positions = verts.map((v) => v.scale(radius).toArray());
  return EditableMesh.fromData(positions, faces.map((f) => [...f]));
}

/** A named primitive factory for the Add menu (consumed by P1-6). */
export interface PrimitiveDef {
  name: string;
  make: () => EditableMesh;
}

/** Registry the Add menu consumes, in Blender's Add > Mesh order. */
export const PRIMITIVES: PrimitiveDef[] = [
  { name: 'Plane', make: () => makePlane() },
  { name: 'Cube', make: () => makeCube() },
  { name: 'UV Sphere', make: () => makeUvSphere() },
  { name: 'Ico Sphere', make: () => makeIcoSphere() },
  { name: 'Cylinder', make: () => makeCylinder() },
  { name: 'Torus', make: () => makeTorus() },
];
