// SingersVoice — AudioWorklet 'sv-mix-out': plays PCM pushed from the main thread (the decoded stage
// mix, mono, at its own rate) as ONE continuous stream at the context's rate — a resampler that
// carries its place across every block, so there is never a seam, whatever rate this device runs
// at — behind a cushion: sound starts once `cushionFrames` are queued, and when the queue runs dry
// the output is silence until the cushion is back (never noise, never a stutter). It reports how far
// it has played (in input frames) a few times a second, so the main thread can say which words are
// being heard right now.
//
// Messages in:  { type: 'pcm', data: Float32Array }  { type: 'reset' }
// Messages out: { type: 'pos', consumed, queued, playing, contextTime }
class SvMixOutProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.inRate = o.sampleRate || 48000;
    this.cushion = o.cushionFrames || this.inRate * 2;
    this.step = this.inRate / sampleRate;
    this.chunks = [];
    this.queued = 0; // frames queued, not yet played
    this.pos = 1; // read position in the current chunk, counted from `prev` (index 0 = the last sample played before it)
    this.prev = 0;
    this.playing = false;
    this.consumed = 0; // input frames played since the start (whole chunks) …
    this.sinceReport = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'pcm' && m.data && m.data.length) {
        this.chunks.push(m.data);
        this.queued += m.data.length;
      } else if (m.type === 'reset') {
        this.chunks = [];
        this.queued = 0;
        this.pos = 1;
        this.prev = 0;
        this.playing = false;
        this.consumed = 0;
      }
    };
  }
  report() {
    // …plus the part of the current chunk already read
    this.port.postMessage({ type: 'pos', consumed: this.consumed + Math.max(0, this.pos - 1), queued: this.queued, playing: this.playing, contextTime: currentTime });
  }
  process(_inputs, outputs) {
    const outs = outputs[0];
    if (!outs || !outs.length) return true;
    const out = outs[0];
    const n = out.length;
    if (!this.playing && this.queued >= this.cushion) this.playing = true;
    let i = 0;
    if (this.playing) {
      for (; i < n; i++) {
        // move to the chunk that holds the read position
        while (this.chunks.length && this.pos >= this.chunks[0].length + 1) {
          const c = this.chunks.shift();
          this.pos -= c.length;
          this.prev = c[c.length - 1];
          this.consumed += c.length;
          this.queued -= c.length;
        }
        if (!this.chunks.length) {
          // dry: silence from here, and the cushion has to fill again before sound resumes
          this.playing = false;
          this.pos = 1;
          break;
        }
        const c = this.chunks[0];
        const i0 = Math.floor(this.pos);
        const f = this.pos - i0;
        const s0 = i0 === 0 ? this.prev : c[i0 - 1];
        const s1 = i0 < c.length ? c[i0] : this.chunks[1] ? this.chunks[1][0] : c[c.length - 1];
        out[i] = s0 + (s1 - s0) * f;
        this.pos += this.step;
      }
    }
    for (; i < n; i++) out[i] = 0;
    for (let ch = 1; ch < outs.length; ch++) outs[ch].set(out);
    this.sinceReport += n;
    if (this.sinceReport >= sampleRate / 10) {
      this.sinceReport = 0;
      this.report();
    }
    return true;
  }
}
registerProcessor('sv-mix-out', SvMixOutProcessor);
