import { Shader } from '../gl/Shader';
import { EmptyVao } from '../gl/VertexArray';
import { Framebuffer, floatColorRenderable, type FboFormat } from '../gl/Framebuffer';
import type { Mat4 } from '../../core/math/mat4';

/**
 * Screen-space ambient occlusion for the shaded viewport modes (the "AO"
 * checkbox in the shading dropdown). Three stages per frame when enabled:
 *
 *   1. prepass — the visible meshes into a canvas-sized target that writes BOTH
 *      a depth texture AND view-space normals into an RGBA8 color attachment
 *      (normal*0.5+0.5). Real geometric normals, not screen derivatives.
 *   2. GTAO — fullscreen horizon-based integrator (Jimenez 2016 "Ground-Truth
 *      AO"). For SLICES screen-space directions rotated per-pixel by Interleaved
 *      Gradient Noise, it marches STEPS/side finding the maximum horizon cosine,
 *      then integrates the cosine-weighted visible arc in closed form. This is a
 *      CONTINUOUS scalar in [0,1] — no k/N discrete levels — which is the cure
 *      for the "gradient wave" banding the old 16-sample scattered kernel showed.
 *      Output is a single-channel R8 (with ±0.5-LSB IGN dither) or R16F target.
 *   3. denoise — a 5×5 depth-aware bilateral whose edge weight is the sample's
 *      distance to the CENTER's tangent plane (predicted from depth+normal). A
 *      plane-relative weight survives grazing/receding floors where the old
 *      fixed abs(z-diff) threshold rejected every tap, leaving raw bands.
 *
 * The shaded passes then multiply their color by the denoised AO, sampled by
 * gl_FragCoord. Deliberately "viewport cavity" quality — not a beauty render.
 *
 * References: Jimenez et al. 2016 (GTAO), Intel XeGTAO, IGN (Jimenez CoD:AW 2014).
 */

const SLICES = 3;      // horizon directions per pixel (spp = 2*SLICES*STEPS)
const STEPS = 8;       // march steps per side
const BLUR_TAPS = 6;   // separable denoise: taps each side, each blur pass

const PRE_VERT = /* glsl */ `#version 300 es
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec3 a_normal;
uniform mat4 u_model;
uniform mat4 u_view;
uniform mat4 u_proj;
uniform mat3 u_normalMat; // view-space normal matrix (view * model)
out vec3 v_viewNormal;
void main() {
  v_viewNormal = u_normalMat * a_normal;
  gl_Position = u_proj * u_view * u_model * vec4(a_position, 1.0);
}`;

const PRE_FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec3 v_viewNormal;
out vec4 outNormal;
void main() {
  // Face the camera (view -Z) so both winding sides give a consistent normal.
  vec3 n = normalize(v_viewNormal);
  if (n.z < 0.0) n = -n;
  outNormal = vec4(n * 0.5 + 0.5, 1.0);
}`;

const FS_VERT = /* glsl */ `#version 300 es
void main() {
  vec2 pos = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}`;

// GTAO-lite horizon integrator. Continuous visibility per pixel, IGN jitter,
// output-dithered to hide the 8-bit write on wide soft gradients.
const GTAO_FRAG = /* glsl */ `#version 300 es
precision highp float;
// highp samplers are ESSENTIAL: sampler2D defaults to lowp in ES fragment
// shaders and AMD drivers honor it — depth read through fp16 reconstructs
// points centimetres off a flat surface (row-banded streaks on real GPUs;
// SwiftShader samples fp32 regardless, so the e2e rig can't catch it).
uniform highp sampler2D u_depth;     // depth prepass (0..1 window depth)
uniform highp sampler2D u_normal;    // view-space normals (normal*0.5+0.5)
uniform mat4 u_proj;
uniform mat4 u_invProj;
uniform vec2 u_texel;          // 1 / canvas size
uniform vec2 u_size;           // canvas size in pixels
uniform float u_radius;        // world/view units
uniform float u_strength;      // darkening multiplier (0 = off, 1 = default)
uniform float u_dither;        // 1.0 for R8 (apply dither), 0.0 for R16F
out vec4 outColor;

const float PI = 3.14159265359;
const float HALF_PI = 1.57079632679;

// View-space position of the fragment at uv with window depth d.
vec3 viewPos(vec2 uv, float d) {
  vec4 ndc = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec4 p = u_invProj * ndc;
  return p.xyz / p.w;
}

