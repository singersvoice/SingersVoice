/**
 * The song of the stage, as the room renders it: picked is up; two picked → the same choice card on
 * every device (buttons for the singers on stage, none for the audience, Start held); a song picked
 * during a song waits for its end.
 */
import { h } from 'preact';
import { render } from 'preact-render-to-string';
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const m = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
});
import type { Meet, Participant } from '@singersvoice/protocol';
import { songChoicePending } from '@singersvoice/protocol';
import type { MeetSession } from '../src/portals/meets/meetSession.ts';
import { SetListPanel } from '../src/portals/meets/SetListPanel.tsx';

const you = { participantId: 'p-me', displayName: 'Me' } as Participant;
const entry = (id: string, title: string, by: string) => ({ id, trackId: id, catalogTrackId: null, trackTitle: title, durationMs: 200_000, pickedBy: by, pickedByName: `${by} Singer`, addedAt: '' });
const meet = (over: Partial<Meet>): Meet => ({ state: 'lobby', trackId: 't1', catalogTrackId: null, trackTitle: 'One', currentDurationMs: 180_000, setList: [], songCount: 0, ...over }) as Meet;
const session = {} as MeetSession;
const panel = (m: Meet, who: { host?: boolean; onStage?: boolean } = { onStage: true }) =>
  render(h(SetListPanel, { session, meet: m, you, track: null, host: who.host ?? false, onStage: who.onStage ?? false, live: m.state === 'countdown' || m.state === 'live' })).replace(/<!--.*?-->/g, '');

describe('the song of the stage', () => {
  it('picked is up: one song, no card, ready to start', () => {
    const html = panel(meet({}));
    expect(html).toContain('Up next');
    expect(html).toContain('>One<');
    expect(html).toContain('data-choice="0"');
    expect(html).not.toContain('Sing this one');
    expect(panel(meet({ trackId: null, trackTitle: '' }))).toContain('No song picked yet');
  });
  it('two picked at once: every singer on stage sees the same card — both songs, who picked what, one tap each; the audience sees it without the buttons', () => {
    const m = meet({ setList: [entry('t2', 'Two', 'bob')] });
    expect(songChoicePending(m)).toBe(true);
    const singer = panel(m, { onStage: true });
    expect(singer).toContain('data-choice="2"');
    expect(singer).toContain('2 songs picked');
    expect(singer).toContain('One tap by any singer settles it');
    expect(singer).toContain('picked first');
    expect(singer).toContain('picked by bob');
    expect(singer).toContain('aria-label="Sing One"');
    expect(singer).toContain('aria-label="Sing Two"');
    expect(singer).toContain('aria-label="Withdraw Two"');
    expect(singer).not.toContain('Track ready'); // nothing is "ready" while the choice is open
    const host = panel(m, { host: true });
    expect(host).toContain('aria-label="Sing Two"');
    const audience = panel(m, { onStage: false });
    expect(audience).toContain('data-choice="2"');
    expect(audience).toContain('The singers are choosing the song');
    expect(audience).toContain('picked by bob');
    expect(audience).not.toContain('Sing this one');
    expect(audience).not.toContain('Withdraw');
    // the one who put a song forward may withdraw it even from the audience
    const mine = panel(meet({ setList: [entry('t2', 'Two', 'p-me')] }), { onStage: false });
    expect(mine).toContain('aria-label="Withdraw Two"');
    expect(mine).not.toContain('Sing this one');
  });
  it('a song ended with several put forward: nothing up, the card lists them all', () => {
    const html = panel(meet({ trackId: null, trackTitle: '', setList: [entry('t2', 'Two', 'bob'), entry('t3', 'Three', 'cy')] }));
    expect(html).toContain('data-choice="2"');
    expect(html).toContain('data-current="0"');
    expect(html).not.toContain('picked first');
    expect(html).toContain('aria-label="Sing Two"');
    expect(html).toContain('aria-label="Sing Three"');
  });
  it('during a song, a pick waits for the end: one follows by itself, several ask the stage to choose', () => {
    const one = panel(meet({ state: 'live', setList: [entry('t2', 'Two', 'bob')] }));
    expect(one).toContain('Now singing');
    expect(one).toContain('After this song');
    expect(one).toContain('data-choice="0"');
    expect(one).not.toContain('Sing this one');
    expect(one).toContain('aria-label="Withdraw Two"');
    const two = panel(meet({ state: 'live', setList: [entry('t2', 'Two', 'bob'), entry('t3', 'Three', 'cy')] }));
    expect(two).toContain('2 songs put forward, the stage chooses one');
    expect(two).toContain('data-choice="2"');
    expect(two).toContain('aria-label="Sing Two"');
    expect(two).toContain('aria-label="Sing Three"');
    expect(two).not.toContain('aria-label="Sing One"'); // the song running is not a choice
  });
});
