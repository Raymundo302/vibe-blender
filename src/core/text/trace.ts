/**
 * Marching-squares contour tracer (pure — no canvas).
 *
 * Given a thresholded alpha bitmap it walks the boundary between filled and
 * empty cells, producing a set of closed contours in pixel coordinates. Each
 * contour is classified outer-vs-hole by nesting depth (point-in-polygon
 * containment) — even depth = outer, odd depth = hole — and carries its signed
 * (shoelace) area for downstream orientation decisions.
 *
 * The field is padded with an implicit "empty" border (samples outside the
 * bitmap read as 0), so shapes that touch the bitmap edge still close cleanly.
 */

export type Pt = [number, number];

export interface Contour {
  /** Closed loop of points (pixel coords); the first point is NOT repeated. */
  points: Pt[];
  /** Signed shoelace area (sign is arbitrary — orientation not normalized). */
  area: number;
  /** True when this contour bounds a hole (odd containment depth). */
  isHole: boolean;
  /** Index of the immediate containing contour, or -1 when top-level. */
  parent: number;
}

export function signedArea(poly: Pt[]): number {
  let a = 0;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

export function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    const intersect =
      yi > p[1] !== yj > p[1] &&
      p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Trace all closed contours of a thresholded bitmap.
 * @param alpha row-major alpha values (0..255), length width*height.
 */
export function traceContours(
  alpha: ArrayLike<number>,
  width: number,
  height: number,
  threshold = 128,
): Contour[] {
  const inside = (x: number, y: number): boolean => {
    if (x < 0 || x >= width || y < 0 || y >= height) return false;
    return (alpha[y * width + x] ?? 0) >= threshold;
  };

  // Marching squares: emit undirected segments per cell. Midpoints sit on the
  // half-integer grid, so a *2 integer key is exact (no float hashing error).
  const segs: [number, number, number, number][] = [];
  const T = (cx: number, cy: number): Pt => [cx + 0.5, cy];
  const R = (cx: number, cy: number): Pt => [cx + 1, cy + 0.5];
  const B = (cx: number, cy: number): Pt => [cx + 0.5, cy + 1];
  const L = (cx: number, cy: number): Pt => [cx, cy + 0.5];
  const push = (a: Pt, b: Pt): void => { segs.push([a[0], a[1], b[0], b[1]]); };

  for (let cy = -1; cy < height; cy++) {
    for (let cx = -1; cx < width; cx++) {
      const tl = inside(cx, cy) ? 8 : 0;
      const tr = inside(cx + 1, cy) ? 4 : 0;
      const br = inside(cx + 1, cy + 1) ? 2 : 0;
      const bl = inside(cx, cy + 1) ? 1 : 0;
      switch (tl | tr | br | bl) {
        case 1: push(L(cx, cy), B(cx, cy)); break;
        case 2: push(B(cx, cy), R(cx, cy)); break;
        case 3: push(L(cx, cy), R(cx, cy)); break;
        case 4: push(T(cx, cy), R(cx, cy)); break;
        case 5: push(T(cx, cy), R(cx, cy)); push(L(cx, cy), B(cx, cy)); break; // saddle
        case 6: push(T(cx, cy), B(cx, cy)); break;
        case 7: push(T(cx, cy), L(cx, cy)); break;
        case 8: push(T(cx, cy), L(cx, cy)); break;
        case 9: push(T(cx, cy), B(cx, cy)); break;
        case 10: push(T(cx, cy), L(cx, cy)); push(B(cx, cy), R(cx, cy)); break; // saddle
        case 11: push(T(cx, cy), R(cx, cy)); break;
        case 12: push(L(cx, cy), R(cx, cy)); break;
        case 13: push(B(cx, cy), R(cx, cy)); break;
        case 14: push(L(cx, cy), B(cx, cy)); break;
        default: break; // 0 and 15 have no crossing
      }
    }
  }

  // Chain undirected segments into closed loops. On a clean binary field every
  // crossing vertex has degree exactly 2, so a greedy walk is unambiguous.
  const key = (x: number, y: number): string => `${Math.round(x * 2)},${Math.round(y * 2)}`;
  const nbr = new Map<string, string[]>();
  const pts = new Map<string, Pt>();
  for (const [ax, ay, bx, by] of segs) {
    const ka = key(ax, ay), kb = key(bx, by);
    if (ka === kb) continue;
    pts.set(ka, [ax, ay]);
    pts.set(kb, [bx, by]);
    (nbr.get(ka) ?? nbr.set(ka, []).get(ka)!).push(kb);
    (nbr.get(kb) ?? nbr.set(kb, []).get(kb)!).push(ka);
  }

  const loops: Pt[][] = [];
  for (const startK of nbr.keys()) {
    while ((nbr.get(startK)?.length ?? 0) > 0) {
      const loop: Pt[] = [];
      let cur = startK;
      let guard = 0;
      const limit = segs.length * 2 + 8;
      while (guard++ < limit) {
        const neighbors = nbr.get(cur)!;
        if (neighbors.length === 0) break;
        const nx = neighbors.shift()!;
        const rev = nbr.get(nx)!;
        const ri = rev.indexOf(cur);
        if (ri >= 0) rev.splice(ri, 1);
        loop.push(pts.get(cur)!);
        cur = nx;
        if (cur === startK) break;
      }
      if (loop.length >= 3) loops.push(loop);
    }
  }

  // Classify each loop by containment depth.
  const contours: Contour[] = loops.map((points) => ({
    points,
    area: signedArea(points),
    isHole: false,
    parent: -1,
  }));

  for (let i = 0; i < contours.length; i++) {
    const rep = contours[i].points[0];
    let depth = 0;
    let parent = -1;
    let parentAbsArea = Infinity;
    for (let j = 0; j < contours.length; j++) {
      if (j === i) continue;
      if (pointInPolygon(rep, contours[j].points)) {
        depth++;
        const aj = Math.abs(contours[j].area);
        if (aj < parentAbsArea) { parentAbsArea = aj; parent = j; }
      }
    }
    contours[i].isHole = depth % 2 === 1;
    contours[i].parent = parent;
  }

  return contours;
}
