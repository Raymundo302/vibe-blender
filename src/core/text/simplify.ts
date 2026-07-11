/**
 * Douglas-Peucker polyline simplification (pure).
 *
 * Glyph contours traced from a bitmap are dense stair-steps; this collapses
 * near-collinear runs to a handful of points within `tolerance` pixels of the
 * original, which keeps the triangulator fast and the walls clean.
 */

export type Pt = [number, number];

/** Perpendicular distance from p to the segment a-b. */
function perpDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-18) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  const cx = a[0] + t * dx, cy = a[1] + t * dy;
  return Math.hypot(p[0] - cx, p[1] - cy);
}

/** Simplify an OPEN polyline (endpoints preserved). */
export function simplifyOpen(points: Pt[], tolerance = 0.75): Pt[] {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop()!;
    let maxD = -1, idx = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = perpDist(points[i], points[lo], points[hi]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tolerance && idx > 0) {
      keep[idx] = 1;
      stack.push([lo, idx], [idx, hi]);
    }
  }
  const out: Pt[] = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  return out;
}

/**
 * Simplify a CLOSED loop (first point not repeated on input or output).
 * Anchors on the point farthest from points[0] so the loop is split into two
 * open chains that DP can process without dropping the whole ring.
 */
export function simplifyClosed(points: Pt[], tolerance = 0.75): Pt[] {
  const n = points.length;
  if (n <= 3) return points.slice();
  // Farthest point from the anchor, to break the loop robustly.
  let far = 1, farD = -1;
  for (let i = 1; i < n; i++) {
    const d = Math.hypot(points[i][0] - points[0][0], points[i][1] - points[0][1]);
    if (d > farD) { farD = d; far = i; }
  }
  const first = points.slice(0, far + 1);
  const second = points.slice(far).concat([points[0]]);
  const a = simplifyOpen(first, tolerance);
  const b = simplifyOpen(second, tolerance);
  // a: 0..far, b: far..0. Drop b's duplicated endpoints (far and 0).
  const out = a.concat(b.slice(1, b.length - 1));
  return out.length >= 3 ? out : points.slice();
}
