/**
 * How your camera frames you — Chest (head to chest, from wherever you sit; the default), Wide, Mid,
 * Close — and Auto (a little closer while you sing). The same control wherever you are on camera:
 * the lobby stage, the live stage, the Studio. This exact picture is you on every stage, in the
 * show and in the recording.
 */
import { Seg } from './ui.tsx';
import { appSettings, updateApp } from '../state/settings.ts';
import type { ZoomPreset } from '../video/framing.ts';

export function Framing(props: { compact?: boolean }) {
  const app = appSettings.value;
  return (
    <span class={`row framing ${props.compact ? 'compact' : ''}`} style="pointer-events:auto" data-framing={app.zoomPreset} data-autozoom={app.autoZoom ? '1' : '0'} title="How your camera frames you — Chest keeps you head-to-chest from wherever you sit, Wide is the whole camera frame, Mid and Close zoom 1.5× / 2.2× onto your head, Auto comes a fifth closer while you sing; this exact picture goes to the stage, the show and the audience">
      <Seg<ZoomPreset>
        value={app.zoomPreset}
        ariaLabel="Stage framing"
        onChange={(v) => updateApp({ zoomPreset: v })}
        options={[
          { v: 'chest', label: 'Chest' },
          { v: 'wide', label: 'Wide' },
          { v: 'mid', label: 'Mid' },
          { v: 'close', label: 'Close' },
        ]}
      />
      <button class={`btn sm ${app.autoZoom ? 'accent' : ''}`} aria-pressed={app.autoZoom} aria-label="Auto zoom while singing" title="Eases closer while you sing and back out when you're silent" onClick={() => updateApp({ autoZoom: !app.autoZoom })}>
        Auto
      </button>
    </span>
  );
}
