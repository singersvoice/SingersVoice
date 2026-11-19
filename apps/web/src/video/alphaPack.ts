import { CanvasTrack, handFedTracks } from './canvasTrack.ts';
import { SHARPEN, upscaleFor } from './enhance.ts';

/**
 * Performer video travels between devices as an "alpha-packed" frame: the left half is the
 * person over black, the right half is the alpha mask as grey. Video codecs carry no alpha, and
 * packing it this way survives compression far better than chroma keying; the receiver's
 * AlphaUnpacker turns it back into a transparent person with one tiny WebGL shader.
 */
export class AlphaPacker {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private timer: ReturnType<typeof setInterval> | undefined;
  private stream: MediaStream | null = null;
  private track: CanvasTrack | null = null;

  constructor(
    readonly width = 320,
    readonly height = 426,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = width * 2;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext('2d', { alpha: false })!;
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, width * 2, height);
  }

  /**
   * Repack from the person canvas + grey mask at `fps`; returns the stream to send. The track is fed
   * frame by frame (CanvasTrack), so the other singers keep getting this one's picture while the tab
   * is hidden (a canvas capture would freeze on the last rendered frame).
   */
  start(person: HTMLCanvasElement, mask: HTMLCanvasElement, fps = 15): MediaStream {
    this.stop();
    const c = this.ctx;
    const { width, height } = this;
    const track = new CanvasTrack(this.canvas, fps);
    this.track = track;
    const draw = () => {
      c.fillStyle = '#000';
      c.fillRect(0, 0, width * 2, height);
      c.drawImage(person, 0, 0, width, height);
      c.drawImage(mask, width, 0, width, height);
      track.push();
    };
    draw();
    this.timer = setInterval(draw, 1000 / fps);
    this.stream = new MediaStream([track.track]);
    return this.stream;
  }

  /**
   * The packed frames come from elsewhere (the feed worker): the track to send, and — where the browser has
   * hand-fed tracks — its writable, for the worker to feed (transfer it); where it has not, the worker's packed
   * frames are drawn in with `pushBitmap` and the track is the canvas capture.
   */
  startRemote(fps = 15): { stream: MediaStream; writable: WritableStream<VideoFrame> | null } {
    this.stop();
    const Gen = (globalThis as { MediaStreamTrackGenerator?: new (init: { kind: 'video' }) => MediaStreamTrack & { readonly writable: WritableStream<VideoFrame> } }).MediaStreamTrackGenerator;
    if (handFedTracks() && Gen) {
      const gen = new Gen({ kind: 'video' });
      this.remote = gen;
      this.stream = new MediaStream([gen]);
      return { stream: this.stream, writable: gen.writable };
    }
    const track = this.canvas.captureStream(fps).getVideoTracks()[0]!;
    this.remote = track;
    this.stream = new MediaStream([track]);
    return { stream: this.stream, writable: null };
  }

  /** A packed frame made elsewhere (closed here once drawn). */
  pushBitmap(bitmap: ImageBitmap): void {
    try {
      this.ctx.drawImage(bitmap, 0, 0, this.width * 2, this.height);
    } finally {
      bitmap.close();
    }
  }

  private remote: MediaStreamTrack | null = null;

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.track?.stop();
    this.track = null;
    this.remote?.stop();
    this.remote = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}

