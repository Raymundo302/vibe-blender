/**
 * Polygon-with-holes triangulation (pure).
 *
 * This is the classic pipeline: bridge each hole into the outer boundary
 * through a mutually-visible vertex pair (the hole's max-x vertex raycast to
 * the right, resolved against reflex vertices in the way), then ear-clip the
 * resulting single polygon. Because two holes can bridge to the same outer
 * corner (a weakly-simple triple point — e.g. the two counters of "8"), the
 * ear clipper works over a doubly-linked node list keyed by identity, not by
 * coordinates, which is the mapbox/earcut approach and robust to those cases.
 *
 * Ported from mapbox/earcut (ISC License) and adapted to this project's
 * outer + holes → {vertices, triangles} shape. Only the 2D, no-z-curve path is
 * kept.
 */

export type Pt = [number, number];

export interface Triangulation {
  vertices: Pt[];
  triangles: [number, number, number][];
}

interface Node {
  i: number;       // vertex index in the coordinate array
  x: number;
  y: number;
  prev: Node;
  next: Node;
  z: number;       // z-order curve value (or 0)
  prevZ: Node | null;
  nextZ: Node | null;
  steiner: boolean;
}

/**
 * Triangulate a polygon with holes. `outer` and each `hole` are closed loops
 * (first point not repeated). Any winding is accepted.
 */
export function triangulate(outer: Pt[], holes: Pt[][] = []): Triangulation {
  if (outer.length < 3) return { vertices: outer.slice(), triangles: [] };

  const vertices: Pt[] = [];
  const data: number[] = [];
  for (const p of outer) { data.push(p[0], p[1]); vertices.push([p[0], p[1]]); }
  const holeIndices: number[] = [];
  for (const h of holes) {
    if (h.length < 3) continue;
    holeIndices.push(data.length / 2);
    for (const p of h) { data.push(p[0], p[1]); vertices.push([p[0], p[1]]); }
  }

  const flat = earcut(data, holeIndices);
  const triangles: [number, number, number][] = [];
  for (let i = 0; i < flat.length; i += 3) triangles.push([flat[i], flat[i + 1], flat[i + 2]]);
  return { vertices, triangles };
}

// ─────────────────────────── earcut core ───────────────────────────────────

function earcut(data: number[], holeIndices: number[]): number[] {
  const dim = 2;
  const hasHoles = holeIndices.length > 0;
  const outerLen = hasHoles ? holeIndices[0] * dim : data.length;
  let outerNode = linkedList(data, 0, outerLen, dim, true);
  const triangles: number[] = [];
  if (!outerNode || outerNode.next === outerNode.prev) return triangles;

  if (hasHoles) outerNode = eliminateHoles(data, holeIndices, outerNode, dim);

  // Bounding box for z-order (only worth it on large inputs).
  let minX = 0, minY = 0, invSize = 0;
  if (data.length > 80 * dim) {
    minX = Infinity; minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;
    for (let i = dim; i < outerLen; i += dim) {
      const x = data[i], y = data[i + 1];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    invSize = Math.max(maxX - minX, maxY - minY);
    invSize = invSize !== 0 ? 32767 / invSize : 0;
  }

  earcutLinked(outerNode, triangles, dim, minX, minY, invSize, 0);
  return triangles;
}

/** Create a circular doubly-linked list from a ring of coordinates. */
function linkedList(
  data: number[], start: number, end: number, dim: number, clockwise: boolean,
): Node | null {
  let last: Node | null = null;
  if (clockwise === signedAreaFlat(data, start, end, dim) > 0) {
    for (let i = start; i < end; i += dim) last = insertNode(i / dim, data[i], data[i + 1], last);
  } else {
    for (let i = end - dim; i >= start; i -= dim) last = insertNode(i / dim, data[i], data[i + 1], last);
  }
  if (last && equals(last, last.next)) {
    removeNode(last);
    last = last.next;
  }
  return last;
}

/** Remove collinear or duplicate nodes. */
function filterPoints(start: Node | null, end?: Node | null): Node | null {
  if (!start) return start;
  if (!end) end = start;
  let p = start;
  let again: boolean;
  do {
    again = false;
    if (!p.steiner && (equals(p, p.next) || area(p.prev, p, p.next) === 0)) {
      removeNode(p);
      p = end = p.prev;
      if (p === p.next) break;
      again = true;
    } else {
      p = p.next;
    }
  } while (again || p !== end);
  return end;
}

function earcutLinked(
  start: Node | null, triangles: number[], dim: number,
  minX: number, minY: number, invSize: number, pass: number,
): void {
  if (!start) return;
  let ear: Node = start;
  if (!pass && invSize) indexCurve(ear, minX, minY, invSize);

  let stop: Node = ear;
  while (ear.prev !== ear.next) {
    const prev = ear.prev;
    const next = ear.next;

    if (invSize ? isEarHashed(ear, minX, minY, invSize) : isEar(ear)) {
      triangles.push(prev.i, ear.i, next.i);
      removeNode(ear);
      ear = next.next;
      stop = next.next;
      continue;
    }

    ear = next;
    if (ear === stop) {
      // No ear found on a full loop — try the recovery paths.
      const filtered = filterPoints(ear);
      if (!pass) {
        earcutLinked(filtered, triangles, dim, minX, minY, invSize, 1);
      } else if (pass === 1 && filtered) {
        const cured = cureLocalIntersections(filtered, triangles);
        earcutLinked(cured, triangles, dim, minX, minY, invSize, 2);
      } else if (pass === 2) {
        splitEarcut(ear, triangles, dim, minX, minY, invSize);
      }
      break;
    }
  }
}

function isEar(ear: Node): boolean {
  const a = ear.prev, b = ear, c = ear.next;
  if (area(a, b, c) >= 0) return false; // reflex

  // Reflex points inside the ear triangle block it.
  const ax = a.x, bx = b.x, cx = c.x, ay = a.y, by = b.y, cy = c.y;
  const x0 = Math.min(ax, bx, cx), y0 = Math.min(ay, by, cy);
  const x1 = Math.max(ax, bx, cx), y1 = Math.max(ay, by, cy);
  let p = c.next;
  while (p !== a) {
    if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1 &&
        pointInTriangle(ax, ay, bx, by, cx, cy, p.x, p.y) &&
        area(p.prev, p, p.next) >= 0) return false;
    p = p.next;
  }
  return true;
}