// Interleaved Gradient Noise — per-pixel, deterministic, low-discrepancy.
float ign(vec2 p) {
  return fract(52.9829189 * fract(0.06711056 * p.x + 0.00583715 * p.y));
}

// Tiny elevation floor: a tap must be at least fractionally in front of the
// tangent plane (above it toward the viewer) to occlude at all.
const float AO_BIAS = 0.02;

// Ray-relative coplanarity band. A tap is treated as lying ON the center's
// tangent plane — and thus NOT an occluder — when the plane sits within this
// fraction along the tap's own view ray (see horizonTap). This is the cure for
// FLAT-SURFACE false self-occlusion: with exact depth a flat floor is coplanar
// everywhere (k == 1) and produces zero AO, but NEAREST/quantized depth jitters
// each tap ALONG its ray; a view-space elevation test amplifies that jitter into
// heavy occlusion stripes at grazing angles, whereas the ray-relative ratio k
// stays ~1 for a coplanar tap at ANY view angle. Real occluders (a cube wall, a
// torus rim) sit well off the plane (k far from 1) and still register.
const float AO_COPLANAR = 0.04;

// One marched tap: returns the horizon cosine it contributes (dot(dir,V)), or
// -1.0 (a no-op for the max) if it is background, self, coplanar with the center
// surface, below the tangent plane, or beyond the radius. A smooth distance
// falloff toward the radius edge replaces the old hard cutoff so near-radius
// quantized taps cannot snap a false horizon and no contact ring forms.
float horizonTap(vec2 suv, vec3 P, vec3 N, vec3 V, float invRadius) {
  float sd = texture(u_depth, suv).r;
  if (sd >= 1.0) return -1.0;                 // background
  vec3 sP = viewPos(suv, sd);
  vec3 dv = sP - P;
  float d2 = dot(dv, dv);
  if (d2 < 1e-8) return -1.0;                 // reads our own texel

  // Where does the center tangent plane sit along THIS tap's view ray? Both P's
  // plane and the ray pass through the origin's frame, so k = dot(P,N)/dot(sP,N)
  // equals 1 exactly when sP is on the plane. Depth quantization slides sP along
  // its ray, so a genuinely coplanar tap keeps k within a narrow band of 1
  // regardless of grazing — the well-conditioned coplanarity test.
  float denom = dot(sP, N);
  if (abs(denom) > 1e-4) {
    float k = dot(P, N) / denom;
    if (abs(k - 1.0) < AO_COPLANAR) return -1.0;   // on the plane → not an occluder
  }

  float invd = inversesqrt(d2);
  float above = dot(dv, N) * invd;            // sin(elevation above tangent plane)
  if (above <= AO_BIAS) return -1.0;          // below / level with the plane
  float r = sqrt(d2) * invRadius;
  if (r >= 1.0) return -1.0;                  // beyond the AO radius
  float falloff = 1.0 - smoothstep(0.5, 1.0, r);
  return mix(-1.0, dot(dv, V) * invd, falloff);
}

