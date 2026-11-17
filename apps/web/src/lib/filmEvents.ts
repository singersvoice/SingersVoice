/**
 * A filmed event (the film of a meet, a broadcast's footage) put back together from its chapters for
 * the Performances list: the chapters come from the meet's registry (everyone who was in the meet
 * sees them) and from my own Drive (the host's, the publisher's), one row each, in order.
 */
import type { MeetPerformance, PerformanceChapter } from '@singersvoice/protocol';
import type { PerformanceSummary } from './storage/types.ts';

export interface EventChapter {
  performanceId: string;
  index: number;
  kind: PerformanceChapter['kind'];
  title: string;
  startedAt: string;
  durationMs: number;
  singers: { slot: number; displayName: string }[];
  show: MeetPerformance | null;
  own: PerformanceSummary | null;
}

export interface FilmEvent {
  eventId: string;
  title: string;
  meetTitle: string;
  hostUserId: string;
  hostName: string;
  startedAt: string;
  durationMs: number;
  chapters: EventChapter[];
}

/** The chapters of every filming, grouped by their event and ordered; a chapter known from the registry and from my Drive is one row. */
export function groupEvents(shows: MeetPerformance[], own: PerformanceSummary[]): FilmEvent[] {
  const events = new Map<string, FilmEvent>();
  const rows = new Map<string, EventChapter>();
  const add = (ch: EventChapter, ev: Omit<FilmEvent, 'chapters' | 'durationMs' | 'startedAt'>) => {
    const had = rows.get(ch.performanceId);
    if (had) {
      had.show = had.show ?? ch.show;
      had.own = had.own ?? ch.own;
      had.durationMs = had.durationMs || ch.durationMs;
      return;
    }
    rows.set(ch.performanceId, ch);
    let e = events.get(ev.eventId);
    if (!e) {
      e = { ...ev, chapters: [], durationMs: 0, startedAt: ch.startedAt };
      events.set(ev.eventId, e);
    }
    e.chapters.push(ch);
  };
  for (const s of shows) {
    if (!s.chapter) continue;
    add({ performanceId: s.performanceId, index: s.chapter.index, kind: s.chapter.kind, title: s.songTitle, startedAt: s.chapter.startedAt, durationMs: s.durationMs, singers: s.singers, show: s, own: null }, { eventId: s.chapter.eventId, title: s.chapter.eventTitle || 'Film', meetTitle: s.meetTitle, hostUserId: s.hostUserId, hostName: s.hostName });
  }
  for (const p of own) {
    if (!p.chapter) continue;
    add({ performanceId: p.performanceId, index: p.chapter.index, kind: p.chapter.kind, title: p.trackTitle, startedAt: p.chapter.startedAt || p.createdAt, durationMs: p.durationMs, singers: p.singers ?? [], show: null, own: p }, { eventId: p.chapter.eventId, title: p.chapter.eventTitle || 'Film', meetTitle: p.meetTitle ?? '', hostUserId: '', hostName: '' });
  }
  for (const e of events.values()) {
    e.chapters.sort((a, b) => a.index - b.index || a.startedAt.localeCompare(b.startedAt));
    e.startedAt = e.chapters[0]?.startedAt ?? e.startedAt;
    e.durationMs = e.chapters.reduce((n, c) => n + c.durationMs, 0);
    if (!e.hostUserId) {
      const known = e.chapters.find((c) => c.show);
      if (known?.show) {
        e.hostUserId = known.show.hostUserId;
        e.hostName = known.show.hostName;
      }
    }
  }
  return [...events.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

