import { Shader } from '../gl/Shader';
import { Mat4 } from '../../core/math/mat4';
import { Vec3 } from '../../core/math/vec3';

/**
 * Real-time shadow maps for the Rendered viewport (speed over quality): one
 * depth-only render of the visible meshes per shadow-casting light — suns get
 * an orthographic map framing the scene, spots a perspective map matching
 * their cone. Up to SHADOW_SLOTS casters per frame (extra lights simply don't
 * shadow); point lights never cast here (they'd need a cube map — the F12
 * tracer covers them). Each slot's texture is created with
 * COMPARE_REF_TO_TEXTURE + LINEAR so the RenderedPass samples it as a
 * sampler2DShadow — free 2×2 hardware PCF, no manual filtering.
 */

export const SHADOW_MAP_SIZE = 1024;
export const SHADOW_SLOTS = 4;
/** Point lights: cube maps — 6 depth renders each, so fewer/smaller slots. */
export const CUBE_SHADOW_SLOTS = 2;
export const CUBE_SHADOW_SIZE = 512;

const VERT = /* glsl */ `#version 300 es
layout(location = 0) in vec3 a_position;
uniform mat4 u_vp;    // light's view-projection
uniform mat4 u_model;
void main() {
  gl_Position = u_vp * u_model * vec4(a_position, 1.0);
}`;

// Depth-only: no color attachment, so the fragment shader writes nothing.
const FRAG = /* glsl */ `#version 300 es
precision mediump float;
void main() {}`;

/** Any up not parallel to the aim direction, for lookAt framing. */
function safeUp(dir: Vec3): Vec3 {
  return Math.abs(dir.z) > 0.99 ? new Vec3(0, 1, 0) : new Vec3(0, 0, 1);
}

/**
 * Sun: ortho view-projection that frames a bounding sphere (center, radius)
 * from `dir` — the light's aim direction. Geometry outside the box is treated
 * as lit by the sampling shader.
 */
export function sunShadowMatrix(dir: Vec3, center: Vec3, radius: number): Mat4 {
  const r = Math.max(radius, 1e-3);
  const eye = center.sub(dir.scale(r * 2));
  const view = Mat4.lookAt(eye, center, safeUp(dir));
  const proj = Mat4.ortho(-r, r, -r, r, r * 0.5, r * 3.5);
  return proj.mul(view);
}

/**
 * Spot: perspective view-projection from the light's apex along its aim.
 * `spotAngle` is the cone's full apex angle (matching LightData.spotAngle);
 * the map's fov gets a 15% margin so PCF at the cone edge doesn't clip. `far`
 * should reach past the receiving geometry (scene-bounds distance).
 */
export function spotShadowMatrix(pos: Vec3, dir: Vec3, spotAngle: number, far: number): Mat4 {
  const fov = Math.min(spotAngle * 1.15, 3.0);
  const view = Mat4.lookAt(pos, pos.add(dir), safeUp(dir));
  const proj = Mat4.perspective(fov, 1, 0.05, Math.max(far, 0.1));
  return proj.mul(view);
}

/**
 * View matrices for the six cube-map faces at `pos` (GL cube-map convention —
 * these orientations make a WORLD-space direction vector sample the face that
 * was rendered with the matching view). Paired with a 90° fov, aspect-1
 * perspective projection.
 */
export function cubeFaceView(pos: Vec3, face: number): Mat4 {
  const dirs: [Vec3, Vec3][] = [
    [new Vec3(1, 0, 0), new Vec3(0, -1, 0)],
    [new Vec3(-1, 0, 0), new Vec3(0, -1, 0)],
    [new Vec3(0, 1, 0), new Vec3(0, 0, 1)],
    [new Vec3(0, -1, 0), new Vec3(0, 0, -1)],
    [new Vec3(0, 0, 1), new Vec3(0, -1, 0)],
    [new Vec3(0, 0, -1), new Vec3(0, -1, 0)],
  ];
  const [dir, up] = dirs[face];
  return Mat4.lookAt(pos, pos.add(dir), up);
}

/** Depth-only renders into per-slot shadow maps; RenderedPass samples them. */
export class ShadowPass {
  private readonly shader: Shader;
  private readonly fbos: WebGLFramebuffer[] = [];
  /** Depth textures with compare mode set — always safe as sampler2DShadow. */
  readonly textures: WebGLTexture[] = [];
  /** Cube depth maps for point lights — always safe as samplerCubeShadow. */
  readonly cubeTextures: WebGLTexture[] = [];
  private readonly cubeFbos: WebGLFramebuffer[] = [];

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.shader = new Shader(gl, VERT, FRAG, 'shadow-depth');

    for (let i = 0; i < SHADOW_SLOTS; i++) {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, SHADOW_MAP_SIZE, SHADOW_MAP_SIZE, 0,
        gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null,
      );
      // COMPARE_REF_TO_TEXTURE + LINEAR = hardware PCF via sampler2DShadow.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.textures.push(tex);

      const fbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, tex, 0);
      gl.drawBuffers([gl.NONE]);
      gl.readBuffer(gl.NONE);
      this.fbos.push(fbo);
    }

    for (let i = 0; i < CUBE_SHADOW_SLOTS; i++) {
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_CUBE_MAP, tex);
      for (let f = 0; f < 6; f++) {
        gl.texImage2D(
          gl.TEXTURE_CUBE_MAP_POSITIVE_X + f, 0, gl.DEPTH_COMPONENT24,
          CUBE_SHADOW_SIZE, CUBE_SHADOW_SIZE, 0,
          gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null,
        );
      }
      gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
      gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
      gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.cubeTextures.push(tex);
      // One FBO per cube; beginCubeFace re-attaches the target face each pass.
      this.cubeFbos.push(gl.createFramebuffer()!);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Bind cube slot `i`'s FBO targeting `face` (0-5) and clear it. */
  beginCubeFace(slot: number, face: number, lightViewProj: Mat4): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.cubeFbos[slot]);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT,
      gl.TEXTURE_CUBE_MAP_POSITIVE_X + face, this.cubeTextures[slot], 0,
    );
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);
    gl.viewport(0, 0, CUBE_SHADOW_SIZE, CUBE_SHADOW_SIZE);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(2, 4);
    this.shader.use();
    this.shader.setMat4('u_vp', lightViewProj);
  }

  /** Bind slot `i`'s FBO and clear it. Polygon offset stands in for a fancy bias. */
  begin(slot: number, lightViewProj: Mat4): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbos[slot]);
    gl.viewport(0, 0, SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(2, 4);
    this.shader.use();
    this.shader.setMat4('u_vp', lightViewProj);
  }

  setObject(model: Mat4): void {
    this.shader.setMat4('u_model', model);
  }

  /** Back to the default framebuffer at viewport size. */
  end(canvasWidth: number, canvasHeight: number): void {
    const gl = this.gl;
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvasWidth, canvasHeight);
  }
}
