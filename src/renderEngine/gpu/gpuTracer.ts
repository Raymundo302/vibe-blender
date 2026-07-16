/**
 * UR12-1 — WebGL2 fragment-shader path tracer host (stage 1).
 *
 * Owns an offscreen WebGL2 context, uploads the packed scene (pack.ts) as
 * RGBA32F data textures, and runs the GLSL kernel (kernel.ts) over N progressive
 * samples into ping-pong RGBA32F accumulation targets. Requires
 * EXT_color_buffer_float for the float render targets — reports cleanly (does NOT
 * throw) when the extension or a WebGL2 context is unavailable, so callers can
 * fall back to the CPU tracer.
 *
 * Reuses the CPU BVH build (tracer.ts buildBVH) — there is no second acceleration
 * structure — and the CPU Snapshot (snapshot.ts) verbatim.
 */

import type { Snapshot, SnapCamera, SnapWorld, SnapMaterial, SnapLight } from '../snapshot';
import { defaultSnapWorld } from '../snapshot';
import { buildBVH, buildEmitters } from '../tracer';
import {
  packScene, packTriangles, packMaterials, packLights, packUVs, packLocals, packNormals, packEmitters,
  packImageAtlas, flattenBVH, type PackedScene, type Payload, type ImageAtlas,
} from './pack';
import { VERTEX_SRC, fragmentSource } from './kernel';

// --- change-detection signatures (UR12-3 incremental re-pack) ----------------
// Per-frame Ctrl+F12 renders re-pack ONLY the parts of the scene that changed:
// geometry (BVH + tris + UVs — the expensive rebuild), materials, lights, and
// the emissive-mesh CDF (a function of geometry AND materials). The camera and
// world are plain uniforms, so a camera-only change (the donut fly-through) does
// ZERO texture re-packing. Signatures are cheap FNV-1a hashes over the raw
// snapshot arrays (geometry) or the packed payloads (materials/lights, both
// tiny). GRANULARITY (documented): an IMAGE-only material edit is invisible to
// these keys because GPU v1 packs no image atlas (image → white, a documented
// kernel cut), so the packed material texels — and hence the key — are unchanged;
// that is correct, not a miss. A same-topology transform that leaves the baked
// world-space triangle bytes identical (impossible in practice) would also skip.

const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;

/** FNV-1a over the raw 32-bit words of a typed array (bit-exact, order-sensitive).
 *  Exported so the viewport raytraced mode (UR15-1) can reuse EXACTLY the same
 *  change-detection granularity for its accumulation-reset triggers. */
export function hashBits(a: Float32Array | Int32Array): number {
  const u = new Uint32Array(a.buffer, a.byteOffset, a.length);
  let h = FNV_OFFSET >>> 0;
  for (let i = 0; i < u.length; i++) {
    h ^= u[i];
    h = Math.imul(h, FNV_PRIME);
  }
  return h >>> 0;
}

export function combine(h1: number, h2: number): number {
  return (Math.imul(h1 ^ h2, FNV_PRIME) + 0x9e3779b1) >>> 0;
}

/** Geometry key: baked world tris + material assignment + UVs + smooth normals
 *  (drives BVH rebuild + the geometry-parallel payloads). triNormal is folded in so
 *  a Shade-Smooth TOGGLE — which can leave the baked world tris bit-identical —
 *  still re-packs the per-corner normals (UR16-5). */
export function geometrySignature(snap: Snapshot): number {
  let h = combine(hashBits(snap.tris), hashBits(snap.triMat));
  if (snap.triUV && snap.triUV.length) h = combine(h, hashBits(snap.triUV));
  if (snap.triNormal && snap.triNormal.length) h = combine(h, hashBits(snap.triNormal));
  return h >>> 0;
}
export function materialsSignature(mats: SnapMaterial[]): number {
  return hashBits(packMaterials(mats).data);
}
export function lightsSignature(lights: SnapLight[]): number {
  return hashBits(packLights(lights).data);
}

interface DataTex {
  tex: WebGLTexture;
  width: number;
}

/** A packed scene uploaded to GL, plus the camera/light metadata the kernel
 *  needs as uniforms. */