void main() {
  vec2 uv = gl_FragCoord.xy * u_texel;
  float d = texture(u_depth, uv).r;
  if (d >= 1.0) { outColor = vec4(1.0); return; } // background: unoccluded

  vec3 P = viewPos(uv, d);
  vec3 N = normalize(texture(u_normal, uv).xyz * 2.0 - 1.0);
  vec3 V = normalize(-P);           // view vector (toward camera)
  float viewDepth = -P.z;

  // Project the world-space radius to a screen march length in pixels at this
  // depth (u_proj[0][0] = 1/(aspect*tan(fov/2))). Clamp so big radii stay cheap
  // and small ones still cover a few pixels.
  float pxRadius = clamp(u_radius * u_proj[0][0] * 0.5 * u_size.x / max(viewDepth, 1e-3),
                         4.0, 180.0);

  float noiseDir = ign(gl_FragCoord.xy);                  // slice rotation [0,1)
  float noiseOff = fract(noiseDir * 1.6180339887 + 0.5);  // decorrelated step jitter

  float invRadius = 1.0 / max(u_radius, 1e-4);

  float visibility = 0.0;
  float weightSum = 0.0;

  for (int s = 0; s < ${SLICES}; s++) {
    float phi = (float(s) + noiseDir) * PI / float(${SLICES});
    vec2 omega = vec2(cos(phi), sin(phi));   // unit screen/pixel direction

    // View-space slice direction: unproject a neighbour along omega at the SAME
    // depth (cheap, no extra depth fetch), giving the in-plane marching axis.
    vec3 sliceVS = viewPos(uv + omega * u_texel, d) - P;
    if (dot(sliceVS, sliceVS) < 1e-12) continue;
    sliceVS = normalize(sliceVS);

    // Orthonormal 2D frame in the slice plane: axisV = V, axisT ⟂ V toward +omega.
    vec3 axisT = sliceVS - V * dot(sliceVS, V);
    float axisTLen = length(axisT);
    if (axisTLen < 1e-5) continue;
    axisT /= axisTLen;

    // Normal projected into the slice plane, and its signed angle gamma from V.
    vec3 sliceN = normalize(cross(axisT, V));   // plane normal
    vec3 projN = N - sliceN * dot(N, sliceN);
    float projLen = length(projN);
    if (projLen < 1e-4) continue;
    projN /= projLen;
    float gamma = atan(dot(projN, axisT), dot(projN, V));

    // Horizon cosines per side. Init -1 → no occluder → full visible arc.
    float cH0 = -1.0;   // +omega side
    float cH1 = -1.0;   // -omega side
    for (int k = 0; k < ${STEPS}; k++) {
      float t = (float(k) + noiseOff) / float(${STEPS}); // (0,1]
      vec2 offs = omega * (t * pxRadius) * u_texel;
      // Each side: a tap raises the horizon only if it clears the tangent-plane
      // bias and lies within the radius (distance falloff, no hard ring). The
      // bias rejects coplanar/quantized taps → a flat floor stays unoccluded;
      // the angular arc term still does the contact-shadow softening.
      cH0 = max(cH0, horizonTap(uv + offs, P, N, V, invRadius));
      cH1 = max(cH1, horizonTap(uv - offs, P, N, V, invRadius));
    }

    // Signed horizon angles, clamped to the hemisphere around the normal, then
    // the Jimenez cosine-weighted arc integral.
    float t1 =  acos(clamp(cH0, -1.0, 1.0)); // +side (positive)
    float t2 = -acos(clamp(cH1, -1.0, 1.0)); // -side (negative)
    float h1 = gamma + min(t1 - gamma,  HALF_PI);
    float h2 = gamma + max(t2 - gamma, -HALF_PI);
    float arc = 0.25 * (-cos(2.0 * h1 - gamma) + cos(gamma) + 2.0 * h1 * sin(gamma))
              + 0.25 * (-cos(2.0 * h2 - gamma) + cos(gamma) + 2.0 * h2 * sin(gamma));
    visibility += projLen * arc;
    weightSum += projLen;
  }

  visibility = weightSum > 0.0 ? visibility / weightSum : 1.0;
  visibility = clamp(visibility, 0.0, 1.0);

  // Fade AO out with distance so far geometry stays clean.
  visibility = mix(1.0, visibility, 1.0 - smoothstep(30.0, 60.0, viewDepth));

  // Deepen contacts a touch, then apply the strength slider (0 → off, 1 →
  // default, 2 → strong; clamped so heavy settings can't over-darken to black).
  float ao = pow(visibility, 1.15);
  ao = clamp(1.0 - (1.0 - ao) * u_strength, 0.0, 1.0);

  // ±0.5-LSB IGN dither before the 8-bit write turns residual quantization
  // steps into sub-perceptual noise. No-op for the R16F target (u_dither = 0).
  ao += (ign(gl_FragCoord.xy + 0.5) - 0.5) * (1.0 / 255.0) * u_dither;
  outColor = vec4(vec3(clamp(ao, 0.0, 1.0)), 1.0);
}`;

// Separable plane-aware Gaussian denoise (X pass then Y pass). Edge weight =
// the tap's distance to the CENTER's tangent plane (predicted from depth +
// normal), relative to depth — alive on receding/grazing floors, still
// silhouette/crease-preserving. Run at the half-res AO resolution the two
// 13-tap passes cover a ~24×24 canvas-pixel footprint, which is what melts
// the IGN stipple into the smooth Blender-like gradient.
const BLUR_FRAG = /* glsl */ `#version 300 es
precision highp float;
uniform highp sampler2D u_src;
uniform highp sampler2D u_depth;   // highp: see GTAO_FRAG — lowp default = fp16 depth on AMD
uniform highp sampler2D u_normal;
uniform mat4 u_invProj;
uniform vec2 u_dir;      // one-texel step along this pass's axis (x or y)
out vec4 outColor;

