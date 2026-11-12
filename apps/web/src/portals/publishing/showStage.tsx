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
import { UnpackedFrame } from '../../video/alphaPack.ts';
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
  /** Each singer's vocal (after their FX), by participant — the broadcast mix is these plus the backing track. */
  vocals: Record<string, MediaStream>;
}

/** Receive every performer's video (the publisher never sends a camera) and lay them out as a show. */
export function useShowFeed(session: MeetSession, meet: Meet, you: Participant): ShowFeed {
  const compositor = useMemo(() => new StageCompositor('show'), []);
  const mesh = useMemo(() => (PerformerMesh.supported() ? new PerformerMesh(session, you.participantId, { receiveOnly: true }) : null), [session, you.participantId]);
  const remoteVideos = useRef(new Map<string, { video: HTMLVideoElement; frame: UnpackedFrame }>());
  const [peerStates, setPeerStates] = useState<Record<string, PeerState>>({});
  const [vocals, setVocals] = useState<Record<string, MediaStream>>({});

  useEffect(() => {
    if (!mesh) return;
    mesh.onRemoteAudio = (id, stream) =>
      setVocals((v) => {
        const next = { ...v };
        if (stream) next[id] = stream;
        else delete next[id];
        return next;
      });
    mesh.onRemote = (id, stream, state) => {
      let r = remoteVideos.current.get(id);
      if (stream) {
        if (!r) {
          const v = document.createElement('video');
          v.muted = true;
          v.playsInline = true;
          v.autoplay = true;
          v.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none';
          document.body.appendChild(v);
          r = { video: v, frame: new UnpackedFrame(v) };
          remoteVideos.current.set(id, r);
        }
        if (r.video.srcObject !== stream) {
          r.video.srcObject = stream;
          void r.video.play().catch(() => undefined);
        }
      } else if (r) {
        r.frame.dispose();
        r.video.srcObject = null;
        r.video.remove();
        remoteVideos.current.delete(id);
      }
      setPeerStates((s) => ({ ...s, [id]: state }));
    };
    void mesh.start();
    session.onLeave = () => mesh.close(); // goodbyes before the session leaves
    const w = window as unknown as { __svShowMeshes?: PerformerMesh[] }; // support / e2e hooks
    (w.__svShowMeshes ??= []).push(mesh);
    return () => {
      w.__svShowMeshes = (w.__svShowMeshes ?? []).filter((m) => m !== mesh);
      if (session.onLeave) session.onLeave = null;
      void mesh.close();
      for (const r of remoteVideos.current.values()) {
        r.frame.dispose();
        r.video.srcObject = null;
        r.video.remove();
      }
      remoteVideos.current.clear();
      setVocals({});
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
      const r = remoteVideos.current.get(s.participantId!);
      const color = SLOT_COLORS[Math.max(1, Math.min(10, s.slot)) as SingerSlot];
      return { id: s.participantId!, slot: s.slot, label: s.displayName.split(' ')[0] || 'Singer', picture: s.picture, color, source: r ? { kind: 'frame', frame: r.frame } : { kind: 'none' } };
    });
    compositor.setPerformers(list);
  }, [peerKey, stagePerformers.map((s) => `${s.slot}:${s.participantId}`).join('|'), peerStates]);

  const linked = stagePerformers.filter((s) => peerStates[s.participantId!] === 'connected').length;
  return { compositor, mesh, linked, onStage: stagePerformers.length, vocals };
}

/**
 * Plays the singers' vocals (hidden audio elements, one per singer) — the broadcast sound together
 * with the backing track. Muted when `on` is false (a Preview tile monitors silently by default).
 */
export function Vocals(props: { vocals: Record<string, MediaStream>; on: boolean }) {
  const els = useRef(new Map<string, HTMLAudioElement>());
  useEffect(() => {
    const seen = new Set(Object.keys(props.vocals));
    for (const [id, stream] of Object.entries(props.vocals)) {
      let a = els.current.get(id);
      if (!a) {
        a = document.createElement('audio');
        a.autoplay = true;
        a.style.display = 'none';
        document.body.appendChild(a);
        els.current.set(id, a);
      }
      if (a.srcObject !== stream) {
        a.srcObject = stream;
        void a.play().catch(() => undefined);
      }
      a.muted = !props.on;
    }
    for (const [id, a] of [...els.current]) {
      if (!seen.has(id)) {
        a.srcObject = null;
        a.remove();
        els.current.delete(id);
      }
    }
  }, [props.vocals, props.on]);
  useEffect(
    () => () => {
      for (const a of els.current.values()) {
        a.srcObject = null;
        a.remove();
      }
      els.current.clear();
    },
    [],
  );
  return null;
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
      {meet.state === 'lobby' && onStage > 0 && <div class="show-note">{meet.trackTitle ? `Up next: ${meet.trackTitle}` : 'On stage — picking the next song'}</div>}
      {!live && (
        <div class="show-center">
          {meet.state === 'lobby' && !onStage && (
            <>
              <h2>Nobody is on stage yet</h2>
              <p class="muted">The show is on: whoever steps on a slot in the meet room appears here at once — the host too.</p>
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
