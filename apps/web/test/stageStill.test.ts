/**
 * The stage tells a still picture from a moving one: a remote performer whose frames keep arriving
 * with the very same picture in them for STILL_AFTER_MS is marked still (their camera froze on their
 * device — the host's strip says so and offers Reconnect); the slightest change ends it; frames that
 * stop altogether give the placeholder, never a "still" mark; a performer who leaves is forgotten.
 */
import { describe, expect, it, vi } from 'vitest';
import { StageCompositor, STILL_AFTER_MS, type StagePerformer } from '../src/video/stage.ts';
import { fakeDom } from './helpers/fakeDom.ts';

const dom = fakeDom();

/** A remote frame whose clock the test advances (frames arriving) and whose picture the test sets (the sample the stage reads). */
function remote() {
  const canvas = { width: 320, height: 426 } as HTMLCanvasElement;
  const frame = { currentTime: 0, current: () => canvas };
  return frame;
}
const performer = (id: string, frame: ReturnType<typeof remote>): StagePerformer => ({ id, slot: 1, label: id, source: { kind: 'frame', frame: frame as never } });

describe('a still picture on the stage', () => {
  it('one performer, one picture: still after STILL_AFTER_MS; a changed picture ends it; stopped frames give the placeholder, not a mark', () => {
    vi.useFakeTimers();
    try {
      const stage = new StageCompositor('show');
      stage.resize(1280, 720, 1);
      const a = remote();
      stage.setPerformers([performer('a', a)]);
      const seen: string[][] = [];
      stage.onStill = (ids) => seen.push(ids);
      const picture = (v: number) => {
        for (const c of dom.current.contexts) c.pixels = new Uint8ClampedArray(16 * 21 * 4).fill(v);
      };
      picture(100);
      for (let s = 0; s < STILL_AFTER_MS / 1000; s++) {
        a.currentTime += 1;
        stage.draw();
        vi.advanceTimersByTime(1000);
      }
      expect(seen).toEqual([]);
      a.currentTime += 1;
      stage.draw(); // STILL_AFTER_MS of the same picture
      expect(seen).toEqual([['a']]);
      expect(stage.still.has('a')).toBe(true);
      vi.advanceTimersByTime(1000);
      picture(101); // it moves
      a.currentTime += 1;
      stage.draw();
      expect(seen).toEqual([['a'], []]);
      // Frames stop: after the grace the placeholder is drawn and nothing is "still".
      for (let s = 0; s < 4; s++) {
        vi.advanceTimersByTime(1000);
        stage.draw();
      }
      expect(stage.tiles[0]!.fit).toBeUndefined(); // the placeholder
      expect(stage.still.size).toBe(0);
      // Back, the same picture again for a long time: still again; then gone from the stage: forgotten.
      for (let s = 0; s <= STILL_AFTER_MS / 1000 + 1; s++) {
        a.currentTime += 1;
        stage.draw();
        vi.advanceTimersByTime(1000);
      }
      expect(stage.still.has('a')).toBe(true);
      stage.setPerformers([]);
      stage.draw();
      expect(stage.still.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
