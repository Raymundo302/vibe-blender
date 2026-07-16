/**
 * NURBS foundation (NB-CORE): knot vectors and B-spline basis functions with
 * derivatives, straight from Piegl & Tiller "The NURBS Book" (algorithms
 * A2.1/A2.2/A2.3). Pure math — no GL, no DOM, no app imports — unit-tested
 * against closed forms and the legacy curve/eval implementation.
 *
 * Conventions (used by curve.ts / surface.ts / tessellate.ts):
 *  - degree p, control count n+1 → knot vector length n+p+2 (m = n+p+1).
 *  - Valid parameter domain is [U[p], U[n+1]] (clamped vectors: [first, last]).
 *  - Knot values are arbitrary non-decreasing reals; clamped-UNIFORM builders
 *    use the integer convention of core/curve/eval.ts (0..n-p+1) so payloads
 *    without explicit knots keep evaluating exactly as before.
 */

/** Binomial coefficient C(n, k) (exact for the small n used by NURBS orders). */
export function binomial(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return Math.round(r);
}

/**
 * Clamped-uniform knot vector for `count` control points of degree `p`:
 * p+1 zeros, integers 1..count-p-1, then p+1 copies of count-p. Identical to
 * core/curve/eval.ts clampedKnots (kept there for the legacy evaluator).
 */
export function clampedUniformKnots(count: number, p: number): number[] {
  const m = count + p; // last knot index
  const knots: number[] = [];
  const inner = count - p;
  for (let i = 0; i <= m; i++) {
    if (i <= p) knots.push(0);
    else if (i >= m - p) knots.push(inner);
    else knots.push(i - p);
  }
  return knots;
}

/** True when `U` is a structurally valid knot vector for count/degree:
 *  right length, non-decreasing, and a non-empty domain. */
export function validKnots(count: number, p: number, U: number[]): boolean {
  if (U.length !== count + p + 1) return false;
  for (let i = 1; i < U.length; i++) if (U[i] < U[i - 1]) return false;
  return U[count] > U[p]; // domain [U[p], U[count]] must have positive width
}

/** The evaluable parameter domain [lo, hi] of a knot vector. */
export function knotDomain(count: number, p: number, U: number[]): [number, number] {
  return [U[p], U[count]];
}

/** Clamp u into the domain (guards float drift at the ends). */
export function clampToDomain(count: number, p: number, U: number[], u: number): number {
  const [lo, hi] = knotDomain(count, p, U);
  return u < lo ? lo : u > hi ? hi : u;
}

/**
 * Knot span index i with U[i] <= u < U[i+1] (A2.1). u at the domain's upper
 * end returns the LAST span (count-1 side), never an empty end span.
 */
export function findSpan(count: number, p: number, u: number, U: number[]): number {
  const n = count - 1;
  if (u >= U[n + 1]) return n; // upper end → last valid span
  if (u <= U[p]) return p;
  let lo = p, hi = n + 1;
  let mid = (lo + hi) >> 1;
  while (u < U[mid] || u >= U[mid + 1]) {
    if (u < U[mid]) hi = mid;
    else lo = mid;
    mid = (lo + hi) >> 1;
  }
  return mid;
}

/**
 * The p+1 nonzero basis functions N_{span-p..span, p}(u) (A2.2).
 * Returns out[j] = N_{span-p+j, p}(u); they sum to 1 (partition of unity).
 */
export function basisFuns(span: number, u: number, p: number, U: number[]): number[] {
  const N = new Array<number>(p + 1).fill(1);
  const left = new Array<number>(p + 1).fill(0);
  const right = new Array<number>(p + 1).fill(0);
  for (let j = 1; j <= p; j++) {
    left[j] = u - U[span + 1 - j];
    right[j] = U[span + j] - u;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const denom = right[r + 1] + left[j - r];
      const temp = denom === 0 ? 0 : N[r] / denom;
      N[r] = saved + right[r + 1] * temp;
      saved = left[j - r] * temp;
    }
    N[j] = saved;
  }
  return N;
}

