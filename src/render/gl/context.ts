export interface GlContext {
  gl: WebGL2RenderingContext;
  canvas: HTMLCanvasElement;
  /** Sync canvas backing store to CSS size * DPR. Returns true if it changed. */
  syncSize(): boolean;
}

export function createGlContext(canvas: HTMLCanvasElement): GlContext {
  const gl = canvas.getContext('webgl2', {
    antialias: true,
    // Depth buffer stays available for the outline pass to sample later if needed
    preserveDrawingBuffer: false,
  });
  if (!gl) throw new Error('WebGL2 not supported');

  const syncSize = (): boolean => {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      return true;
    }
    return false;
  };
  syncSize();

  return { gl, canvas, syncSize };
}
