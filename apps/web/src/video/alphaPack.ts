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

  /** Repack from the person canvas + grey mask at `fps`; returns the stream to send. */
  start(person: HTMLCanvasElement, mask: HTMLCanvasElement, fps = 15): MediaStream {
    this.stop();
    const c = this.ctx;
    const { width, height } = this;
    const draw = () => {
      c.fillStyle = '#000';
      c.fillRect(0, 0, width * 2, height);
      c.drawImage(person, 0, 0, width, height);
      c.drawImage(mask, width, 0, width, height);
    };
    draw();
    this.timer = setInterval(draw, 1000 / fps);
    this.stream = this.canvas.captureStream(fps);
    return this.stream;
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}

const VS = `attribute vec2 p; varying vec2 v; void main(){ v = vec2((p.x+1.0)*0.5, (1.0-p.y)*0.5); gl_Position = vec4(p,0.0,1.0); }`;
// The mask travels as the grey right half of a lossy video: erode it by one texel (3×3 minimum) so
// codec ringing and the sliver of background the segmenter leaves around a person never show as a
// bright fringe once the cut-out stands huge on a show stage, then firm up the edge.
const FS = `precision mediump float; uniform sampler2D t; uniform vec2 u; varying vec2 v;
float m(vec2 o){ return texture2D(t, vec2(0.5 + v.x*0.5, v.y) + o).r; }
void main(){
  vec3 rgb = texture2D(t, vec2(v.x*0.5, v.y)).rgb;
  float a = m(vec2(0.0));
  a = min(a, min(min(m(vec2(-u.x, 0.0)), m(vec2(u.x, 0.0))), min(m(vec2(0.0, -u.y)), m(vec2(0.0, u.y)))));
  a = min(a, min(min(m(vec2(-u.x, -u.y)), m(vec2(u.x, -u.y))), min(m(vec2(-u.x, u.y)), m(vec2(u.x, u.y)))));
  a = smoothstep(0.2, 0.75, a);
  gl_FragColor = vec4(rgb, a);
}`;

/**
 * Turns a packed <video> back into an RGBA canvas (person over transparent). WebGL1 is enough and
 * universally available; without it the left half is drawn through an oval so the performer is
 * still never a rectangle.
 */
export class AlphaUnpacker {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext | null;
  private tex: WebGLTexture | null = null;
  private fallback: CanvasRenderingContext2D | null = null;

  constructor(
    readonly width = 320,
    readonly height = 426,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    // The frame is read by whoever draws it (the stage, a recorder), in their own loops: keep it until the next draw.
    this.gl = this.canvas.getContext('webgl', { premultipliedAlpha: false, alpha: true, antialias: false, preserveDrawingBuffer: true }) as WebGLRenderingContext | null;
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
    gl.viewport(0, 0, this.width, this.height);
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
    const { width, height } = this;
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

  /** The RGBA canvas of the current frame, or null until the video has one. */
  current(): HTMLCanvasElement | null {
    const v = this.video;
    if (v.readyState < 2 || !v.videoWidth) return null;
    if (!this.unpacker) this.unpacker = new AlphaUnpacker(Math.round(v.videoWidth / 2), v.videoHeight);
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