/**
 * Basis functions AND derivatives up to order d (A2.3).
 * Returns ders[k][j] = k-th derivative of N_{span-p+j, p} at u, for k = 0..d.
 * ders[0] equals basisFuns(...). Derivatives above the degree are zero.
 */
export function dersBasisFuns(span: number, u: number, p: number, d: number, U: number[]): number[][] {
  const ndu: number[][] = Array.from({ length: p + 1 }, () => new Array<number>(p + 1).fill(0));
  const left = new Array<number>(p + 1).fill(0);
  const right = new Array<number>(p + 1).fill(0);
  ndu[0][0] = 1;
  for (let j = 1; j <= p; j++) {
    left[j] = u - U[span + 1 - j];
    right[j] = U[span + j] - u;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      ndu[j][r] = right[r + 1] + left[j - r];
      const temp = ndu[j][r] === 0 ? 0 : ndu[r][j - 1] / ndu[j][r];
      ndu[r][j] = saved + right[r + 1] * temp;
      saved = left[j - r] * temp;
    }
    ndu[j][j] = saved;
  }

  const ders: number[][] = Array.from({ length: d + 1 }, () => new Array<number>(p + 1).fill(0));
  for (let j = 0; j <= p; j++) ders[0][j] = ndu[j][p];

  const a: number[][] = [new Array<number>(p + 1).fill(0), new Array<number>(p + 1).fill(0)];
  for (let r = 0; r <= p; r++) {
    let s1 = 0, s2 = 1;
    a[0][0] = 1;
    for (let k = 1; k <= d; k++) {
      let dv = 0;
      const rk = r - k, pk = p - k;
      if (r >= k) {
        a[s2][0] = ndu[pk + 1][rk] === 0 ? 0 : a[s1][0] / ndu[pk + 1][rk];
        dv = a[s2][0] * ndu[rk][pk];
      }
      const j1 = rk >= -1 ? 1 : -rk;
      const j2 = r - 1 <= pk ? k - 1 : p - r;
      for (let j = j1; j <= j2; j++) {
        a[s2][j] = ndu[pk + 1][rk + j] === 0 ? 0 : (a[s1][j] - a[s1][j - 1]) / ndu[pk + 1][rk + j];
        dv += a[s2][j] * ndu[rk + j][pk];
      }
      if (r <= pk) {
        a[s2][k] = ndu[pk + 1][r] === 0 ? 0 : -a[s1][k - 1] / ndu[pk + 1][r];
        dv += a[s2][k] * ndu[r][pk];
      }
      ders[k][r] = dv;
      const t = s1; s1 = s2; s2 = t;
    }
  }
  let r = p;
  for (let k = 1; k <= d; k++) {
    for (let j = 0; j <= p; j++) ders[k][j] *= r;
    r *= p - k;
  }
  return ders;
}

/** Multiplicity of knot value `u` in U (within 1e-12). */
export function knotMultiplicity(U: number[], u: number): number {
  let m = 0;
  for (const k of U) if (Math.abs(k - u) < 1e-12) m++;
  return m;
}

/** The distinct knot values inside the OPEN domain (interior knots), with
 *  multiplicities. Used by degree elevation tests and span/isoparm UIs. */
export function interiorKnots(count: number, p: number, U: number[]): { u: number; mult: number }[] {
  const out: { u: number; mult: number }[] = [];
  const [lo, hi] = knotDomain(count, p, U);
  let i = 0;
  while (i < U.length) {
    const u = U[i];
    let m = 1;
    while (i + m < U.length && Math.abs(U[i + m] - u) < 1e-12) m++;
    if (u > lo + 1e-12 && u < hi - 1e-12) out.push({ u, mult: m });
    i += m;
  }
  return out;
}
