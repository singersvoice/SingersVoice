/**
 * The seat: the stage frame is set once from measurements that agree, then held — never steered
 * after the head's every wobble — and re-set only when the singer has clearly moved and stayed
 * there, in one smooth glide. A model that loses and finds the figure is not a singer moving.
 */
import { describe, expect, it } from 'vitest';
import { SEAT, Seat, STAGE_FRAME, STILL, stageCrop, VOICE_ZOOM, type PersonBox } from '../src/video/framing.ts';

const W = 720;
const H = 960;
/** A head at `top` (fraction of the frame), `h` tall, centred at `cx`; the width in the frame's proportions. */
const head = (cx: number, top: number, h: number): PersonBox => ({ x: cx - (h * 0.75) / 2, y: top, w: h * 0.75, h });
const STANDARD = head(0.5, 0.3, 0.2);

/** Feed the seat `head` (or a function of time) every 150 ms for `ms`, from `from`; returns the end time. */
function feed(seat: Seat, from: number, ms: number, h: PersonBox | null | ((t: number) => PersonBox | null)): number {
  let t = from;
  for (; t < from + ms; t += 150) seat.sample(typeof h === 'function' ? h(t) : h, t);
  return t;
}
/** The crop as it stands at `to`, asked for every 50 ms from `from` on the way (as the pipeline asks it, frame by frame). */
function run(seat: Seat, from: number, to: number) {
  let c = seat.crop(from);
  for (let t = from + 50; t <= to; t += 50) c = seat.crop(t);
  return c;
}
/** A head jittering around `base`: ±3 % of the frame in place, ±10 % in size, deterministically. */
const jitter = (base: PersonBox) => (t: number): PersonBox => {
  const a = Math.sin(t / 37) * 0.03;
  const b = Math.cos(t / 53) * 0.03;
  const k = 1 + Math.sin(t / 71) * 0.1;
  return head(base.x + base.w / 2 + a, base.y + b, base.h * k);
};

