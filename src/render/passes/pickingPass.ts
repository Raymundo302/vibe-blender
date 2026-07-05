import { Shader } from '../gl/Shader';
import { Framebuffer } from '../gl/Framebuffer';
import type { Mat4 } from '../../core/math/mat4';

/**
 * GPU color-ID picking (architecture decision A3): every pickable thing is
 * rendered in a unique flat color to an offscreen buffer; reading the pixel
 * under the cursor identifies what was clicked. id 0 = background, so object
 * ids are encoded offset by 1.
 */

const VERT = /* glsl */ `#version 300 es
layout(location = 0) in vec3 a_position;
uniform mat4 u_mvp;
void main() { gl_Position = u_mvp * vec4(a_position, 1.0); }`;

const FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform vec4 u_idColor;
out vec4 outColor;
void main() { outColor = u_idColor; }`;

export function encodeId(id: number): [number, number, number, number] {
  return [(id & 0xff) / 255, ((id >> 8) & 0xff) / 255, ((id >> 16) & 0xff) / 255, 1];
}

export function decodeId(px: Uint8Array): number {
  return px[0] | (px[1] << 8) | (px[2] << 16);
}

export class PickingPass {
  private readonly shader: Shader;
  private readonly fbo: Framebuffer;

  constructor(private readonly gl: WebGL2RenderingContext, width: number, height: number) {
    this.shader = new Shader(gl, VERT, FRAG, 'picking');
    this.fbo = new Framebuffer(gl, width, height, true);
  }

  resize(width: number, height: number): void {
    this.fbo.resize(width, height);
  }

  begin(): void {
    const gl = this.gl;
    this.fbo.bind();
    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    this.shader.use();
  }

  drawObject(mvp: Mat4, pickId: number): void {
    const [r, g, b, a] = encodeId(pickId);
    this.shader.setMat4('u_mvp', mvp);
    this.shader.setVec4('u_idColor', r, g, b, a);
  }

  end(canvasWidth: number, canvasHeight: number): void {
    this.fbo.unbind();
    this.gl.viewport(0, 0, canvasWidth, canvasHeight);
  }

  /** Read the pick id at device-pixel coords (y from top). 0 = nothing. */
  read(x: number, y: number): number {
    return decodeId(this.fbo.readPixel(x, this.fbo.height - 1 - y));
  }
}
