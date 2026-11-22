// SingersVoice — AudioWorklet 'sv-mix-out': plays PCM pushed to it (the decoded stage mix, mono, at
// its own rate) as ONE continuous stream at the context's rate — a resampler that carries its place
// across every block, so there is never a seam, whatever rate this device runs at — behind a
// cushion: sound starts once `cushionFrames` are queued, and when the queue runs dry the output is
// silence until the cushion is back (never noise, never a stutter). The edges of such a silence are
// faded over ten milliseconds, never cut: a cut to zero is a click. It reports how far it has played
// (in input frames) a few times a second on the node's own port, so the page can say which words are
// being heard right now.
//
// The sound comes on the node's own port — or, once a message { type: 'port', port } hands over a
// MessagePort, on that port too: the page's Worker (audio/mixPlay.worker.ts) decodes and pushes the
// sound straight from there, so a stalled page never costs a block. The 'pos' reports always go to
// the node's port (the page).
//
// Messages in:  { type: 'pcm', data: Float32Array, rate? }  { type: 'reset' }  { type: 'port', port }
// Messages out: { type: 'pos', consumed, queued, playing, contextTime }
const FADE_S = 0.01;
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
    this.gain = 0; // the fade: up from 0 when sound starts, down to 0 before it runs out
    this.fadeFrames = Math.max(1, Math.round(sampleRate * FADE_S));
    this.consumed = 0; // input frames played since the start (whole chunks) …
    this.sinceReport = 0;
    const onMessage = (e) => {
      const m = e.data;
      if (!m) return;
      if (m.type === 'pcm' && m.data && m.data.length) {
        if (m.rate && m.rate !== this.inRate) {
          this.inRate = m.rate;
          this.step = this.inRate / sampleRate;
        }
        this.chunks.push(m.data);
        this.queued += m.data.length;
      } else if (m.type === 'reset') {
        this.chunks = [];
        this.queued = 0;
        this.pos = 1;
        this.prev = 0;
        this.playing = false;
        this.gain = 0;
        this.consumed = 0;
      } else if (m.type === 'port' && m.port) {
        m.port.onmessage = onMessage;
      }
    };
    this.port.onmessage = onMessage;
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
    if (!this.playing && this.queued >= this.cushion) this.playing = true; // the gain is at 0: the sound fades in
    let i = 0;
    if (this.playing) {
      // Output frames left before the queue runs dry: the last ten milliseconds of them fade out, and what is
      // left after the fade (a quantum or so) waits for the cushion with the sound that comes next.
      const outLeft = (this.queued - (this.pos - 1)) / this.step;
      const target = outLeft <= this.fadeFrames + n ? 0 : 1;
      const inc = 1 / this.fadeFrames;
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
          this.gain = 0;
          this.pos = 1;
          break;
        }
        const c = this.chunks[0];
        const i0 = Math.floor(this.pos);
        const f = this.pos - i0;
        const s0 = i0 === 0 ? this.prev : c[i0 - 1];
        const s1 = i0 < c.length ? c[i0] : this.chunks[1] ? this.chunks[1][0] : c[c.length - 1];
        if (this.gain < target) this.gain = Math.min(1, this.gain + inc);
        else if (this.gain > target) this.gain = Math.max(0, this.gain - inc);
        out[i] = (s0 + (s1 - s0) * f) * this.gain;
        this.pos += this.step;
        if (target === 0 && this.gain <= 0) {
          // faded out: silence from here; the sound resumes, fading in, once the cushion is back
          this.playing = false;
          i++;
          break;
        }
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
