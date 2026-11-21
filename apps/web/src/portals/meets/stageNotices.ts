/**
 * What the room's stage has to say, raised as notices (lib/notices.ts) from what the stage and the session know,
 * and taken down the moment it no longer holds. Critical: this device's own camera failed or froze, the link to
 * the service is down or the service cannot save, a singer's picture froze on their device (with Reconnect).
 * Warn: sit back / come closer, soft-focus mode, a pause on its way, a jump on its way, the video hours nearly
 * used up, the voice alone on stage and why. Info: the mix, the timing, the camera's line, blending, talk-back,
 * the wait list, the hours left. Shown by one control (components/NoticeCenter.tsx).
 */
import type { Meet } from '@singersvoice/protocol';
import { useEffect } from 'preact/hooks';
import { formatMs, hoursLabel } from '@singersvoice/protocol';
import { serviceNotice } from '../../lib/api.ts';
import { clearNotices, setNotice } from '../../lib/notices.ts';
import type { MeetSession } from './meetSession.ts';
import type { RoomStage } from './roomStage.ts';

export interface LiveNoticeContext {
  paused: boolean;
  pauseCued: boolean;
  seekTarget: number | null;
  talkback: boolean;
  requests: number;
  softFocus: boolean;
}

export function useStageNotices(stage: RoomStage, meet: Meet, session: MeetSession, onStage: boolean, live: LiveNoticeContext | null): void {
  const video = session.yourVideo.value;
  const link = session.link.value;
  const notice = serviceNotice.value;
  const stillKey = stage.still.join(',');
  const names = (id: string) => meet.stage.find((s) => s.participantId === id)?.displayName.split(' ')[0] || 'A singer';

  // ---- the link to the service ----
  useEffect(() => {
    if (link === 'storage_limit' || notice?.kind === 'storage_limit') setNotice('link', { severity: 'critical', text: 'The service cannot save anything more today', detail: notice?.message ?? 'Its daily storage allowance is spent; it starts over at 00:00 UTC. The stage runs on; nothing new is kept until then.' });
    else if (link === 'offline') setNotice('link', { severity: 'critical', text: 'No answer from the SingersVoice service — trying again', detail: 'Your connection, or the service, is down right now. The stage keeps going on what it has.' });
    else if (link === 'failing') setNotice('link', { severity: 'critical', text: 'The SingersVoice service answered with a failure — trying again', detail: session.error.value ?? undefined });
    else setNotice('link', null);
  }, [link, notice?.kind, notice?.message]);

  // ---- this device's camera ----
  useEffect(() => {
    if (!onStage) {
      for (const id of ['cam-error', 'cam-health', 'cam-blend', 'cam-soft', 'cam-distance', 'cam-line']) setNotice(id, null);
      return;
    }
    setNotice('cam-error', stage.camError && stage.videoAllowed ? { severity: 'warn', text: `Camera: ${stage.camError}`, action: { label: 'Open the camera', run: () => void stage.openCamera() } } : null);
    setNotice('cam-health', stage.camOn && stage.camHealth !== 'ok' ? { severity: 'critical', text: stage.camHealth === 'frozen' ? 'Your camera froze — restart it' : stage.camHealth === 'muted' ? 'Your camera was muted by the browser — restart it' : 'Your camera stopped — restart it', detail: 'The stage restarts it once by itself; after that the restart is yours.', action: { label: 'Restart camera', run: () => void stage.restartCamera() } } : null);
    setNotice('cam-blend', stage.camOn && stage.blend === 'loading' ? { severity: 'info', text: 'Blending you into the stage…' } : null);
    setNotice('cam-soft', live?.softFocus ? { severity: 'warn', text: 'Soft-focus mode', detail: 'The cut-out model could not run on this device (its graphics are busy or unavailable): your picture is framed with a soft edge instead.', dismissible: true } : null);
    setNotice('cam-distance', stage.distance ? { severity: 'warn', text: stage.distance === 'close' ? 'Sit back a little — the stage shows what your camera sees' : 'Come a little closer to the camera' } : null);
    setNotice('cam-line', stage.camOn && stage.cameraLine ? { severity: 'info', text: stage.cameraLine, detail: 'Your camera, in words: frame rate, how the cut-out is made, a picture standing still.', dismissible: true } : null);
  }, [onStage, stage.camError, stage.videoAllowed, stage.camOn, stage.camHealth, stage.blend, live?.softFocus, stage.distance, stage.cameraLine]);

  // ---- the others' pictures ----
  useEffect(() => {
    const ids = new Set(stage.still);
    for (const id of ids) setNotice(`still:${id}`, { severity: 'critical', text: `${names(id)}'s picture is not moving — their camera froze on their device`, detail: 'Their picture arrives but nothing in it moves. It restarts there by itself, or they tap Restart on their stage; Reconnect makes the video link again from here.', action: { label: 'Reconnect', run: () => stage.reconnect(id) } });
    return () => {
      for (const id of ids) setNotice(`still:${id}`, null);
    };
  }, [stillKey, onStage]);

  // ---- the voice and the picture on stage: the plan's word ----
  useEffect(() => {
    if (!onStage) {
      setNotice('video-plan', null);
      setNotice('video-left', null);
      return;
    }
    const planOnly = !stage.videoAllowed && (video?.reason ?? 'plan') === 'plan';
    const note = planOnly ? '' : video?.note || '';
    setNotice('video-plan', !stage.videoAllowed && !planOnly ? { severity: 'warn', text: 'Audio only — no camera on this stage', detail: note || undefined } : null);
    setNotice('video-left', stage.videoAllowed && video && video.leftSeconds !== null ? { severity: video.leftSeconds < 1800 ? 'warn' : 'info', text: `Video · ${hoursLabel(video.leftSeconds)} left this month`, detail: 'Your plan’s video hours: the clock runs while you are on stage with the picture on.', dismissible: video.leftSeconds >= 1800 } : null);
  }, [onStage, stage.videoAllowed, video?.reason, video?.note, video?.leftSeconds]);

  // ---- the mix and the timing (diagnostics a singer may take down) ----
  useEffect(() => {
    setNotice('mix', onStage && stage.mixLine ? { severity: 'info', text: stage.mixLine, detail: 'What each source brings to this device’s mix right now — what the audience and the film get from here.', dismissible: true } : null);
    setNotice('align', onStage && stage.alignLine ? { severity: 'info', text: `Timed · ${stage.alignLine}`, detail: 'Each other singer’s voice and picture held back by what they are early by, so every voice lands on the beat it was sung to; the lag is what this device’s own voice and picture wait.', dismissible: true } : null);
  }, [onStage, stage.mixLine, stage.alignLine]);

  // ---- the song's transport, on the live stage ----
  useEffect(() => {
    if (!live) {
      for (const id of ['paused', 'talkback', 'pausing', 'jumping', 'waitlist']) setNotice(id, null);
      return;
    }
    setNotice('paused', live.paused ? { severity: 'info', text: 'Paused' } : null);
    setNotice('talkback', live.paused && live.talkback ? { severity: 'info', text: 'Talk-back on until Resume', detail: 'While the song is paused the singers on stage hear each other; from the resume to the end of the song nobody on stage hears anyone else.' } : null);
    setNotice('pausing', !live.paused && live.pauseCued ? { severity: 'warn', text: 'Pausing…' } : null);
    setNotice('jumping', live.seekTarget !== null && !live.paused ? { severity: 'warn', text: `Jumping to ${formatMs(live.seekTarget)}…` } : null);
    setNotice('waitlist', live.requests > 0 ? { severity: 'info', text: `Wait list · ${live.requests} — seated when the song is over` } : null);
  }, [live?.paused, live?.talkback, live?.pauseCued, live?.seekTarget, live?.requests, live === null]);

  // Leaving the room: nothing left behind.
  useEffect(() => () => clearNotices(), []);
}