function isEarHashed(ear: Node, minX: number, minY: number, invSize: number): boolean {
  const a = ear.prev, b = ear, c = ear.next;
  if (area(a, b, c) >= 0) return false;

  const ax = a.x, bx = b.x, cx = c.x, ay = a.y, by = b.y, cy = c.y;
  const x0 = Math.min(ax, bx, cx), y0 = Math.min(ay, by, cy);
  const x1 = Math.max(ax, bx, cx), y1 = Math.max(ay, by, cy);
  const minZ = zOrder(x0, y0, minX, minY, invSize);
  const maxZ = zOrder(x1, y1, minX, minY, invSize);

  let p = ear.prevZ, n = ear.nextZ;
  while (p && p.z >= minZ && n && n.z <= maxZ) {
    if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1 && p !== a && p !== c &&
        pointInTriangle(ax, ay, bx, by, cx, cy, p.x, p.y) && area(p.prev, p, p.next) >= 0) return false;
    p = p.prevZ;
    if (n.x >= x0 && n.x <= x1 && n.y >= y0 && n.y <= y1 && n !== a && n !== c &&
        pointInTriangle(ax, ay, bx, by, cx, cy, n.x, n.y) && area(n.prev, n, n.next) >= 0) return false;
    n = n.nextZ;
  }
  while (p && p.z >= minZ) {
    if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1 && p !== a && p !== c &&
        pointInTriangle(ax, ay, bx, by, cx, cy, p.x, p.y) && area(p.prev, p, p.next) >= 0) return false;
    p = p.prevZ;
  }
  while (n && n.z <= maxZ) {
    if (n.x >= x0 && n.x <= x1 && n.y >= y0 && n.y <= y1 && n !== a && n !== c &&
        pointInTriangle(ax, ay, bx, by, cx, cy, n.x, n.y) && area(n.prev, n, n.next) >= 0) return false;
    n = n.nextZ;
  }
  return true;
}

function cureLocalIntersections(start: Node, triangles: number[]): Node {
  let p = start;
  do {
    const a = p.prev, b = p.next.next;
    if (!equals(a, b) && intersects(a, p, p.next, b) && locallyInside(a, b) && locallyInside(b, a)) {
      triangles.push(a.i, p.i, b.i);
      removeNode(p);
      removeNode(p.next);
      p = start = b;
    }
    p = p.next;
  } while (p !== start);
  return filterPoints(p)!;
}

function splitEarcut(
  start: Node, triangles: number[], dim: number, minX: number, minY: number, invSize: number,
): void {
  let a = start;
  do {
    let b = a.next.next;
    while (b !== a.prev) {
      if (a.i !== b.i && isValidDiagonal(a, b)) {
        let c: Node | null = splitPolygon(a, b);
        a = filterPoints(a, a.next)!;
        c = filterPoints(c, c.next);
        earcutLinked(a, triangles, dim, minX, minY, invSize, 0);
        earcutLinked(c, triangles, dim, minX, minY, invSize, 0);
        return;
      }
      b = b.next;
    }
    a = a.next;
  } while (a !== start);
}