uniform vec2 u_texel;    // 1 / AO-resolution size (for gl_FragCoord → uv)

vec3 viewPos(vec2 uv, float d) {
  vec4 p = u_invProj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  return p.xyz / p.w;
}

void main() {
  vec2 uv = gl_FragCoord.xy * u_texel;
  float cd = texture(u_depth, uv).r;
  if (cd >= 1.0) { outColor = vec4(texture(u_src, uv).r); return; }
  vec3 cP = viewPos(uv, cd);
  vec3 cN = normalize(texture(u_normal, uv).xyz * 2.0 - 1.0);
  // Plane-distance tolerance scales with depth (relative), so a receding floor
  // whose neighbours differ a lot in z still blurs, while a real depth cliff or
  // crease (points off the plane) is rejected.
  float tol = 0.05 * abs(cP.z) + 0.01;

  float sum = texture(u_src, uv).r;
  float wsum = 1.0;
  for (int i = 1; i <= ${BLUR_TAPS}; i++) {
    float g = exp(-float(i * i) * 0.08);       // gaussian falloff, sigma ~2.5
    for (float side = -1.0; side <= 1.0; side += 2.0) {
      vec2 o = u_dir * (float(i) * side);
      float sd = texture(u_depth, uv + o).r;
      if (sd >= 1.0) continue;
      vec3 sP = viewPos(uv + o, sd);
      float planeDist = abs(dot(sP - cP, cN));
      float w = g * exp(-planeDist / tol);
      sum += texture(u_src, uv + o).r * w;
      wsum += w;
    }
  }
  outColor = vec4(vec3(sum / wsum), 1.0);
}`;

export class AoPass {
  private readonly preShader: Shader;
  private readonly gtaoShader: Shader;
  private readonly blurShader: Shader;
  private readonly fullscreen: EmptyVao;
  private readonly ssaoFbo: Framebuffer;
  private readonly blurFbo: Framebuffer;
  private readonly finalFbo: Framebuffer;
  private preFbo: WebGLFramebuffer;
  private depthTex: WebGLTexture;
  private normalTex: WebGLTexture;
  private width = 0;
  private height = 0;
  /** 'r16f' when EXT_color_buffer_float is present, else 'r8' (+ dither). */
  private aoFormat: FboFormat;
  /** 1×1 white — bound by the shaded passes when AO is off. */
  readonly white: WebGLTexture;

  constructor(private readonly gl: WebGL2RenderingContext, width: number, height: number) {
    this.preShader = new Shader(gl, PRE_VERT, PRE_FRAG, 'ao-prepass');
    this.gtaoShader = new Shader(gl, FS_VERT, GTAO_FRAG, 'ao-gtao');
    this.blurShader = new Shader(gl, FS_VERT, BLUR_FRAG, 'ao-blur');
    this.fullscreen = new EmptyVao(gl);

    // Single-channel AO targets: R16F removes 8-bit quantization outright where
    // the float-render extension exists; R8 + dither is the core fallback.
    // The whole AO chain runs at HALF the canvas resolution (like EEVEE's 1:2
    // raytracing) — 4× cheaper per tap, and the LINEAR upsample of the final
    // target is itself a smoothing stage. ssao = raw GTAO, blur = X-pass,
    // final = Y-pass (the texture the shaded passes multiply by).
    this.aoFormat = floatColorRenderable(gl) ? 'r16f' : 'r8';
    const aoW = Math.max(1, Math.round(width / 2));
    const aoH = Math.max(1, Math.round(height / 2));
    this.ssaoFbo = new Framebuffer(gl, aoW, aoH, false, this.aoFormat);
    this.blurFbo = new Framebuffer(gl, aoW, aoH, false, this.aoFormat);
    this.finalFbo = new Framebuffer(gl, aoW, aoH, false, this.aoFormat, true);

    this.white = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.white);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([255, 255, 255, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    // Depth + normal targets built by allocate (resize recreates them).
    this.depthTex = gl.createTexture()!;
    this.normalTex = gl.createTexture()!;
    this.preFbo = gl.createFramebuffer()!;
    this.allocateTargets(width, height);
  }

  /** True LSB dither is only meaningful for the 8-bit target. */
  private get ditherFlag(): number {
    return this.aoFormat === 'r8' ? 1 : 0;
  }

  /** Test hook: force the AO target format so e2e can exercise the R8 + dither
   *  path deterministically regardless of the headless GL's extension support. */
  overrideFormatForTest(format: FboFormat): void {
    this.aoFormat = format;
    this.ssaoFbo.setFormat(format);
    this.blurFbo.setFormat(format);
    this.finalFbo.setFormat(format);
  }

  private allocateTargets(width: number, height: number): void {
    const gl = this.gl;
    this.width = width;
    this.height = height;

    gl.bindTexture(gl.TEXTURE_2D, this.depthTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, width, height, 0,
      gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.bindTexture(gl.TEXTURE_2D, this.normalTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.preFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.depthTex, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.normalTex, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.allocateTargets(width, height);
    const aoW = Math.max(1, Math.round(width / 2));
    const aoH = Math.max(1, Math.round(height / 2));
    this.ssaoFbo.resize(aoW, aoH);
    this.blurFbo.resize(aoW, aoH);
    this.finalFbo.resize(aoW, aoH);
  }

  /** Stage 1: bind the prepass FBO; the Renderer then draws every mesh through
   *  setObject() and calls compute() to run stages 2+3. */
  beginDepth(view: Mat4, proj: Mat4): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.preFbo);
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(0.5, 0.5, 1.0, 1.0); // decodes to +Z; irrelevant (background rejected by depth)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    this.preShader.use();
    this.preShader.setMat4('u_view', view);
    this.preShader.setMat4('u_proj', proj);
  }

  setObject(model: Mat4, view: Mat4): void {
    this.preShader.setMat4('u_model', model);
    this.preShader.setMat3('u_normalMat', view.mul(model).normalMatrix());
  }

  /** Stages 2+3: GTAO from the depth+normal prepass, then the bilateral denoise.
   *  Leaves the default framebuffer bound at (canvasW, canvasH). */
  compute(proj: Mat4, invProj: Mat4, radius = 0.55, strength = 1): void {
    const gl = this.gl;
    const depthWasOn = gl.isEnabled(gl.DEPTH_TEST);
    gl.disable(gl.DEPTH_TEST);

    const aoW = this.ssaoFbo.width;
    const aoH = this.ssaoFbo.height;

    this.ssaoFbo.bind(); // sets the half-res viewport
    this.gtaoShader.use();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.depthTex);
    this.gtaoShader.setInt('u_depth', 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.normalTex);
    this.gtaoShader.setInt('u_normal', 1);
    gl.activeTexture(gl.TEXTURE0);
    this.gtaoShader.setMat4('u_proj', proj);
    this.gtaoShader.setMat4('u_invProj', invProj);
    this.gtaoShader.setVec2('u_texel', 1 / aoW, 1 / aoH);
    this.gtaoShader.setVec2('u_size', aoW, aoH);
    this.gtaoShader.setFloat('u_radius', radius);
    this.gtaoShader.setFloat('u_strength', strength);
    this.gtaoShader.setFloat('u_dither', this.ditherFlag);
    this.fullscreen.drawTriangles(3);

    // Separable plane-aware denoise: X pass into blurFbo, Y pass into finalFbo.
    const blurPass = (src: Framebuffer, dst: Framebuffer, dx: number, dy: number) => {
      dst.bind();
      this.blurShader.use();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.texture);
      this.blurShader.setInt('u_src', 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.depthTex);
      this.blurShader.setInt('u_depth', 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.normalTex);
      this.blurShader.setInt('u_normal', 2);
      gl.activeTexture(gl.TEXTURE0);
      this.blurShader.setMat4('u_invProj', invProj);
      this.blurShader.setVec2('u_texel', 1 / aoW, 1 / aoH);
      this.blurShader.setVec2('u_dir', dx / aoW, dy / aoH);
      this.fullscreen.drawTriangles(3);
    };
    blurPass(this.ssaoFbo, this.blurFbo, 1, 0);
    blurPass(this.blurFbo, this.finalFbo, 0, 1);

    this.finalFbo.unbind();
    gl.viewport(0, 0, this.width, this.height);
    if (depthWasOn) gl.enable(gl.DEPTH_TEST);
  }

  /** The denoised AO texture (valid after compute()) — half-res, LINEAR
   *  filtered, sampled by the shaded passes at normalized coordinates. */
  get texture(): WebGLTexture {
    return this.finalFbo.texture;
  }
}
