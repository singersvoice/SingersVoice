import { signal } from '@preact/signals';
import type { BackgroundItem, BackgroundsIndex } from '@singersvoice/protocol';
import { useEffect, useState } from 'preact/hooks';
import { asset } from '../lib/nav.ts';
import { appSettings, updateApp, type AppSettings } from '../state/settings.ts';
import { IcCamera } from './icons.tsx';

export const backgrounds = signal<BackgroundItem[]>([]);
let loading: Promise<void> | null = null;

/**
 * No stage behind the singer: their camera picture as it is, room and all — the virtual background off. A
 * choice like any other in the picker (first), remembered like any other; the stage and the show draw a
 * plain dark backdrop behind the pictures, and the singer's own picture switches to "my camera as it is".
 */
export const NONE_BACKGROUND_ID = 'none';
export const NONE_BACKGROUND: BackgroundItem = { id: NONE_BACKGROUND_ID, kind: 'image', src: '', thumb: '', label: 'None — my camera as it is' };
export const isNoneBackground = (id: string): boolean => id === NONE_BACKGROUND_ID;

/**
 * The singer's own background chosen (Settings, the Studio, the stage a meet starts on): none switches their
 * picture to their camera as it is (that is the point of it); a stage chosen after none puts them back on it,
 * cut out. Either way the choice is kept with the app settings (this device, and the Config folder in Drive).
 */
export function pickBackground(id: string): void {
  const app = appSettings.peek();
  const patch: Partial<AppSettings> = { backgroundId: id };
  if (isNoneBackground(id)) patch.picture = 'camera';
  else if (isNoneBackground(app.backgroundId)) patch.picture = 'cutout';
  updateApp(patch);
}

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
  if (isNoneBackground(id)) return NONE_BACKGROUND;
  return backgrounds.value.find((b) => b.id === id) ?? backgrounds.value[0];
}

/** The background's file (''): none for the plain backdrop — the stage and the show then draw nothing behind the singers. */
export function backgroundSrc(b: BackgroundItem | undefined): string {
  return b && b.src ? asset(`backgrounds/${b.src}`) : '';
}

export function BackgroundPicker(props: { value: string; onChange: (id: string) => void }) {
  useEffect(() => void loadBackgrounds(), []);
  const items = backgrounds.value;
  if (!items.length) return <div class="muted small">Loading backgrounds…</div>;
  return (
    <div class="bg-grid" role="listbox" aria-label="Stage background">
      <button type="button" role="option" aria-selected={isNoneBackground(props.value)} class={`none ${isNoneBackground(props.value) ? 'on' : ''}`} data-bg-none onClick={() => props.onChange(NONE_BACKGROUND_ID)} title="No virtual background: your camera picture as it is, your room and all">
        <span class="nonebg" aria-hidden="true">
          <IcCamera size={28} />
        </span>
        <span>{NONE_BACKGROUND.label}</span>
      </button>
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
  if (!b || isNoneBackground(b.id)) return <div class="bg" data-bg={b ? b.id : ''} />;
  if (b.kind === 'video') {
    return (
      <div class="bg" data-bg={b.id}>
        <video src={backgroundSrc(b)} poster={b.poster ? asset(`backgrounds/${b.poster}`) : undefined} muted loop autoPlay playsInline />
      </div>
    );
  }
  return <div class="bg" data-bg={b.id} style={{ backgroundImage: `url(${backgroundSrc(b)})` }} />;
}
