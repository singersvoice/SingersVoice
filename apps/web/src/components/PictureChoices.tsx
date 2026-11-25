/**
 * The singer's two picture choices, the same two rows wherever they appear (Settings → Camera, the Studio's Camera &
 * zoom sheet, the meet's Picture sheet — offline performances and live meets alike): what their picture is — them cut
 * out on the stage, or their camera as it is — and AUTOZOOM: off (the default), their frame holds them head to chest,
 * centred, and follows with a glide when they or the camera move ('follow'); on, the picture pushes in on their face
 * while they sing as well ('voice'; video/framing.ts). A plain switch; a tap applies at once, on every stage and in
 * what goes out.
 */
import type { Picture } from '../video/framing.ts';
import { appSettings, updateApp } from '../state/settings.ts';
import { Field, Seg, Switch } from './ui.tsx';

export const PICTURE_LABELS: Record<Picture, string> = { cutout: 'Me on the stage', camera: 'My camera as it is' };
export const AUTOZOOM_LABEL = 'Auto zoom';

export function PictureChoices(props: { compact?: boolean }) {
  const app = appSettings.value;
  const autozoom = app.framing === 'voice';
  return (
    <>
      <Field label="My picture" hint={props.compact ? undefined : 'Me on the stage: you are cut out of your room and stand on the stage with the others. My camera as it is: your camera picture, your room and all — no stage behind you.'}>
        <Seg<Picture> ariaLabel="My picture" value={app.picture} onChange={(v) => updateApp({ picture: v })} options={[{ v: 'cutout', label: PICTURE_LABELS.cutout }, { v: 'camera', label: PICTURE_LABELS.camera }]} />
      </Field>
      <div data-autozoom={autozoom ? 'on' : 'off'}>
        <Switch
          checked={autozoom}
          onChange={(v) => updateApp({ framing: v ? 'voice' : 'follow' })}
          label={AUTOZOOM_LABEL}
          hint={props.compact ? 'Off: your picture holds you head to chest, centred, and follows you with a smooth glide when you or the camera move — nothing zooms. On: a close-up on your face while you sing, out again in the breaks.' : 'Off (to start with): your picture holds you head to chest, centred, and stays that way — when you shift in your chair or the camera moves, the frame follows with one smooth glide; nothing zooms. On: a smooth close-up on your face while you sing, back out to head and chest in the breaks between phrases (a breath never moves it).'}
        />
      </div>
    </>
  );
}