interface GpuScene {
  tris: DataTex;
  nodes: DataTex;
  nodeCount: number;
  triIdx: DataTex;
  mats: DataTex;
  uvs: DataTex;
  /** Per-corner object-local positions (UR16-1 gradients). */
  locals: DataTex;
  /** Per-corner world-space shading normals (UR16-5 smooth shading). */
  normals: DataTex;
  lights: DataTex;
  numLights: number;
  emit: DataTex;
  numEmitters: number;
  emitTotalArea: number;
  /** UR16-4 image atlas (TEXTURE_2D_ARRAY of RGBA8 layers). */
  atlas: WebGLTexture;
  camera: SnapCamera;
  world: SnapWorld;
  /** Equirect world texture for HDRI mode (2026-07-16 — closes the documented
   *  v1 "mode 2 falls back to gradient" gap), or null when world.hdri absent.
   *  NEAREST + REPEAT-u/CLAMP-v to match the CPU sampleEquirect exactly. */
  hdriTex: WebGLTexture | null;
  /** The HdriImage the texture was built from (re-upload only on change). */
  hdriSrc: import('../../core/scene/worldData').HdriImage | null;
}

export class GpuTracer {
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  private gl: WebGL2RenderingContext | null = null;
  private reason: string | null = null;
  private program: WebGLProgram | null = null;
  private uniforms = new Map<string, WebGLUniformLocation | null>();
  private quadVao: WebGLVertexArrayObject | null = null;

  // Ping-pong float targets (allocated/resized lazily in render()).
  private accumTex: [WebGLTexture | null, WebGLTexture | null] = [null, null];
  private accumFbo: [WebGLFramebuffer | null, WebGLFramebuffer | null] = [null, null];
  private accumW = 0;
  private accumH = 0;

  private scene: GpuScene | null = null;
  /** Transparent film (UR16-3): skip the world backdrop for the primary ray. Set
   *  from the snapshot on every setSnapshot; a plain uniform (no re-pack). */
  private transparent = false;

  // Change-detection signatures for incremental per-frame re-packing (UR12-3).
  private geoKey = 0;
  private matKey = 0;
  private lightKey = 0;
  /** What the LAST setSnapshot(incremental) actually rebuilt — reported by the
   *  anim driver for the "document granularity" requirement / e2e. */
  lastRepack: { geo: boolean; mat: boolean; light: boolean; emit: boolean } =
    { geo: true, mat: true, light: true, emit: true };

  // Progressive accumulation state (UR12-3 render window + anim path).
  private progW = 0;
  private progH = 0;
  private progSeed = 1;
  private progSamples = 0;
  private progSrc = 0;

  private lost = false;

  constructor(canvas?: HTMLCanvasElement | OffscreenCanvas) {
    this.canvas =
      canvas ??
      (typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(256, 256)
        : (document.createElement('canvas') as HTMLCanvasElement));
    this.init();
  }

  /** True when a WebGL2 context + EXT_color_buffer_float are both available. */
  get available(): boolean {
    return this.gl !== null && this.reason === null;
  }

  /** Human-readable reason the GPU path is unavailable, or null when it works. */
  get unavailableReason(): string | null {
    return this.reason;
  }

  /** True once the WebGL context has been lost (driver reset / forced). The
   *  render driver watches this mid-render and falls back to the CPU tracer. */
  get contextLost(): boolean {
    return this.lost || (this.gl !== null && this.gl.isContextLost());
  }

  /** Force a context loss (e2e failure-honesty test only). No-op if the
   *  extension is unavailable. */
  loseContextForTest(): void {
    const ext = this.gl?.getExtension('WEBGL_lose_context');
    if (ext) { this.lost = true; ext.loseContext(); }
  }