const VS = `attribute vec2 p; varying vec2 v; void main(){ v = vec2((p.x+1.0)*0.5, (1.0-p.y)*0.5); gl_Position = vec4(p,0.0,1.0); }`;
// The person's half, sampled bicubically (Catmull-Rom, nine bilinear taps) when the frame is drawn larger than it
// arrived, bilinearly otherwise; then an unsharp mask on the luminance (the detail the codec softened, one texel
// wide, back by `k`); the taps keep to the left half (never the mask's grey). The mask travels as the grey right
// half of a lossy video: erode it by one texel (3×3 minimum) so codec ringing and the sliver of background the
// segmenter leaves around a person never show as a bright fringe once the cut-out stands huge on a show stage,
// then firm up the edge.
const FS = `#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D t; uniform vec2 u; uniform vec2 sz; uniform float k; uniform float bic; varying vec2 v;
float m(vec2 o){ return texture2D(t, vec2(0.5 + v.x*0.5, v.y) + o).r; }
vec2 lh(vec2 c){ return vec2(clamp(c.x, u.x * 0.5, 0.5 - u.x * 1.5), clamp(c.y, u.y * 0.5, 1.0 - u.y * 0.5)); }
vec3 px(vec2 c){ return texture2D(t, lh(c)).rgb; }
vec3 cubic(vec2 c){
  vec2 s = c * sz;
  vec2 t1 = floor(s - 0.5) + 0.5;
  vec2 f = s - t1;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 p0 = (t1 - 1.0) * u;
  vec2 p3 = (t1 + 2.0) * u;
  vec2 p12 = (t1 + w2 / w12) * u;
  vec3 r = vec3(0.0);
  r += px(vec2(p0.x, p0.y)) * w0.x * w0.y;
  r += px(vec2(p12.x, p0.y)) * w12.x * w0.y;
  r += px(vec2(p3.x, p0.y)) * w3.x * w0.y;
  r += px(vec2(p0.x, p12.y)) * w0.x * w12.y;
  r += px(vec2(p12.x, p12.y)) * w12.x * w12.y;
  r += px(vec2(p3.x, p12.y)) * w3.x * w12.y;
  r += px(vec2(p0.x, p3.y)) * w0.x * w3.y;
  r += px(vec2(p12.x, p3.y)) * w12.x * w3.y;
  r += px(vec2(p3.x, p3.y)) * w3.x * w3.y;
  return r;
}
float lum(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
void main(){
  vec2 pc = vec2(v.x*0.5, v.y);
  vec3 rgb = bic > 0.5 ? cubic(pc) : px(pc);
  float d = lum(px(pc)) - 0.25 * (lum(px(pc + vec2(-u.x, 0.0))) + lum(px(pc + vec2(u.x, 0.0))) + lum(px(pc + vec2(0.0, -u.y))) + lum(px(pc + vec2(0.0, u.y))));
  d = sign(d) * max(abs(d) - 0.01, 0.0);
  rgb = clamp(rgb + k * d, 0.0, 1.0);
  float a = m(vec2(0.0));
  a = min(a, min(min(m(vec2(-u.x, 0.0)), m(vec2(u.x, 0.0))), min(m(vec2(0.0, -u.y)), m(vec2(0.0, u.y)))));
  a = min(a, min(min(m(vec2(-u.x, -u.y)), m(vec2(u.x, -u.y))), min(m(vec2(-u.x, u.y)), m(vec2(u.x, u.y)))));
  a = smoothstep(0.2, 0.75, a);
  gl_FragColor = vec4(rgb, a);
}`;

/** A WebGL context drawn by software (SwiftShader, llvmpipe, Mesa's software paths): every texel fetched costs a CPU the stage needs elsewhere. */
export function softwareRenderer(gl: WebGLRenderingContext): boolean {
  try {
    const info = gl.getExtension('WEBGL_debug_renderer_info') as { UNMASKED_RENDERER_WEBGL: number } | null;
    const renderer = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    return /swiftshader|llvmpipe|softpipe|software/i.test(renderer);
  } catch {
    return false;
  }
}

/**
 * Turns a packed <video> back into an RGBA canvas (person over transparent) — at `upscale` times
 * the frame's own size (enhance.ts: a small frame drawn larger than it arrived is upscaled
 * bicubically here rather than bilinearly by whoever draws it), sharpened. WebGL1 is enough and
 * universally available; without it the left half is drawn through an oval so the performer is
 * still never a rectangle.
 */
export class AlphaUnpacker {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext | null;
  private tex: WebGLTexture | null = null;
  private fallback: CanvasRenderingContext2D | null = null;

  /** The size the frame is drawn at: `upscale` times its own — 1 where the GPU is software (the enhancement is not for a renderer that would pay for it in frames). */
  readonly upscale: number;
  /** Whether the sharpening and the bicubic upscale are on (off on a software renderer). */
  readonly enhanced: boolean;