function eliminateHoles(data: number[], holeIndices: number[], outerNode: Node, dim: number): Node {
  const queue: Node[] = [];
  for (let i = 0; i < holeIndices.length; i++) {
    const start = holeIndices[i] * dim;
    const end = i < holeIndices.length - 1 ? holeIndices[i + 1] * dim : data.length;
    const list = linkedList(data, start, end, dim, false);
    if (list) {
      if (list === list.next) list.steiner = true;
      queue.push(getLeftmost(list));
    }
  }
  queue.sort((a, b) => a.x - b.x);

  let node = outerNode;
  for (const hole of queue) {
    node = eliminateHole(hole, node);
  }
  return node;
}

function eliminateHole(hole: Node, outerNode: Node): Node {
  const bridge = findHoleBridge(hole, outerNode);
  if (!bridge) return outerNode;
  const bridgeReverse = splitPolygon(bridge, hole);
  filterPoints(bridgeReverse, bridgeReverse.next);
  return filterPoints(bridge, bridge.next)!;
}

/** Find the outer-polygon vertex mutually visible from a hole's leftmost node. */
function findHoleBridge(hole: Node, outerNode: Node): Node | null {
  let p = outerNode;
  const hx = hole.x, hy = hole.y;
  let qx = -Infinity;
  let m: Node | null = null;

  // Raycast the hole's leftmost point to the left; find the outer edge it hits.
  do {
    if (hy <= p.y && hy >= p.next.y && p.next.y !== p.y) {
      const x = p.x + ((hy - p.y) * (p.next.x - p.x)) / (p.next.y - p.y);
      if (x <= hx && x > qx) {
        qx = x;
        m = p.x < p.next.x ? p : p.next;
        if (x === hx) return m; // hole touches the edge — connect right there
      }
    }
    p = p.next;
  } while (p !== outerNode);
  if (!m) return null;

  // Look for reflex points inside the triangle (hole, edge intersection, m).
  const stop = m;
  const mx = m.x, my = m.y;
  let tanMin = Infinity;
  p = m;
  do {
    if (hx >= p.x && p.x >= mx && hx !== p.x &&
        pointInTriangle(hy < my ? hx : qx, hy, mx, my, hy < my ? qx : hx, hy, p.x, p.y)) {
      const tan = Math.abs(hy - p.y) / (hx - p.x);
      if (locallyInside(p, hole) && (tan < tanMin || (tan === tanMin &&
          (p.x > m!.x || (p.x === m!.x && sectorContainsSector(m!, p)))))) {
        m = p;
        tanMin = tan;
      }
    }
    p = p.next;
  } while (p !== stop);
  return m;
}

function sectorContainsSector(m: Node, p: Node): boolean {
  return area(m.prev, m, p.prev) < 0 && area(p.next, m, m.next) < 0;
}

function indexCurve(start: Node, minX: number, minY: number, invSize: number): void {
  let p = start;
  do {
    if (p.z === 0) p.z = zOrder(p.x, p.y, minX, minY, invSize);
    p.prevZ = p.prev;
    p.nextZ = p.next;
    p = p.next;
  } while (p !== start);
  p.prevZ!.nextZ = null;
  p.prevZ = null;
  sortLinked(p);
}

function sortLinked(list: Node | null): Node | null {
  let inSize = 1;
  let numMerges: number;
  do {
    let p = list;
    list = null;
    let tail: Node | null = null;
    numMerges = 0;
    while (p) {
      numMerges++;
      let q: Node | null = p;
      let pSize = 0;
      for (let i = 0; i < inSize; i++) { pSize++; q = q!.nextZ; if (!q) break; }
      let qSize = inSize;
      while (pSize > 0 || (qSize > 0 && q)) {
        let e: Node;
        if (pSize !== 0 && (qSize === 0 || !q || p!.z <= q.z)) {
          e = p!; p = p!.nextZ; pSize--;
        } else {
          e = q!; q = q!.nextZ; qSize--;
        }
        if (tail) tail.nextZ = e; else list = e;
        e.prevZ = tail;
        tail = e;
      }
      p = q;
    }
    tail!.nextZ = null;
    inSize *= 2;
  } while (numMerges > 1);
  return list;
}

function zOrder(x: number, y: number, minX: number, minY: number, invSize: number): number {
  let lx = Math.trunc((x - minX) * invSize);
  let ly = Math.trunc((y - minY) * invSize);
  lx = (lx | (lx << 8)) & 0x00ff00ff;
  lx = (lx | (lx << 4)) & 0x0f0f0f0f;
  lx = (lx | (lx << 2)) & 0x33333333;
  lx = (lx | (lx << 1)) & 0x55555555;
  ly = (ly | (ly << 8)) & 0x00ff00ff;
  ly = (ly | (ly << 4)) & 0x0f0f0f0f;
  ly = (ly | (ly << 2)) & 0x33333333;
  ly = (ly | (ly << 1)) & 0x55555555;
  return lx | (ly << 1);
}

