/**
 * The broadcast picture of a meet, shared by the Publishing show view (full screen) and the Preview
 * tab's monitor tiles: every performer's video pulled over the receive-only mesh, drawn huge on the
 * meet's stage background in the compositor's "show" layout, no lyrics — plus the only things a
 * broadcast audience should see besides the singers: the countdown opener, "paused", "show over".
 * Status badges and controls belong to the chrome around it, never to the picture.
 */
import { SLOT_COLORS, type Meet, type Participant, type SingerSlot } from '@singersvoice/protocol';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { StageBackground } from '../../components/BackgroundPicker.tsx';
import { VirtualStage } from '../../components/VirtualStage.tsx';
import { serverNow } from '../../lib/api.ts';
import { PerformerMesh, type PeerState } from '../../video/peers.ts';
import { StageCompositor, type StagePerformer } from '../../video/stage.ts';
import type { MeetSession } from '../meets/meetSession.ts';

export interface ShowFeed {
  compositor: StageCompositor;
  mesh: PerformerMesh | null;
  /** Performers whose video link is up. */
  linked: number;
  /** Performers on stage. */
  onStage: number;
}

/** Receive every performer's video (the publisher never sends a camera) and lay them out as a show. */
export function useShowFeed(session: MeetSession, meet: Meet, you: Participant): ShowFeed {
  const compositor = useMemo(() => new StageCompositor('show'), []);
  const mesh = useMemo(() => (PerformerMesh.supported() ? new PerformerMesh(session, you.participantId, true) : null), [session, you.participantId]);
  const remoteVideos = useRef(new Map<string, HTMLVideoElement>());
  const [peerStates, setPeerStates] = useState<Record<string, PeerState>>({});

  useEffect(() => {
    if (!mesh) return;
    mesh.onRemote = (id, stream, state) => {
      let v = remoteVideos.current.get(id);
      if (stream) {
        if (!v) {
          v = document.createElement('video');
          v.muted = true;
          v.playsInline = true;
          v.autoplay = true;
          v.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none';
          document.body.appendChild(v);
          remoteVideos.current.set(id, v);
        }
        if (v.srcObject !== stream) {
          v.srcObject = stream;
          void v.play().catch(() => undefined);
        }
      } else if (v) {
        v.srcObject = null;
        v.remove();
        remoteVideos.current.delete(id);
      }
      setPeerStates((s) => ({ ...s, [id]: state }));
    };
    void mesh.start();
    return () => {
      mesh.close();
      for (const v of remoteVideos.current.values()) {
        v.srcObject = null;
        v.remove();
      }
      remoteVideos.current.clear();
    };
  }, [mesh]);

  const stagePerformers = meet.stage.filter((s) => s.participantId);
  const peerIds = stagePerformers.map((s) => s.participantId!);
  const peerKey = peerIds.join(',');
  useEffect(() => {
    mesh?.setPeers(peerIds);
  }, [peerKey]);

  // Everyone on stage, left to right by slot — huge, like a stage show (no "me": the publisher is not a performer).
  useEffect(() => {
    const list: StagePerformer[] = stagePerformers.map((s) => {
      const v = remoteVideos.current.get(s.participantId!);
      const color = SLOT_COLORS[Math.max(1, Math.min(10, s.slot)) as SingerSlot];
      return { id: s.participantId!, slot: s.slot, label: s.displayName.split(' ')[0] || 'Singer', picture: s.picture, color, source: v ? { kind: 'packed', video: v } : { kind: 'none' } };
    });
    compositor.setPerformers(list);
  }, [peerKey, stagePerformers.map((s) => `${s.slot}:${s.participantId}`).join('|'), peerStates]);

  const linked = stagePerformers.filter((s) => peerStates[s.participantId!] === 'connected').length;
  return { compositor, mesh, linked, onStage: stagePerformers.length };
}

/** Seconds to the kickstart while the meet counts down (null otherwise), ticking 5× a second. */
export function useCountdown(meet: Meet): number | null {
  const [countdown, setCountdown] = useState<number | null>(null);
  useEffect(() => {
    if (meet.state !== 'countdown' || meet.kickstartEpochMs === null) {
      setCountdown(null);
      return;
    }
    const tick = () => setCountdown(Math.max(0, Math.ceil((meet.kickstartEpochMs! - serverNow()) / 1000)));
    tick();
    const t = setInterval(tick, 200);
    return () => clearInterval(t);
  }, [meet.state, meet.kickstartEpochMs]);
  return countdown;
}

/** The picture itself — what goes out. Fills its positioned parent. */
export function ShowPicture(props: { meet: Meet; compositor: StageCompositor; countdown: number | null; children?: preact.ComponentChildren }) {
  const { meet } = props;
  const live = meet.state === 'live';
  const over = meet.state === 'ended' || meet.state === 'expired';
  const paused = meet.playback?.state === 'paused';
  const onStage = meet.stage.filter((s) => s.participantId).length;
  return (
    <div class="showpic" data-state={meet.state}>
      <StageBackground id={meet.backgroundId} />
      <VirtualStage compositor={props.compositor} />
      {meet.state === 'lobby' && onStage > 0 && <div class="show-note">On stage — the song has not started yet</div>}
      {!live && (
        <div class="show-center">
          {meet.state === 'lobby' && !onStage && (
            <>
              <h2>Waiting for the singers</h2>
              <p class="muted">The show is on: whoever steps on stage appears here at once.</p>
            </>
          )}
          {meet.state === 'countdown' && props.countdown !== null && (
            <>
              <div class="show-count">{props.countdown || 'GO'}</div>
              <p class="muted">{meet.trackTitle}</p>
            </>
          )}
          {over && (
            <>
              <h2>{meet.state === 'expired' ? 'The meet closed' : 'Show over'}</h2>
              <p class="muted">Thanks for watching {meet.title}.</p>
              {props.children}
            </>
          )}
        </div>
      )}
      {live && paused && <div class="show-note">Paused by the host</div>}
    </div>
  );
}