  private init(): void {
    const gl = this.canvas.getContext('webgl2', {
      antialias: false,
      preserveDrawingBuffer: false,
    }) as WebGL2RenderingContext | null;
    if (!gl) {
      this.reason = 'WebGL2 not available';
      return;
    }
    if (!gl.getExtension('EXT_color_buffer_float')) {
      this.reason = 'EXT_color_buffer_float not available (no float render targets)';
      return;
    }
    this.gl = gl;
    // Watch for driver context loss so a mid-render loss can fall back to CPU.
    (this.canvas as { addEventListener?: (t: string, cb: () => void) => void })
      .addEventListener?.('webglcontextlost', () => { this.lost = true; });
    try {
      this.program = this.buildProgram(gl);
      this.buildQuad(gl);
    } catch (e) {
      this.reason = `shader/program build failed: ${(e as Error).message}`;
      this.gl = null;
    }
  }

  private buildProgram(gl: WebGL2RenderingContext): WebGLProgram {
    const vs = this.compile(gl, gl.VERTEX_SHADER, VERTEX_SRC);
    const fs = this.compile(gl, gl.FRAGMENT_SHADER, fragmentSource());
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(`link: ${gl.getProgramInfoLog(prog)}`);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    // Cache uniform locations.
    const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(prog, i)!;
      const name = info.name.replace(/\[0\]$/, '');
      this.uniforms.set(name, gl.getUniformLocation(prog, name));
    }
    return prog;
  }

  private compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error(`compile: ${log}`);
    }
    return sh;
  }

  private buildQuad(gl: WebGL2RenderingContext): void {
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    // Two triangles as a strip covering clip space.
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.quadVao = vao;
  }

  private u(name: string): WebGLUniformLocation | null {
    return this.uniforms.get(name) ?? null;
  }

  private createDataTexture(gl: WebGL2RenderingContext, p: Payload): DataTex {
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA32F, p.width, p.height, 0,
      gl.RGBA, gl.FLOAT, p.data,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return { tex, width: p.width };
  }

  /** Upload an image atlas (UR16-4) as an RGBA8 TEXTURE_2D_ARRAY, LINEAR-filtered
   *  so the kernel's texture() sample matches the CPU bilinear. Always ≥ 1 layer. */
  private createAtlasTexture(gl: WebGL2RenderingContext, atlas: ImageAtlas): WebGLTexture {
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    gl.texImage3D(
      gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8, atlas.size, atlas.size, atlas.layers, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, atlas.data,
    );
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
    return tex;
  }

  private disposeScene(): void {
    const gl = this.gl;
    if (!gl || !this.scene) return;
    for (const dt of [this.scene.tris, this.scene.nodes, this.scene.triIdx, this.scene.mats, this.scene.uvs, this.scene.locals, this.scene.normals, this.scene.lights, this.scene.emit]) {
      gl.deleteTexture(dt.tex);
    }
    gl.deleteTexture(this.scene.atlas);
    if (this.scene.hdriTex) gl.deleteTexture(this.scene.hdriTex);
    this.scene = null;
  }

  /**
   * Upload a decoded HDRI (3 floats/pixel, linear light) as an RGB32F equirect
   * texture. NEAREST filtering + REPEAT in u / CLAMP in v mirror the CPU
   * sampleEquirect (floor-pixel lookup, wrapped seam, clamped poles) so the
   * GPU/CPU parity harness sees the same sky. Returns null when no HDRI.
   */
  private createHdriTexture(
    gl: WebGL2RenderingContext,
    img: import('../../core/scene/worldData').HdriImage | null,
  ): WebGLTexture | null {
    if (!img || img.width <= 0 || img.height <= 0) return null;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB32F, img.width, img.height, 0, gl.RGB, gl.FLOAT, img.data);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  /** Replace an existing data texture in place (delete old, upload new). */
  private reupload(gl: WebGL2RenderingContext, old: DataTex, p: Payload): DataTex {
    gl.deleteTexture(old.tex);
    return this.createDataTexture(gl, p);
  }

  /**
   * Upload a Snapshot. `incremental` (UR12-3 Ctrl+F12 path) re-packs ONLY the
   * categories whose signature changed vs the last upload — geometry (BVH+tris+
   * UVs), materials, lights, and the emissive CDF (geometry OR materials) — while
   * a camera/world-only change re-packs nothing. The default (F12 single render /
   * stages 1-2) always does a full rebuild, byte-identical to the old behavior.
   */
  setSnapshot(snap: Snapshot, incremental = false): void {
    if (!this.gl) return;
    const gl = this.gl;
    const world = snap.world ?? defaultSnapWorld();
    // Transparent film (UR16-3) — a plain uniform, updated on every snapshot.
    this.transparent = snap.transparent ?? false;

    if (!incremental || !this.scene) {
      // --- full build ---
      this.disposeScene();
      const bvh = snap.tris.length >= 9 ? buildBVH(snap.tris) : null;
      // Reuse the CPU emitter builder verbatim (area-weighted CDF, node-emitter
      // exclusion) so mesh-light NEE agrees with the CPU tracer.
      const emitters = buildEmitters(snap.tris, snap.triMat, snap.materials);
      const packed: PackedScene = packScene(snap, bvh, emitters);
      this.scene = {
        tris: this.createDataTexture(gl, packed.triangles),
        nodes: this.createDataTexture(gl, packed.bvh.nodes),
        nodeCount: packed.bvh.nodeCount,
        triIdx: this.createDataTexture(gl, packed.bvh.triIndices),
        mats: this.createDataTexture(gl, packed.materials),
        uvs: this.createDataTexture(gl, packed.uvs),
        locals: this.createDataTexture(gl, packed.locals),
        normals: this.createDataTexture(gl, packed.normals),
        lights: this.createDataTexture(gl, packed.lights),
        numLights: snap.lights.length,
        emit: this.createDataTexture(gl, packed.emitters.data),
        numEmitters: packed.emitters.count,
        emitTotalArea: packed.emitters.totalArea,
        atlas: this.createAtlasTexture(gl, packImageAtlas(snap.materials)),
        camera: snap.camera,
        world,
        hdriTex: this.createHdriTexture(gl, world.hdri),
        hdriSrc: world.hdri,
      };
      this.geoKey = geometrySignature(snap);
      this.matKey = materialsSignature(snap.materials);
      this.lightKey = lightsSignature(snap.lights);
      this.lastRepack = { geo: true, mat: true, light: true, emit: true };
      return;
    }

    // --- incremental: only re-pack what changed ---
    const s = this.scene;
    const geoKey = geometrySignature(snap);
    const matKey = materialsSignature(snap.materials);
    const lightKey = lightsSignature(snap.lights);
    const geo = geoKey !== this.geoKey;
    const mat = matKey !== this.matKey;
    const light = lightKey !== this.lightKey;
    const emit = geo || mat; // the emissive CDF depends on geometry AND materials

    if (geo) {
      const triCount = (snap.tris.length / 9) | 0;
      const bvh = snap.tris.length >= 9 ? buildBVH(snap.tris) : null;
      const flat = flattenBVH(bvh);
      s.tris = this.reupload(gl, s.tris, packTriangles(snap.tris, snap.triMat));
      s.nodes = this.reupload(gl, s.nodes, flat.nodes);
      s.nodeCount = flat.nodeCount;
      s.triIdx = this.reupload(gl, s.triIdx, flat.triIndices);
      s.uvs = this.reupload(gl, s.uvs, packUVs(snap.triUV, triCount));
      s.locals = this.reupload(gl, s.locals, packLocals(snap.triLocal, triCount));
      s.normals = this.reupload(gl, s.normals, packNormals(snap.triNormal, triCount));
    }
    if (mat) {
      s.mats = this.reupload(gl, s.mats, packMaterials(snap.materials));
      // UR16-4: a material change may add/replace an image → rebuild the atlas.
      gl.deleteTexture(s.atlas);
      s.atlas = this.createAtlasTexture(gl, packImageAtlas(snap.materials));
    }
    if (light) {
      s.lights = this.reupload(gl, s.lights, packLights(snap.lights));
      s.numLights = snap.lights.length;
    }
    if (emit) {
      const emitters = buildEmitters(snap.tris, snap.triMat, snap.materials);
      const pe = packEmitters(emitters);
      s.emit = this.reupload(gl, s.emit, pe.data);
      s.numEmitters = pe.count;
      s.emitTotalArea = pe.totalArea;
    }
    s.camera = snap.camera;
    s.world = world;
    // HDRI equirect: re-upload only when the decoded blob itself changed
    // (world edits are otherwise plain uniforms — the incremental contract).
    if (s.hdriSrc !== world.hdri) {
      if (s.hdriTex) gl.deleteTexture(s.hdriTex);
      s.hdriTex = this.createHdriTexture(gl, world.hdri);
      s.hdriSrc = world.hdri;
    }
    this.geoKey = geoKey;
    this.matKey = matKey;
    this.lightKey = lightKey;
    this.lastRepack = { geo, mat, light, emit };
  }

  private ensureAccum(gl: WebGL2RenderingContext, w: number, h: number): void {
    if (this.accumW === w && this.accumH === h && this.accumTex[0]) return;
    for (let i = 0; i < 2; i++) {
      if (this.accumTex[i]) gl.deleteTexture(this.accumTex[i]);
      if (this.accumFbo[i]) gl.deleteFramebuffer(this.accumFbo[i]);
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      this.accumTex[i] = tex;
      this.accumFbo[i] = fbo;
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.accumW = w;
    this.accumH = h;
  }

  private bindDataTex(gl: WebGL2RenderingContext, unit: number, dt: DataTex, sampler: string, widthU: string): void {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, dt.tex);
    gl.uniform1i(this.u(sampler), unit);
    gl.uniform1i(this.u(widthU), dt.width);
  }

  /**
   * Render `samples` progressive passes at `w × h`. Returns an RGBA Float32Array
   * (w*h*4): rgb = radiance AVERAGED over samples, a = hit fraction (0..1). When
   * `jitter` is false, rays are shot through pixel centers (deterministic — used
   * by renderHitMask so the mask matches the CPU center-ray mask).
   */
  /**
   * Bind the program, quad, all scene/camera/world uniforms and data textures for
   * a pass batch at `w × h`. Shared by the one-shot render() and the progressive
   * accumulate() path so they can never drift. Does NOT clear or set uSampleIndex
   * (the caller drives those per pass). Returns false when not renderable.
   */
  private bindScene(gl: WebGL2RenderingContext, w: number, h: number, jitter: boolean, seed: number): boolean {
    if (!this.program || !this.scene) return false;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.quadVao);

    const cam = this.scene.camera;
    gl.uniform3f(this.u('uEye'), cam.position[0], cam.position[1], cam.position[2]);
    gl.uniform3f(this.u('uForward'), cam.forward[0], cam.forward[1], cam.forward[2]);
    gl.uniform3f(this.u('uRight'), cam.right[0], cam.right[1], cam.right[2]);
    gl.uniform3f(this.u('uUp'), cam.up[0], cam.up[1], cam.up[2]);
    gl.uniform1f(this.u('uFovY'), cam.fovY);
    gl.uniform1f(this.u('uAperture'), cam.aperture ?? 0);
    gl.uniform1f(this.u('uFocus'), cam.focusDistance ?? 5);
    gl.uniform2f(this.u('uResolution'), w, h);
    gl.uniform1f(this.u('uJitter'), jitter ? 1 : 0);
    gl.uniform1f(this.u('uTransparent'), this.transparent ? 1 : 0);
    gl.uniform1ui(this.u('uFrameSeed'), seed >>> 0);
    gl.uniform1i(this.u('uNodeCount'), this.scene.nodeCount);
    gl.uniform1i(this.u('uNumLights'), this.scene.numLights);
    gl.uniform1i(this.u('uNumEmitters'), this.scene.numEmitters);
    gl.uniform1f(this.u('uEmitTotalArea'), this.scene.emitTotalArea);

    // World/sky: flat / gradient / hdri (equirect texture on unit 11;
    // hdri WITHOUT decoded pixels still falls back to the gradient).
    const wld = this.scene.world;
    gl.uniform1i(this.u('uWorldMode'), wld.mode);
    gl.uniform1i(this.u('uHasHdri'), this.scene.hdriTex ? 1 : 0);
    gl.activeTexture(gl.TEXTURE0 + 11);
    gl.bindTexture(gl.TEXTURE_2D, this.scene.hdriTex);
    gl.uniform1i(this.u('uHdri'), 11);
    gl.uniform3f(this.u('uWorldColor'), wld.color[0], wld.color[1], wld.color[2]);
    gl.uniform3f(this.u('uWorldHorizon'), wld.horizon[0], wld.horizon[1], wld.horizon[2]);
    gl.uniform3f(this.u('uWorldZenith'), wld.zenith[0], wld.zenith[1], wld.zenith[2]);
    gl.uniform1f(this.u('uWorldStrength'), wld.strength);

    // Data textures live on units 0..6; the prev-accum on unit 7; locals on 8; the
    // image atlas on 9; per-corner shading normals on 10.
    this.bindDataTex(gl, 0, this.scene.tris, 'uTris', 'uTrisW');
    this.bindDataTex(gl, 1, this.scene.nodes, 'uNodes', 'uNodesW');
    this.bindDataTex(gl, 2, this.scene.triIdx, 'uTriIdx', 'uTriIdxW');
    this.bindDataTex(gl, 3, this.scene.mats, 'uMats', 'uMatsW');
    this.bindDataTex(gl, 4, this.scene.uvs, 'uUVs', 'uUVsW');
    this.bindDataTex(gl, 5, this.scene.lights, 'uLights', 'uLightsW');
    this.bindDataTex(gl, 6, this.scene.emit, 'uEmit', 'uEmitW');
    this.bindDataTex(gl, 8, this.scene.locals, 'uLocals', 'uLocalsW');
    // UR16-5 per-corner shading normals on unit 10.
    this.bindDataTex(gl, 10, this.scene.normals, 'uNormals', 'uNormalsW');
    gl.uniform1i(this.u('uPrevAccum'), 7);
    // UR16-4 image atlas on unit 9 (TEXTURE_2D_ARRAY).
    gl.activeTexture(gl.TEXTURE0 + 9);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.scene.atlas);
    gl.uniform1i(this.u('uAtlas'), 9);
    return true;
  }

  /** Flip readPixels rows (bottom-up) to row 0 = TOP and scale by `inv`. */
  private flipScale(raw: Float32Array, w: number, h: number, inv: number): Float32Array {
    const buf = new Float32Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      const srcRow = (h - 1 - y) * w * 4;
      const dstRow = y * w * 4;
      for (let x = 0; x < w * 4; x++) buf[dstRow + x] = raw[srcRow + x] * inv;
    }
    return buf;
  }

  render(w: number, h: number, samples = 16, seed = 1, jitter = true): Float32Array | null {
    const gl = this.gl;
    if (!gl || !this.program || !this.scene) return null;
    this.ensureAccum(gl, w, h);

    // Clear the initial source target to zero.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.accumFbo[0]);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    this.bindScene(gl, w, h, jitter, seed);

    let src = 0;
    let dst = 1;
    for (let i = 0; i < samples; i++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.accumFbo[dst]);
      gl.uniform1i(this.u('uSampleIndex'), i);
      gl.activeTexture(gl.TEXTURE7);
      gl.bindTexture(gl.TEXTURE_2D, this.accumTex[src]);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      const tmp = src; src = dst; dst = tmp;
    }

    // The final sum lives in accumTex[src] (last write, then swapped).
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.accumFbo[src]);
    const raw = new Float32Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, raw);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);

    // readPixels rows are bottom-up; flip to row 0 = TOP (image-natural, matching
    // the CPU accum layout) while averaging rgb over samples (alpha → hit
    // fraction).
    return this.flipScale(raw, w, h, samples > 0 ? 1 / samples : 0);
  }

  // --- progressive accumulation (UR12-3) -------------------------------------
  // The render window + Ctrl+F12 GPU path accumulate samples across many small
  // calls so the UI stays live: begin once, accumulate(batch) repeatedly, and
  // readback at a steady ~4 Hz cadence (NOT per sample). Because each pass adds
  // sample i (i = 0,1,2,… in order) to the running float sum, the total after N
  // samples is BIT-IDENTICAL regardless of how it was batched — so a fixed-spp
  // Ctrl+F12 frame re-renders to the same bytes (determinism), and a progressive
  // F12 render at a given sample count matches render() at that count.

  /** Start a progressive render at `w × h`: allocate/clear the accum targets and
   *  reset the sample counter. Returns false when not renderable. */
  beginProgressive(w: number, h: number, seed = 1): boolean {
    const gl = this.gl;
    if (!gl || !this.program || !this.scene) return false;
    this.ensureAccum(gl, w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.accumFbo[0]);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.progW = w;
    this.progH = h;
    this.progSeed = seed >>> 0;
    this.progSamples = 0;
    this.progSrc = 0;
    return true;
  }

  /** Accumulate `n` more sample passes onto the progressive buffer. */
  accumulate(n: number): void {
    const gl = this.gl;
    if (!gl || !this.scene || n <= 0) return;
    if (!this.bindScene(gl, this.progW, this.progH, true, this.progSeed)) return;
    let src = this.progSrc;
    let dst = 1 - src;
    for (let i = 0; i < n; i++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.accumFbo[dst]);
      gl.uniform1i(this.u('uSampleIndex'), this.progSamples + i);
      gl.activeTexture(gl.TEXTURE7);
      gl.bindTexture(gl.TEXTURE_2D, this.accumTex[src]);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      const tmp = src; src = dst; dst = tmp;
    }
    this.progSamples += n;
    this.progSrc = src;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
  }

  /** Total samples accumulated in the current progressive render. */
  get accumulatedSamples(): number {
    return this.progSamples;
  }

  /** Read the current progressive accumulation back as an RGBA Float32Array
   *  (w*h*4): rgb = radiance AVERAGED over the samples so far, a = hit fraction.
   *  Row 0 = TOP (image-natural). null before any accumulate(). */
  readbackProgressive(): Float32Array | null {
    const gl = this.gl;
    if (!gl || this.progSamples === 0) return null;
    const w = this.progW, h = this.progH;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.accumFbo[this.progSrc]);
    const raw = new Float32Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, raw);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return this.flipScale(raw, w, h, 1 / this.progSamples);
  }

  /**
   * Render exactly `samples` spp progressively and return the averaged RGBA
   * buffer — the deterministic fixed-spp path used by Ctrl+F12 per-frame renders.
   * `onBatch` (optional) is called after each batch so the caller can update
   * progress / check a cancel flag; return false from it to abort (→ null).
   * `batch` controls responsiveness (default = all at once).
   */
  renderProgressive(
    w: number, h: number, samples: number, seed = 1,
    onBatch?: (done: number, total: number) => boolean,
    batch = samples,
  ): Float32Array | null {
    if (!this.beginProgressive(w, h, seed)) return null;
    const step = Math.max(1, batch);
    while (this.progSamples < samples) {
      if (this.contextLost) return null;
      this.accumulate(Math.min(step, samples - this.progSamples));
      if (onBatch && !onBatch(this.progSamples, samples)) return null;
    }
    return this.readbackProgressive();
  }

  /**
   * Binary hit mask at `w × h`: 1 where a pixel-center primary ray hits geometry,
   * 0 elsewhere. Deterministic (center rays, one sample). Mirrors the CPU
   * `renderHitMask` in tracer.ts so the two can be compared for traversal parity.
   */
  renderHitMask(w: number, h: number): Uint8Array | null {
    const buf = this.render(w, h, 1, 1, false);
    if (!buf) return null;
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) mask[i] = buf[i * 4 + 3] > 0.5 ? 1 : 0;
    return mask;
  }

  dispose(): void {
    const gl = this.gl;
    if (!gl) return;
    this.disposeScene();
    for (let i = 0; i < 2; i++) {
      if (this.accumTex[i]) gl.deleteTexture(this.accumTex[i]);
      if (this.accumFbo[i]) gl.deleteFramebuffer(this.accumFbo[i]);
    }
    if (this.program) gl.deleteProgram(this.program);
    if (this.quadVao) gl.deleteVertexArray(this.quadVao);
  }
}
