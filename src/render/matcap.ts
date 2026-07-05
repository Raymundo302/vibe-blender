/**
 * Procedural matcap texture (architecture decision A6): a lit sphere painted
 * into a canvas — sampled by view-space normal.xy in the mesh shader. Gives
 * Blender's studio look with zero lighting code and no binary assets.
 */
export function createMatcapTexture(gl: WebGL2RenderingContext, size = 256): WebGLTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  // Base sphere shading: key light upper-left
  const base = ctx.createRadialGradient(
    size * 0.36, size * 0.32, size * 0.02,
    size * 0.5, size * 0.5, size * 0.62,
  );
  base.addColorStop(0, '#fafafa');
  base.addColorStop(0.35, '#b5b5b8');
  base.addColorStop(0.75, '#68686c');
  base.addColorStop(1, '#3a3a40');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);

  // Soft fill light lower-right (studio bounce)
  const fill = ctx.createRadialGradient(
    size * 0.72, size * 0.78, size * 0.02,
    size * 0.72, size * 0.78, size * 0.45,
  );
  fill.addColorStop(0, 'rgba(180, 185, 200, 0.35)');
  fill.addColorStop(1, 'rgba(180, 185, 200, 0)');
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, size, size);

  // Specular hotspot
  const spec = ctx.createRadialGradient(
    size * 0.33, size * 0.28, size * 0.01,
    size * 0.33, size * 0.28, size * 0.14,
  );
  spec.addColorStop(0, 'rgba(255, 255, 255, 0.9)');
  spec.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = spec;
  ctx.fillRect(0, 0, size, size);

  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}
