import { signal } from '@preact/signals';
import type { BackgroundItem, BackgroundsIndex } from '@singersvoice/protocol';
import { useEffect } from 'preact/hooks';
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

/** Full-bleed stage background (image or looping video). */
export function StageBackground(props: { id: string }) {
  useEffect(() => void loadBackgrounds(), []);
  const b = backgroundById(props.id);
  if (!b) return <div class="bg" />;
  if (b.kind === 'video') {
    return (
      <div class="bg">
        <video src={backgroundSrc(b)} poster={b.poster ? asset(`backgrounds/${b.poster}`) : undefined} muted loop autoPlay playsInline />
      </div>
    );
  }
  return <div class="bg" style={{ backgroundImage: `url(${backgroundSrc(b)})` }} />;
}