describe('the seat', () => {
  it('draws the whole camera frame while settling, then glides once to the stage frame of the median head and holds it', () => {
    const seat = new Seat(W, H);
    expect(seat.state(0)).toBe('settling');
    expect(seat.crop(0)).toMatchObject({ sx: 0, sy: 0, sw: W, sh: H });
    let t = feed(seat, 0, SEAT.settleMs - 300, jitter(STANDARD));
    expect(seat.state(t)).toBe('settling'); // not yet a full window
    t = feed(seat, t, 600, jitter(STANDARD));
    expect(seat.state(t)).toBe('gliding');
    const target = seat.target!;
    // The median of the jitter is the standard head: the stage frame of it.
    const want = stageCrop(W, H, STANDARD);
    expect(Math.abs(target.sh - want.sh)).toBeLessThan(want.sh * 0.03);
    expect(Math.abs(target.sy - want.sy)).toBeLessThan(H * 0.03);
    expect(Math.abs(target.sx - want.sx)).toBeLessThan(W * 0.03);
    // The glide: from the whole frame, smoothly, to the target, which it reaches exactly at glideMs.
    const start = seat.crop(t);
    expect(start.sh).toBeGreaterThan(target.sh * 0.95); // still (almost) the whole frame at the start
    let last = start.sh;
    for (let k = 0.1; k < 1; k += 0.1) {
      const c = seat.crop(t + SEAT.glideMs * k);
      expect(c.sh).toBeLessThanOrEqual(last + 1e-9); // narrowing all the way, never back
      last = c.sh;
    }
    expect(seat.crop(t + SEAT.glideMs)).toEqual(target);
    expect(seat.state(t + SEAT.glideMs)).toBe('held');
  });

  it('holds under measurement noise — the head wobbling in place and size for a long time', () => {
    const seat = new Seat(W, H);
    let t = feed(seat, 0, SEAT.settleMs + 300, jitter(STANDARD));
    const target = seat.target!;
    t = feed(seat, t + SEAT.glideMs, 30_000, jitter(STANDARD));
    expect(seat.target).toBe(target); // never re-set
    expect(seat.crop(t)).toEqual(target);
  });

  it("'follow' — a gesture is not a move: a second of a different head leaves the seat; a singer who moved and stayed is re-seated in one glide", () => {
    const seat = new Seat(W, H);
    seat.framing = 'follow';
    let t = feed(seat, 0, SEAT.settleMs + 300, jitter(STANDARD));
    const target = seat.target!;
    t += SEAT.glideMs;
    const leaned = head(0.5, 0.2, 0.3); // leaned in: the head half again as big, higher
    t = feed(seat, t, 1000, jitter(leaned));
    t = feed(seat, t, 3000, jitter(STANDARD));
    expect(seat.target).toBe(target);
    // Moved and stayed: re-seated after reseatAfterMs, gliding from the held frame to the new one.
    const t0 = t;
    t = feed(seat, t, SEAT.reseatAfterMs - 300, jitter(leaned));
    expect(seat.target).toBe(target);
    t = feed(seat, t, 600, jitter(leaned));
    expect(seat.target).not.toBe(target);
    expect(t - t0).toBeLessThan(SEAT.reseatAfterMs + 1000);
    expect(seat.state(t)).toBe('gliding');
    const want = stageCrop(W, H, leaned);
    expect(Math.abs(seat.target!.sh - want.sh)).toBeLessThan(want.sh * 0.03);
    expect(seat.crop(t + SEAT.glideMs)).toEqual(seat.target);
    // The new frame has the head at the standard again: the same size as everyone's.
    const c = seat.target!;
    expect((leaned.h * H) / c.sh).toBeCloseTo(STAGE_FRAME.headHeight, 1);
  });

  it('a model losing and finding the figure is not a move: disagreeing measurements never re-seat; nobody found holds', () => {
    const seat = new Seat(W, H);
    seat.framing = 'follow';
    let t = feed(seat, 0, SEAT.settleMs + 300, jitter(STANDARD));
    const target = seat.target!;
    t += SEAT.glideMs;
    // Every other measurement is a fragment of the figure (a tiny head low in the picture), for a long time.
    t = feed(seat, t, 10_000, (tt) => (Math.floor(tt / 150) % 2 ? head(0.45, 0.5, 0.05) : head(0.5, 0.2, 0.3)));
    expect(seat.target).toBe(target);
    // Nobody found: the frame holds.
    t = feed(seat, t, 5000, null);
    expect(seat.target).toBe(target);
    expect(seat.crop(t)).toEqual(target);
    // Measurements that agree again, elsewhere: re-seated.
    t = feed(seat, t, SEAT.reseatAfterMs + 600, jitter(head(0.5, 0.2, 0.3)));
    expect(seat.target).not.toBe(target);
  });

  it("'still' (the default): a singer who leans in or shifts in the chair is never re-framed — only one who went somewhere else and stayed", () => {
    const seat = new Seat(W, H);
    expect(seat.framing).toBe('still');
    let t = feed(seat, 0, SEAT.settleMs + 300, jitter(STANDARD));
    const target = seat.target!;
    t += SEAT.glideMs;
    // Leaned in (the head half again as big, higher) and stayed, far longer than 'follow' would wait: still the same frame.
    t = feed(seat, t, SEAT.reseatAfterMs * 4, jitter(head(0.5, 0.2, 0.3)));
    expect(seat.target).toBe(target);
    expect(seat.moving(t)).toBe(false);
    // Moved to the other side of the picture, a lot smaller (sat down somewhere else), and stayed: re-framed, once, after the long hold.
    const elsewhere = head(0.15, 0.55, 0.08);
    t = feed(seat, t, STILL.reseatAfterMs - 300, jitter(elsewhere));
    expect(seat.target).toBe(target);
    t = feed(seat, t, 900, jitter(elsewhere));
    expect(seat.target).not.toBe(target);
    expect(seat.state(t)).toBe('gliding');
  });

  it("'voice': the held frame is pushed in on the face while the singer is loud — eased in, eased out, never past the push-in's most — and the frame itself stays where it was", () => {
    const seat = new Seat(W, H);
    seat.framing = 'voice';
    let t = feed(seat, 0, SEAT.settleMs + 300, jitter(STANDARD));
    t += SEAT.glideMs + 100;
    const held = seat.target!;
    expect(seat.crop(t)).toEqual(held); // quiet: the held frame as it is
    expect(seat.moving(t)).toBe(false);
    // Singing, full voice: the crop shrinks toward the most of the push-in, about the face (the top moves down less than the bottom moves up).
    seat.voice(1);
    expect(seat.moving(t)).toBe(true);
    let last = seat.crop(t);
    for (let k = 1; k <= 20; k++) {
      const c = seat.crop(t + k * 50);
      expect(c.sh).toBeLessThanOrEqual(last.sh + 1e-9);
      last = c;
    }
    const tight = run(seat, t + 1000, t + 3000);
    expect(tight.sh).toBeCloseTo(held.sh / VOICE_ZOOM.max, 0);
    expect(tight.sw / tight.sh).toBeCloseTo(held.sw / held.sh, 6); // the frame's proportions kept
    expect(tight.sy - held.sy).toBeCloseTo((held.sh - tight.sh) * VOICE_ZOOM.about, 0);
    expect(seat.moving(t + 3000)).toBe(false);
    expect(seat.target).toBe(held); // the voice never re-seats
    // A breath: the crop eases back out, slower than it went in, to the held frame.
    seat.voice(0);
    const quarter = run(seat, t + 3000, t + 3000 + VOICE_ZOOM.outMs / 4);
    expect(quarter.sh).toBeGreaterThan(tight.sh);
    expect(quarter.sh).toBeLessThan(held.sh);
    expect(run(seat, t + 3000 + VOICE_ZOOM.outMs / 4, t + 3000 + VOICE_ZOOM.outMs * 8)).toEqual(held);
    // Room noise is not singing: no push-in from a meter sitting low.
    seat.voice(0.3);
    expect(run(seat, t + 20_000, t + 30_000)).toEqual(held);
    // Framing switched back to 'still' mid-push: the push-in eases out and stays out.
    seat.voice(1);
    expect(run(seat, t + 40_000, t + 41_000).sh).toBeLessThan(held.sh);
    seat.framing = 'still';
    expect(seat.moving(t + 41_000)).toBe(true);
    expect(run(seat, t + 41_000, t + 60_000)).toEqual(held);
  });

  it('never settles on measurements that disagree', () => {
    const seat = new Seat(W, H);
    const t = feed(seat, 0, 6000, (tt) => (Math.floor(tt / 150) % 2 ? head(0.3, 0.6, 0.1) : head(0.6, 0.1, 0.3)));
    expect(seat.state(t)).toBe('settling');
    expect(seat.target).toBeNull();
  });
});
