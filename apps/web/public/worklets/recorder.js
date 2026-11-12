// SingersVoice sample-accurate recorder — AudioWorklet 'sv-recorder'.
//
// Captures channel 0 of its input on the audio-render thread and ships 4096-frame
// Float32 chunks to the main thread. On 'start' it reports the exact audio-clock
// time of the first captured frame so the vocal can be aligned to the backing
// track's scheduled start (see audio/recorder.ts). Also reports a peak level
// every ~50 ms for the meter.
//
// 'pause' / 'resume' carry an audio-clock time: frames are dropped from `at` until the
// resume instant, so the recording stays on the backing track's timeline across a pause
// (sample-accurate when `at` matches the player's own pause/resume times).

class SvRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.pauseAt = Infinity;
    this.resumeAt = Infinity;
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
        this.pauseAt = Infinity;
        this.resumeAt = Infinity;
      } else if (msg.type === 'pause') {
        this.pauseAt = typeof msg.at === 'number' ? msg.at : currentTime;
        this.resumeAt = Infinity;
      } else if (msg.type === 'resume') {
        this.resumeAt = typeof msg.at === 'number' ? msg.at : currentTime;
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
    // Paused window [pauseAt, resumeAt): drop whole frames inside it (sub-quantum precision
    // at the edges: a quantum is 128 frames ≈ 3 ms).
    const blockStart = currentTime;
    const blockEnd = currentTime + src.length / sampleRate;
    let from = 0;
    let to = src.length;
    if (this.pauseAt !== Infinity) {
      if (blockEnd <= this.pauseAt) {
        /* before the pause: keep all */
      } else if (blockStart >= this.resumeAt) {
        this.pauseAt = Infinity;
        this.resumeAt = Infinity;
      } else if (blockStart >= this.pauseAt && blockEnd <= this.resumeAt) {
        return true; // fully inside the pause
      } else if (blockStart < this.pauseAt) {
        to = Math.max(0, Math.min(src.length, Math.round((this.pauseAt - blockStart) * sampleRate)));
      } else {
        from = Math.max(0, Math.min(src.length, Math.round((this.resumeAt - blockStart) * sampleRate)));
        this.pauseAt = Infinity;
        this.resumeAt = Infinity;
      }
    }
    let i = from;
    while (i < to) {
      const n = Math.min(to - i, this.chunkSize - this.fill);
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
