/**
 * Sample-rate conversion that never breaks between blocks. Sound reaches an encoder 20 ms at a time;
 * a converter that starts afresh on every block puts a kink at every block edge — fifty tiny clicks a
 * second, a crackle. This one carries its place and its last sample from one block to the next, so
 * the stream it makes is one continuous curve: linear interpolation, which is all a 44.1 → 48 kHz step
 * needs for voices and backing tracks (the rates are close; nothing is dropped or folded).
 */
export class LinearResampler {
  /**
   * Where the next output sample falls, in input frames, counted from the last sample of the previous
   * block (index 0) — so a sample that lands between two blocks is interpolated between the two real
   * samples on either side of the edge, never against a guess.
   */
  private phase = 0;
  private prev = 0;
  private started = false;
  readonly step: number;

  constructor(
    readonly from: number,
    readonly to: number,
  ) {
    this.step = from / to;
  }

  /** Convert one block; returns the output frames this block yields (their count varies by one from block to block). */
  push(input: Float32Array): Float32Array<ArrayBuffer> {
    const n = input.length;
    if (!n) return new Float32Array(new ArrayBuffer(0));
    if (this.from === this.to) {
      const same = new Float32Array(new ArrayBuffer(n * 4));
      same.set(input);
      return same;
    }
    if (!this.started) {
      this.started = true;
      this.prev = input[0]!;
      this.phase = 1; // the first output is the first sample itself
    }
    const prev = this.prev;
    const at = (i: number): number => (i === 0 ? prev : input[i - 1]!);
    const out: number[] = [];
    let x = this.phase;
    while (x < n) {
      const i0 = Math.floor(x);
      const f = x - i0;
      const s0 = at(i0);
      const s1 = at(i0 + 1);
      out.push(s0 + (s1 - s0) * f);
      x += this.step;
    }
    this.phase = x - n;
    this.prev = input[n - 1]!;
    const arr = new Float32Array(new ArrayBuffer(out.length * 4));
    arr.set(out);
    return arr;
  }

  reset(): void {
    this.phase = 0;
    this.prev = 0;
    this.started = false;
  }
}
