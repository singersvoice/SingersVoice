// SingersVoice sample-accurate recorder — AudioWorklet 'sv-recorder'.
//
// Captures channel 0 of its input on the audio-render thread and ships 4096-frame
// Float32 chunks to the main thread. On 'start' it reports the exact audio-clock
// time of the first captured frame so the vocal can be aligned to the backing
// track's scheduled start (see audio/recorder.ts). Also reports a peak level
// every ~50 ms for the meter.

class SvRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.chunkSize = 4096;
    this.chunk = new Float32Array(this.chunkSize);
    this.fill = 0;
    this.framesCaptured = 0;
    this.peak = 0;
    this.peakFrames = 0;
    this.port.onmessage = (e) => {
      const msg = e.data || {};
      if (msg.type === 'start') {
        this.recording = true;
        this.pendingStart = true;
        this.framesCaptured = 0;
        this.fill = 0;
      } else if (msg.type === 'stop') {
        this.recording = false;
        if (this.fill > 0) {
          this.port.postMessage({ type: 'chunk', data: this.chunk.slice(0, this.fill) });
          this.fill = 0;
        }
        this.port.postMessage({ type: 'stopped', frames: this.framesCaptured, contextTime: currentTime });
      }
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    const src = input && input[0];
    // Pass-through so the node can sit inline in a chain.
    if (src && output && output[0]) {
      for (let ch = 0; ch < output.length; ch++) output[ch].set(input[Math.min(ch, input.length - 1)]);
    }
    if (!src) return true;
    // Level meter.
    let peak = this.peak;
    for (let i = 0; i < src.length; i++) {
      const a = src[i] < 0 ? -src[i] : src[i];
      if (a > peak) peak = a;
    }
    this.peak = peak;
    this.peakFrames += src.length;
    if (this.peakFrames >= sampleRate * 0.05) {
      this.port.postMessage({ type: 'level', peak: this.peak });
      this.peak = 0;
      this.peakFrames = 0;
    }
    if (!this.recording) return true;
    if (this.pendingStart) {
      this.pendingStart = false;
      this.port.postMessage({ type: 'started', contextTime: currentTime, frame: currentFrame, sampleRate });
    }
    let i = 0;
    while (i < src.length) {
      const n = Math.min(src.length - i, this.chunkSize - this.fill);
      this.chunk.set(src.subarray(i, i + n), this.fill);
      this.fill += n;
      i += n;
      this.framesCaptured += n;
      if (this.fill === this.chunkSize) {
        const out = this.chunk;
        this.port.postMessage({ type: 'chunk', data: out }, [out.buffer]);
        this.chunk = new Float32Array(this.chunkSize);
        this.fill = 0;
      }
    }
    return true;
  }
}

registerProcessor('sv-recorder', SvRecorderProcessor);
