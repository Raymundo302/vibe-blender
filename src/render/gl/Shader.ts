import type { Mat4 } from '../../core/math/mat4';
import type { Vec3 } from '../../core/math/vec3';

/** Compiled+linked GLSL program with cached uniform locations. */
export class Shader {
  private readonly program: WebGLProgram;
  private readonly uniforms = new Map<string, WebGLUniformLocation | null>();

  constructor(
    private readonly gl: WebGL2RenderingContext,
    vertSrc: string,
    fragSrc: string,
    readonly name = 'shader',
  ) {
    const vs = this.compile(gl.VERTEX_SHADER, vertSrc);
    const fs = this.compile(gl.FRAGMENT_SHADER, fragSrc);
    const program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`[${name}] link failed: ${gl.getProgramInfoLog(program)}`);
    }
    this.program = program;
  }

  private compile(type: number, src: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, src.trim());
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const kind = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment';
      throw new Error(`[${this.name}] ${kind} compile failed: ${gl.getShaderInfoLog(shader)}`);
    }
    return shader;
  }

  use(): void {
    this.gl.useProgram(this.program);
  }

  private loc(name: string): WebGLUniformLocation | null {
    if (!this.uniforms.has(name)) {
      this.uniforms.set(name, this.gl.getUniformLocation(this.program, name));
    }
    return this.uniforms.get(name)!;
  }

  setMat4(name: string, m: Mat4): void { this.gl.uniformMatrix4fv(this.loc(name), false, m.m); }
  setMat3(name: string, m: Float32Array): void { this.gl.uniformMatrix3fv(this.loc(name), false, m); }
  setVec3(name: string, v: Vec3): void { this.gl.uniform3f(this.loc(name), v.x, v.y, v.z); }
  setVec4(name: string, x: number, y: number, z: number, w: number): void {
    this.gl.uniform4f(this.loc(name), x, y, z, w);
  }
  setVec2(name: string, x: number, y: number): void { this.gl.uniform2f(this.loc(name), x, y); }
  setFloat(name: string, v: number): void { this.gl.uniform1f(this.loc(name), v); }
  setInt(name: string, v: number): void { this.gl.uniform1i(this.loc(name), v); }
  /** Upload a mat4[] uniform array from a packed column-major Float32Array. */
  setMat4Array(name: string, m: Float32Array): void {
    this.gl.uniformMatrix4fv(this.loc(name), false, m);
  }
  /** Upload a vec4[] uniform array from a packed Float32Array. */
  setVec4Array(name: string, v: Float32Array): void {
    this.gl.uniform4fv(this.loc(name), v);
  }
}
