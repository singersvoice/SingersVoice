import { cueDeck, lyricsWindow, SLOT_COLORS, type LyricLine, type SingerSlot } from '@singersvoice/protocol';

export function SlotBadge(props: { slot: SingerSlot; label?: string; class?: string }) {
  return (
    <span class={`slot-badge ${props.class ?? ''}`} style={{ background: SLOT_COLORS[props.slot] }}>
      {props.label ?? (props.slot === 0 ? 'ALL' : `S${props.slot}`)}
    </span>
  );
}

/**
 * The lyrics-first stage centre: 1 done (grey) · 1 active (green, fills as the line plays) ·
 * 3 upcoming (orange). Lines sung by *your* slot carry a highlighted badge.
 */
export function LyricsPanel(props: { lines: LyricLine[]; tMs: number; mySlot: number; countdown: number | null; showWho: boolean; title?: string }) {
  const w = lyricsWindow(props.lines, props.tMs, 1, 3);
  if (props.countdown !== null && props.countdown > 0) {
    return (
      <section class="lyrics" aria-live="off">
        <div class="countdown">{props.countdown}</div>
        <div class="muted">{props.lines[0]?.text ?? ''}</div>
      </section>
    );
  }
  if (!props.lines.length) {
    return (
      <section class="lyrics">
        <div class="lyric upcoming">{props.title ?? 'No lyrics on this track'}</div>
        <div class="muted small">Add lyrics in Track Maker to light up the stage.</div>
      </section>
    );
  }
  let upcomingSeen = 0;
  return (
    <section class="lyrics" aria-live="off">
      {w.items.map((it) => {
        const far = it.state === 'upcoming' && upcomingSeen++ >= 1;
        const mine = it.line.singerSlot === props.mySlot || it.line.singerSlot === 0;
        const style = it.state === 'active' ? { '--p': `${Math.round(w.progress * 100)}%` } : undefined;
        return (
          <div key={it.index} class={`lyric ${it.state} ${far ? 'far' : ''} ${mine ? 'mine' : ''}`} style={style as unknown as string}>
            {props.showWho && (
              <span class="who" style={{ background: SLOT_COLORS[it.line.singerSlot] }}>
                {it.line.singerSlot === 0 ? 'ALL' : `S${it.line.singerSlot}`}
              </span>
            )}
            {it.line.text}
          </div>
        );
      })}
    </section>
  );
}

/** Personal "cue deck": the next 3 lines you sing, with the countdown to the first one. */
export function CueDeck(props: { lines: LyricLine[]; tMs: number; mySlot: number }) {
  const next = cueDeck(props.lines, props.tMs, props.mySlot as SingerSlot, 3);
  if (!next.length) return null;
  const first = next[0]!;
  const secs = Math.max(0, (first.startMs - props.tMs) / 1000);
  return (
    <aside class="cue" aria-hidden="true">
      <div>
        You in <b>{secs.toFixed(0)}s</b>
      </div>
      {next.map((l, i) => (
        <div key={i} style={{ opacity: 1 - i * 0.3 }}>
          {l.text.split('\n')[0]}
        </div>
      ))}
    </aside>
  );
}
