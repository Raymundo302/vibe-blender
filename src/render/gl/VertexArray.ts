export interface AttributeSpec {
  /** Attribute location in the shader (use layout(location = N)). */
  location: number;
  /** Components per vertex (e.g. 3 for vec3). */
  size: number;
  data: Float32Array;
}

/** VAO + owned vertex buffers for non-indexed drawing. */
export class VertexArray {
  private readonly vao: WebGLVertexArrayObject;
  private readonly buffers: WebGLBuffer[] = [];
  vertexCount: number;

  constructor(
    private readonly gl: WebGL2RenderingContext,
    attributes: AttributeSpec[],
  ) {
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    this.vertexCount = attributes.length ? attributes[0].data.length / attributes[0].size : 0;
    for (const attr of attributes) {
      const buf = gl.createBuffer()!;
      this.buffers.push(buf);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, attr.data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(attr.location);
      gl.vertexAttribPointer(attr.location, attr.size, gl.FLOAT, false, 0, 0);
    }
    gl.bindVertexArray(null);
  }

  draw(mode: number, count = this.vertexCount): void {
    this.gl.bindVertexArray(this.vao);
    this.gl.drawArrays(mode, 0, count);
    this.gl.bindVertexArray(null);
  }

  dispose(): void {
    for (const buf of this.buffers) this.gl.deleteBuffer(buf);
    this.gl.deleteVertexArray(this.vao);
  }
}

/**
 * Draw a fullscreen triangle with a shader that positions verts from
 * gl_VertexID (no attributes). Core profile still requires a bound VAO.
 */
export class EmptyVao {
  private readonly vao: WebGLVertexArrayObject;
  constructor(private readonly gl: WebGL2RenderingContext) {
    this.vao = gl.createVertexArray()!;
  }
  drawTriangles(count: number): void {
    this.gl.bindVertexArray(this.vao);
    this.gl.drawArrays(this.gl.TRIANGLES, 0, count);
    this.gl.bindVertexArray(null);
  }
}