  constructor(
    readonly width = 320,
    readonly height = 426,
    upscale = 1,
  ) {
    this.canvas = document.createElement('canvas');
    // The frame is read by whoever draws it (the stage, a recorder), in their own loops: keep it until the next draw.
    this.gl = this.canvas.getContext('webgl', { premultipliedAlpha: false, alpha: true, antialias: false, preserveDrawingBuffer: true }) as WebGLRenderingContext | null;
    this.enhanced = this.gl !== null && !softwareRenderer(this.gl);
    this.upscale = this.enhanced ? upscale : 1;
    this.canvas.width = width * this.upscale;
    this.canvas.height = height * this.upscale;
    if (this.gl) this.setup(this.gl);
    else this.fallback = this.canvas.getContext('2d')!;
  }

  private setup(gl: WebGLRenderingContext): void {
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.uniform1i(gl.getUniformLocation(prog, 't'), 0);
    gl.uniform2f(gl.getUniformLocation(prog, 'u'), 1 / (this.width * 2), 1 / this.height);
    gl.uniform2f(gl.getUniformLocation(prog, 'sz'), this.width * 2, this.height);
    gl.uniform1f(gl.getUniformLocation(prog, 'k'), this.enhanced ? SHARPEN : 0);
    gl.uniform1f(gl.getUniformLocation(prog, 'bic'), this.upscale > 1 ? 1 : 0);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  /** Unpack the current frame of `video` (packed 2W×H) into `canvas`. */
  draw(video: HTMLVideoElement): void {
    if (video.readyState < 2 || !video.videoWidth) return;
    const gl = this.gl;
    if (gl && this.tex) {
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);
      } catch {
        return;
      }
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return;
    }
    const c = this.fallback!;
    const width = this.canvas.width;
    const height = this.canvas.height;
    c.save();
    c.clearRect(0, 0, width, height);
    const g = c.createRadialGradient(width / 2, height * 0.42, Math.min(width, height) * 0.18, width / 2, height * 0.5, Math.min(width, height) * 0.62);
    g.addColorStop(0, 'rgba(0,0,0,1)');
    g.addColorStop(0.75, 'rgba(0,0,0,1)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, width, height);
    c.globalCompositeOperation = 'source-in';
    c.drawImage(video, 0, 0, video.videoWidth / 2, video.videoHeight, 0, 0, width, height);
    c.restore();
  }

  dispose(): void {
    const gl = this.gl;
    if (gl && this.tex) gl.deleteTexture(this.tex);
    this.tex = null;
    this.gl = null;
  }
}

/**
 * One remote performer's frames as RGBA, shared by everything that draws them (the room's stage,
 * the show recorder): the packed video is unpacked once per frame, whoever asks first.
 */
export class UnpackedFrame {
  private unpacker: AlphaUnpacker | null = null;
  private lastTime = -1;

  constructor(readonly video: HTMLVideoElement) {}

  /** The video's clock — advancing means frames are arriving. */
  get currentTime(): number {
    return this.video.currentTime;
  }

  /** The RGBA canvas of the current frame, or null until the video has one; through a seek or a stall, the last frame drawn (never a flash of nobody). */
  current(): HTMLCanvasElement | null {
    const v = this.video;
    if (v.readyState < 2 || !v.videoWidth) return this.unpacker?.canvas ?? null;
    const w = Math.round(v.videoWidth / 2);
    // The frame's size can change mid-stream (a link the browser scaled down, or back up): the unpacker follows it.
    if (this.unpacker && (this.unpacker.width !== w || this.unpacker.height !== v.videoHeight)) {
      this.unpacker.dispose();
      this.unpacker = null;
      this.lastTime = -1;
    }
    if (!this.unpacker) this.unpacker = new AlphaUnpacker(w, v.videoHeight, upscaleFor(w));
    if (v.currentTime !== this.lastTime) {
      this.lastTime = v.currentTime;
      this.unpacker.draw(v);
    }
    return this.unpacker.canvas;
  }

  dispose(): void {
    this.unpacker?.dispose();
    this.unpacker = null;
  }
}
