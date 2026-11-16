// SingersVoice — AudioWorklet 'sv-tap': a diagnostic tap. It records the sound that reaches it
// (the first channel, `frames` frames) on the audio thread — exactly what the node it is connected
// to puts out, whatever the page's main thread is doing — and posts the recording when it is full.
// Used by support captures and the live e2e ("what does the audience / the broadcast really get").
//
// processorOptions: { frames }   Message out: { type: 'done', data: Float32Array, sampleRate }
class SvTapProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.want = Math.max(128, Math.round(o.frames || sampleRate * 6));
    this.buf = new Float32Array(this.want);
    this.n = 0;
    this.done = false;
  }
  process(inputs, outputs) {
    if (this.done) return false;
    const outs = outputs[0];
    if (outs) for (let c = 0; c < outs.length; c++) outs[c].fill(0); // a silent output keeps the node in the graph without adding sound
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true; // nothing connected yet
    const take = Math.min(ch.length, this.want - this.n);
    this.buf.set(ch.subarray(0, take), this.n);
    this.n += take;
    if (this.n >= this.want) {
      this.done = true;
      this.port.postMessage({ type: 'done', data: this.buf, sampleRate }, [this.buf.buffer]);
      return false;
    }
    return true;
  }
}
registerProcessor('sv-tap', SvTapProcessor);
