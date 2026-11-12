/**
 * The song's timeline: position, length, and — when `onSeek` is given — a draggable bar to move
 * back and forth in the song (a range input over the bar: pointer, touch or arrow keys). While a
 * jump is on its way (`pending`: the target of a cued seek in a meet) the bar shows where the song
 * is about to go.
 */
import { formatMs } from '@singersvoice/protocol';
import { useState } from 'preact/hooks';

export function SeekBar(props: { tMs: number; durationMs: number; onSeek?: (ms: number) => void; pending?: number | null; disabled?: boolean }) {
  const [drag, setDrag] = useState<number | null>(null);
  const dur = Math.max(1, props.durationMs);
  const shown = drag ?? props.pending ?? props.tMs;
  const pct = (ms: number) => `${Math.min(100, Math.max(0, (ms / dur) * 100))}%`;
  const seekable = Boolean(props.onSeek) && !props.disabled;
  return (
    <div class={`timeline ${seekable ? 'seekable' : ''}`} data-pending={props.pending != null ? Math.round(props.pending) : undefined}>
      <span class="mono">{formatMs(drag ?? props.tMs)}</span>
      <div class="track">
        <i style={{ width: pct(shown) }} />
        {props.pending != null && <b class="cue" style={{ left: pct(props.pending) }} title={`Jumping to ${formatMs(props.pending)}`} />}
        {seekable && (
          <input
            type="range"
            min={0}
            max={Math.round(dur)}
            step={250}
            value={Math.round(shown)}
            aria-label="Song position"
            aria-valuetext={formatMs(shown)}
            onInput={(e) => setDrag(Number((e.currentTarget as HTMLInputElement).value))}
            onChange={(e) => {
              const v = Number((e.currentTarget as HTMLInputElement).value);
              setDrag(null);
              props.onSeek?.(v);
            }}
          />
        )}
      </div>
      <span class="mono">{formatMs(props.durationMs)}</span>
    </div>
  );
}
