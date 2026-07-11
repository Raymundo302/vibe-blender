import { Mat4 } from '../core/math/mat4';

/**
 * CSS3D portal math (UR7-3) — map a 3D plane through the live view+projection to
 * a single CSS `matrix3d` so a real `<iframe>` can be overlaid on the viewport,
 * transform-matched to the plane each frame (the classic CSS3D sync used by
 * THREE.CSS3DRenderer et al.). We bake the FULL projective transform into one
 * matrix so no ancestor `perspective` property is needed — the perspective is
 * derived from the projection matrix itself (its bottom row couples view-Z into
 * the homogeneous W, and CSS divides X/W, Y/W exactly like the GL pipeline).
 *
 * The chain for an input local point `p` (an iframe-px coordinate once the caller
 * folds {@link pxToPlaneLocalMatrix} into `world`):
 *
 *   clip   = proj · view · world · p        (GL clip space, y-up, divide by w)
 *   screen = S · clip                        (S maps clip → viewport px, y-down)
 *
 * where S is chosen so that after the SINGLE CSS perspective divide by W (= clip
 * w) the result is exactly the on-screen pixel position:
 *
 *   screen_x = (clip_x/clip_w + 1)/2 · vw = ((vw/2)·clip_x + (vw/2)·clip_w) / clip_w
 *   screen_y = (1 − clip_y/clip_w)/2 · vh = ((−vh/2)·clip_y + (vh/2)·clip_w) / clip_w
 *
 * so S keeps W = clip_w and folds the NDC→px scale + y-flip into the numerators.
 * The composite `S · proj · view · world` is returned as a {@link Mat4} whose
 * column-major storage IS the CSS `matrix3d` argument order — see
 * {@link cssMatrix3d}.
 */

/**
 * The clip→viewport-px scale matrix S (pure, unit-tested). Maps a clip-space
 * point `[cx,cy,cz,cw]` to `[X,Y,Z,W]` with `W = cw`, so that CSS's perspective
 * divide (X/W, Y/W) yields the pixel position in a `vw × vh` viewport with the
 * origin at the top-left and Y increasing downward.
 */
export function screenScaleMatrix(vw: number, vh: number): Mat4 {
  const m = new Float32Array(16);
  // Column-major (index = col*4 + row). Rows (row-major view):
  //   [ vw/2 ,   0   , 0 , vw/2 ]
  //   [  0   , -vh/2 , 0 , vh/2 ]
  //   [  0   ,   0   , 1 ,  0   ]
  //   [  0   ,   0   , 0 ,  1   ]
  m[0] = vw / 2;
  m[5] = -vh / 2;
  m[10] = 1;
  m[12] = vw / 2;
  m[13] = vh / 2;
  m[15] = 1;
  return new Mat4(m);
}

/**
 * Build the CSS `matrix3d` (as a {@link Mat4}) mapping the input coordinate space
 * of `world` through `view`+`proj` to viewport pixels. Pure. The caller applies
 * the result to an element whose `transform-origin` is `0 0` (top-left); the
 * element's own local coordinates are then the input space of `world` — typically
 * iframe px once {@link pxToPlaneLocalMatrix} is composed into `world`.
 */
export function screenMatrixForPlane(
  world: Mat4,
  view: Mat4,
  proj: Mat4,
  viewportPx: { w: number; h: number },
): Mat4 {
  return screenScaleMatrix(viewportPx.w, viewportPx.h).mul(proj).mul(view).mul(world);
}

/**
 * Affine map from iframe pixel coordinates (x: 0..pageW left→right, y: 0..pageH
 * top→bottom) to the plane mesh's LOCAL space (z = 0), so iframe px (0,0) lands on
 * the plane's top-left corner and (pageW,pageH) on its bottom-right. `minX/maxX`
 * and `minY/maxY` are the plane quad's local extents (top = maxY, matching the
 * HTML-plane UV layout where v=0 is the page top). Compose into the plane's world
 * matrix — `world · pxToPlaneLocalMatrix(...)` — to feed {@link screenMatrixForPlane}.
 * Degenerate page dimensions fall back to 1 so a bad value can't NaN the transform.
 */
export function pxToPlaneLocalMatrix(
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  pageW: number,
  pageH: number,
): Mat4 {
  const pw = Number.isFinite(pageW) && pageW > 0 ? pageW : 1;
  const ph = Number.isFinite(pageH) && pageH > 0 ? pageH : 1;
  const m = new Float32Array(16);
  m[0] = (maxX - minX) / pw; // px_x → local x
  m[5] = -(maxY - minY) / ph; // px_y (down) → local y (up), so top-left → maxY
  m[10] = 1;
  m[12] = minX;
  m[13] = maxY;
  m[15] = 1;
  return new Mat4(m);
}

/** Snap CSS-insignificant tiny values (and −0) to 0 for a clean, stable string. */
function tidy(v: number): number {
  return Math.abs(v) < 1e-7 ? 0 : v;
}

/**
 * A {@link Mat4} → CSS `matrix3d(...)` string. The Mat4's column-major storage is
 * already the order CSS matrix3d expects (column-major, 16 values).
 */
export function cssMatrix3d(m: Mat4): string {
  return 'matrix3d(' + Array.from(m.m, tidy).join(',') + ')';
}

/**
 * Clip-space W (homogeneous depth) of a local point through `proj · view · world`.
 * A point is IN FRONT of the camera when W > 0. Used to hide a portal whose plane
 * has any corner behind the camera (CSS would otherwise fold it into garbage).
 */
export function clipW(pvw: Mat4, x: number, y: number, z: number): number {
  const m = pvw.m;
  return m[3] * x + m[7] * y + m[11] * z + m[15];
}
