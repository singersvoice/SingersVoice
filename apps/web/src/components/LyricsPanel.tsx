import { useMemo } from 'preact/hooks';
import { cueDeckFor, isMyLine, lyricsPace, lyricsWindow, partColor, partLabel, planParts, SLOT_COLORS, type LyricLine, type PartPlan, type SingerSlot } from '@singersvoice/protocol';
import { ms, type Clocked } from './clocked.ts';

/** A line lights up this long before it starts: a breath to read it, as every karaoke screen gives. */
export const LYRIC_LEAD_MS = 150;

export function SlotBadge(props: { slot: SingerSlot; label?: string; class?: string }) {
  return (
    <span class={`slot-badge ${props.class ?? ''}`} style={{ background: SLOT_COLORS[props.slot] }}>
      {props.label ?? (props.slot === 0 ? 'ALL' : `S${props.slot}`)}
    </span>
  );
}

/**
 * The lyrics-first stage centre: 1 done (grey) · 1 active (fills white as its words are sung — at
 * the song's own pace, so a line followed by a pause is lit by the time its last word is sung, not
 * stretched over the pause) · 3 upcoming. Every line is in the colour of the singer who sings it,
 * whole — the song's parts divided among the singers in the song (`plan`, `planParts` in the
 * protocol: two singers, two colours; ten singers on a five-part song, 1 and 6 share one), with the
 * chip naming the stage slot(s) that sing it; the lines of *your* slot carry a ringed chip.
 *
 * The words are up from the first moment: through the count-in the opening lines stand ready under
 * the count, so a singer reads the first line before the first beat (nothing to wait for on a phone).
 */
export function LyricsPanel(props: { lines: LyricLine[]; tMs: Clocked; mySlot: number; plan?: PartPlan; countdown: number | null; showWho: boolean; title?: string }) {
  const pace = useMemo(() => lyricsPace(props.lines), [props.lines]);
  const plan = props.plan ?? planParts(1, []);
  const counting = props.countdown !== null && props.countdown > 0;
  const w = lyricsWindow(props.lines, counting ? 0 : ms(props.tMs), 1, 3, { leadMs: counting ? 0 : LYRIC_LEAD_MS, paceMsPerChar: pace });
  if (!props.lines.length) {
    return (
      <section class="lyrics" data-counting={counting ? '1' : undefined}>
        {counting && <div class="countdown">{props.countdown}</div>}
        <div class="lyric upcoming">{props.title ?? 'No lyrics on this track'}</div>
        <div class="muted small">Add lyrics in Track Maker to light up the stage.</div>
      </section>
    );
  }
  let upcomingSeen = 0;
  return (
    <section class="lyrics" aria-live="off" data-counting={counting ? '1' : undefined}>
      {counting && (
        <div class="countdown" aria-label={`Starting in ${props.countdown}`}>
          {props.countdown}
        </div>
      )}
      {w.items.map((it) => {
        const far = it.state === 'upcoming' && upcomingSeen++ >= 1;
        const mine = isMyLine(plan, it.line.singerSlot, props.mySlot);
        const color = partColor(plan, it.line.singerSlot);
        const style = { '--c': color, ...(it.state === 'active' ? { '--p': `${(w.progress * 100).toFixed(1)}%` } : {}) };
        return (
          <div key={it.index} class={`lyric ${it.state} ${far ? 'far' : ''} ${mine ? 'mine' : ''}`} style={style as unknown as string} data-part={it.line.singerSlot} data-who={partLabel(plan, it.line.singerSlot)}>
            {props.showWho && (
              <span class="who" style={{ background: color }}>
                {partLabel(plan, it.line.singerSlot)}
              </span>
            )}
            {it.line.text}
          </div>
        );
      })}
    </section>
  );
}

/** Personal "cue deck": the next 3 lines you sing (your parts in the plan), with the countdown to the first one. */
export function CueDeck(props: { lines: LyricLine[]; tMs: Clocked; mySlot: number; plan?: PartPlan }) {
  const plan = props.plan ?? planParts(1, []);
  const t = ms(props.tMs);
  const next = cueDeckFor(props.lines, t, (l) => isMyLine(plan, l.singerSlot, props.mySlot), 3);
  if (!next.length) return null;
  const first = next[0]!;
  const secs = Math.max(0, (first.startMs - t) / 1000);
  return (
    <aside class="cue" aria-hidden="true">
      <div>
        You in <b>{secs.toFixed(0)}s</b>
      </div>
      {next.map((l, i) => (
        <div key={i} style={{ opacity: 1 - i * 0.3 }}>
          {l.text}
        </div>
      ))}
    </aside>
  );
}
