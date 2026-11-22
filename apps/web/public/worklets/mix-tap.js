// SingersVoice — AudioWorklet 'sv-mix-tap': hands the stage mix on in 20 ms blocks (with the
// audio-clock time of each block's first frame) for an encoder — mono by default (the Opus mix
// that feeds the audience in the room), or planar stereo when made with processorOptions
// { channels: 2 } (the AAC the broadcast needs). Nothing is changed on the way through; the node
// has no output. The blocks go to the node's own port (the main thread) — or, once a message
// { type: 'port', port } hands over a MessagePort, straight to that port: an encoder in a Worker
// then gets every block whatever the main thread is doing (a stalled page never costs a block).
class SvMixTapProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.channels = options && options.processorOptions && options.processorOptions.channels === 2 ? 2 : 1;
    this.blockSize = Math.max(128, Math.round(sampleRate / 50)); // 20 ms
    this.buf = new Float32Array(this.blockSize * this.channels);
    this.fill = 0;
    this.blockStart = 0;
    this.out = this.port;
    this.port.onmessage = (e) => {
      if (e.data && e.data.type === 'port' && e.data.port) this.out = e.data.port;
    };
  }
  process(inputs) {
    const inp = inputs[0];
    if (!inp || !inp.length) return true;
    const ch0 = inp[0];
    const ch1 = inp[1] || ch0;
    const n = ch0.length;
    const size = this.blockSize;
    for (let i = 0; i < n; i++) {
      if (this.fill === 0) this.blockStart = currentTime + i / sampleRate;
      if (this.channels === 2) {
        this.buf[this.fill] = ch0[i];
        this.buf[size + this.fill] = ch1[i];
      } else this.buf[this.fill] = inp[1] ? 0.5 * (ch0[i] + ch1[i]) : ch0[i];
      if (++this.fill === size) {
        const out = this.buf;
        this.out.postMessage({ type: 'block', data: out, channels: this.channels, frames: size, contextTime: this.blockStart, sampleRate }, [out.buffer]);
        this.buf = new Float32Array(size * this.channels);
        this.fill = 0;
      }
    }
    return true;
  }
}
registerProcessor('sv-mix-tap', SvMixTapProcessor);