function getLeftmost(start: Node): Node {
  let p = start, leftmost = start;
  do {
    if (p.x < leftmost.x || (p.x === leftmost.x && p.y < leftmost.y)) leftmost = p;
    p = p.next;
  } while (p !== start);
  return leftmost;
}

function pointInTriangle(
  ax: number, ay: number, bx: number, by: number, cx: number, cy: number, px: number, py: number,
): boolean {
  return (cx - px) * (ay - py) >= (ax - px) * (cy - py) &&
         (ax - px) * (by - py) >= (bx - px) * (ay - py) &&
         (bx - px) * (cy - py) >= (cx - px) * (by - py);
}

function isValidDiagonal(a: Node, b: Node): boolean {
  return a.next.i !== b.i && a.prev.i !== b.i && !intersectsPolygon(a, b) &&
    ((locallyInside(a, b) && locallyInside(b, a) && middleInside(a, b) &&
      (area(a.prev, a, b.prev) !== 0 || area(a, b.prev, b) !== 0)) ||
     (equals(a, b) && area(a.prev, a, a.next) > 0 && area(b.prev, b, b.next) > 0));
}

function area(p: Node, q: Node, r: Node): number {
  return (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y);
}

function equals(p1: Node, p2: Node): boolean {
  return p1.x === p2.x && p1.y === p2.y;
}

function intersects(p1: Node, q1: Node, p2: Node, q2: Node): boolean {
  const o1 = Math.sign(area(p1, q1, p2));
  const o2 = Math.sign(area(p1, q1, q2));
  const o3 = Math.sign(area(p2, q2, p1));
  const o4 = Math.sign(area(p2, q2, q1));
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(p1, p2, q1)) return true;
  if (o2 === 0 && onSegment(p1, q2, q1)) return true;
  if (o3 === 0 && onSegment(p2, p1, q2)) return true;
  if (o4 === 0 && onSegment(p2, q1, q2)) return true;
  return false;
}

function onSegment(p: Node, q: Node, r: Node): boolean {
  return q.x <= Math.max(p.x, r.x) && q.x >= Math.min(p.x, r.x) &&
         q.y <= Math.max(p.y, r.y) && q.y >= Math.min(p.y, r.y);
}

function intersectsPolygon(a: Node, b: Node): boolean {
  let p = a;
  do {
    if (p.i !== a.i && p.next.i !== a.i && p.i !== b.i && p.next.i !== b.i &&
        intersects(p, p.next, a, b)) return true;
    p = p.next;
  } while (p !== a);
  return false;
}

function locallyInside(a: Node, b: Node): boolean {
  return area(a.prev, a, a.next) < 0
    ? area(a, b, a.next) >= 0 && area(a, a.prev, b) >= 0
    : area(a, b, a.prev) < 0 || area(a, a.next, b) < 0;
}

function middleInside(a: Node, b: Node): boolean {
  let p = a;
  let inside = false;
  const px = (a.x + b.x) / 2, py = (a.y + b.y) / 2;
  do {
    if (p.y > py !== p.next.y > py && p.next.y !== p.y &&
        px < ((p.next.x - p.x) * (py - p.y)) / (p.next.y - p.y) + p.x) inside = !inside;
    p = p.next;
  } while (p !== a);
  return inside;
}

function splitPolygon(a: Node, b: Node): Node {
  const a2 = createNode(a.i, a.x, a.y);
  const b2 = createNode(b.i, b.x, b.y);
  const an = a.next, bp = b.prev;
  a.next = b; b.prev = a;
  a2.next = an; an.prev = a2;
  b2.next = a2; a2.prev = b2;
  bp.next = b2; b2.prev = bp;
  return b2;
}

function insertNode(i: number, x: number, y: number, last: Node | null): Node {
  const p = createNode(i, x, y);
  if (!last) {
    p.prev = p; p.next = p;
  } else {
    p.next = last.next; p.prev = last;
    last.next.prev = p; last.next = p;
  }
  return p;
}

function removeNode(p: Node): void {
  p.next.prev = p.prev;
  p.prev.next = p.next;
  if (p.prevZ) p.prevZ.nextZ = p.nextZ;
  if (p.nextZ) p.nextZ.prevZ = p.prevZ;
}

function createNode(i: number, x: number, y: number): Node {
  const n = {
    i, x, y, z: 0, steiner: false,
    prev: null as unknown as Node, next: null as unknown as Node,
    prevZ: null as Node | null, nextZ: null as Node | null,
  };
  return n;
}

function signedAreaFlat(data: number[], start: number, end: number, dim: number): number {
  let sum = 0;
  for (let i = start, j = end - dim; i < end; i += dim) {
    sum += (data[j] - data[i]) * (data[i + 1] + data[j + 1]);
    j = i;
  }
  return sum;
}
