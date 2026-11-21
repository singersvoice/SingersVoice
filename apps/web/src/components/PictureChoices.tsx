/**
 * The singer's two picture choices, the same two rows wherever they appear (Settings → Camera, the stage's
 * Picture sheet): what their picture is — them cut out on the stage, or their camera as it is — and how
 * their frame behaves — still, following them, or pushed in by their voice (video/framing.ts). Plain
 * segmented buttons; a tap applies at once, on every stage and in what goes out.
 */
import type { Framing, Picture } from '../video/framing.ts';
import { appSettings, updateApp } from '../state/settings.ts';
import { Field, Seg } from './ui.tsx';

export const PICTURE_LABELS: Record<Picture, string> = { cutout: 'Me on the stage', camera: 'My camera as it is' };
export const FRAMING_LABELS: Record<Framing, string> = { still: 'Still', follow: 'Follow me', voice: 'Zoom with my voice' };

export function PictureChoices(props: { compact?: boolean }) {
  const app = appSettings.value;
  return (
    <>
      <Field label="My picture" hint={props.compact ? undefined : 'Me on the stage: you are cut out of your room and stand on the stage with the others. My camera as it is: your camera picture, your room and all — no stage behind you.'}>
        <Seg<Picture> ariaLabel="My picture" value={app.picture} onChange={(v) => updateApp({ picture: v })} options={[{ v: 'cutout', label: PICTURE_LABELS.cutout }, { v: 'camera', label: PICTURE_LABELS.camera }]} />
      </Field>
      <Field label="Framing" hint={props.compact ? undefined : 'Still: framed once, head and shoulders, and left alone (the picture never zooms). Follow me: re-framed, smoothly, when you move in your chair. Zoom with my voice: still, and the picture moves in on you while you sing, back out in the breaks.'}>
        <Seg<Framing> ariaLabel="Framing" value={app.framing} onChange={(v) => updateApp({ framing: v })} options={[{ v: 'still', label: FRAMING_LABELS.still }, { v: 'follow', label: FRAMING_LABELS.follow }, { v: 'voice', label: FRAMING_LABELS.voice }]} />
      </Field>
    </>
  );
}
