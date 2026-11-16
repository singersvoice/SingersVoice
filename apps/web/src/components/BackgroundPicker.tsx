import { signal } from '@preact/signals';
import type { BackgroundItem, BackgroundsIndex } from '@singersvoice/protocol';
import { useEffect, useState } from 'preact/hooks';
import { asset } from '../lib/nav.ts';

export const backgrounds = signal<BackgroundItem[]>([]);
let loading: Promise<void> | null = null;

export function loadBackgrounds(): Promise<void> {
  if (loading) return loading;
  loading = fetch(asset('backgrounds/index.json'))
    .then((r) => r.json() as Promise<BackgroundsIndex>)
    .then((j) => {
      backgrounds.value = j.items;
    })
    .catch(() => {
      backgrounds.value = [];
    });
  return loading;
}

export function backgroundById(id: string): BackgroundItem | undefined {
  return backgrounds.value.find((b) => b.id === id) ?? backgrounds.value[0];
}

export function backgroundSrc(b: BackgroundItem | undefined): string {
  return b ? asset(`backgrounds/${b.src}`) : '';
}

export function BackgroundPicker(props: { value: string; onChange: (id: string) => void }) {
  useEffect(() => void loadBackgrounds(), []);
  const items = backgrounds.value;
  if (!items.length) return <div class="muted small">Loading backgrounds…</div>;
  return (
    <div class="bg-grid" role="listbox" aria-label="Stage background">
      {items.map((b) => (
        <button key={b.id} type="button" role="option" aria-selected={props.value === b.id} class={props.value === b.id ? 'on' : ''} onClick={() => props.onChange(b.id)}>
          <img src={asset(`backgrounds/${b.thumb}`)} alt={b.label} loading="lazy" width="320" height="180" />
          <span>
            {b.label}
            {b.kind === 'video' ? ' ▶' : ''}
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * The stage background of a running meet, for the host and the singers on stage: a tap switches it
 * for everyone — every device in the room and the show (Publisher mode) follow at once (the mesh carries the word, the service the state).
 */
export function StageBackgroundChoice(props: { value: string; onPick: (id: string) => Promise<void>; compact?: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const pick = async (id: string) => {
    if (id === props.value || busy) return;
    setBusy(id);
    try {
      await props.onPick(id);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div class={`stack ${props.compact ? 'compact' : ''}`} data-stage-background={props.value}>
      {!props.compact && <div class="small muted">The background of the stage, for everyone in the meet — on every device and in the show at once. Any singer on stage may switch it.</div>}
      <BackgroundPicker value={busy ?? props.value} onChange={(id) => void pick(id)} />
    </div>
  );
}

/** Full-bleed stage background (image or looping video). */
export function StageBackground(props: { id: string }) {
  useEffect(() => void loadBackgrounds(), []);
  const b = backgroundById(props.id);
  if (!b) return <div class="bg" data-bg="" />;
  if (b.kind === 'video') {
    return (
      <div class="bg" data-bg={b.id}>
        <video src={backgroundSrc(b)} poster={b.poster ? asset(`backgrounds/${b.poster}`) : undefined} muted loop autoPlay playsInline />
      </div>
    );
  }
  return <div class="bg" data-bg={b.id} style={{ backgroundImage: `url(${backgroundSrc(b)})` }} />;
}
