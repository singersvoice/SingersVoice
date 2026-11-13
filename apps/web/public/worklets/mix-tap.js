// SingersVoice — AudioWorklet 'sv-mix-tap': hands the stage mix to the main thread in 20 ms mono
// blocks (with the audio-clock time of each block's first frame) for the Opus encoder that feeds
// the audience. Nothing is changed on the way through; the node has no output.
class SvMixTapProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.blockSize = Math.max(128, Math.round(sampleRate / 50)); // 20 ms
    this.buf = new Float32Array(this.blockSize);
    this.fill = 0;
    this.blockStart = 0;
  }
  process(inputs) {
    const inp = inputs[0];
    if (!inp || !inp.length) return true;
    const ch0 = inp[0];
    const ch1 = inp[1];
    const n = ch0.length;
    for (let i = 0; i < n; i++) {
      if (this.fill === 0) this.blockStart = currentTime + i / sampleRate;
      this.buf[this.fill++] = ch1 ? 0.5 * (ch0[i] + ch1[i]) : ch0[i];
      if (this.fill === this.blockSize) {
        const out = this.buf;
        this.port.postMessage({ type: 'block', data: out, contextTime: this.blockStart, sampleRate }, [out.buffer]);
        this.buf = new Float32Array(this.blockSize);
        this.fill = 0;
      }
    }
    return true;
  }
}
registerProcessor('sv-mix-tap', SvMixTapProcessor);
