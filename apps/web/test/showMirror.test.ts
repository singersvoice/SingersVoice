/**
 * What is recorded, filmed and streamed is never mirrored: the stage on the screen shows a singer
 * their own front camera as a mirror, but the show compositor behind every recording and the
 * broadcast draws everyone the way the audience sees them — the stage's performer list arrives with
 * `mirror` set for this device's own front camera, and the recorder drops it for every performer.
 */
import { describe, expect, it } from 'vitest';
import { fakeDom } from './helpers/fakeDom.ts';

fakeDom();
const { ShowRecorder } = await import('../src/video/showRecorder.ts');

describe('the show recorder draws nobody mirrored', () => {
  it('this device\'s front camera and every remote performer come through with mirror off; the singer is still held back by the lag', () => {
    const show = new ShowRecorder();
    const myCanvas = { width: 320, height: 426 } as HTMLCanvasElement;
    const frame = { currentTime: 0, current: () => myCanvas };
    show.setPerformers([
      { id: 'me', slot: 1, label: 'You · S1', isMe: true, mirror: true, source: { kind: 'person', canvas: myCanvas, version: 1 } as never },
      { id: 'p-2', slot: 2, label: 'Team · S2', mirror: true, source: { kind: 'frame', frame: frame as never } },
      { id: 'p-3', slot: 3, label: 'Dave · S3', source: { kind: 'none' } },
    ]);
    const drawn = show.drawnPerformers;
    expect(drawn.map((p) => p.id)).toEqual(['me', 'p-2', 'p-3']);
    expect(drawn.every((p) => p.mirror === false)).toBe(true);
    // The singer's own cut-out is the delayed copy (in step with their vocal), never the live canvas.
    const me = drawn[0]!;
    expect(me.source.kind).toBe('person');
    expect(me.source.kind === 'person' && me.source.canvas !== myCanvas).toBe(true);
    expect(me.label).toBe('You · S1');
    show.youLabel = 'Hari';
    show.setPerformers([{ id: 'me', slot: 1, label: 'You', isMe: true, mirror: true, source: { kind: 'person', canvas: myCanvas, version: 1 } as never }]);
    expect(show.drawnPerformers[0]!.label).toBe('Hari');
    expect(show.drawnPerformers[0]!.mirror).toBe(false);
  });
});
