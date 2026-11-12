/**
 * The room's virtual stage, alive for the whole meet — not just the song. The stage exists from the
 * moment the meet does: whoever steps on a slot appears on it instantly (their camera opens, their
 * cut-out is drawn, their alpha-packed video goes out to the other performers and to any Publishing
 * show view), whether the host has started the song yet or not. The song, pauses, a late singer
 * stepping on mid-song are activities on this stage, in parallel with the show.
 *
 * One LocalFeed (camera → cut-out → framing), one StageCompositor and one PerformerMesh per room,
 * shared by the lobby's stage strip and the full live stage, so nothing reconnects when the song
 * starts. Audience devices draw the performers' placeholders (video is private to the stage).
 * Beside the stage runs the ShowRecorder: the saved performance of each song, the broadcast
 * picture with the whole mix, drawn from the same cut-outs (the other singers' vocals come over
 * the mesh for it — and are never played).
 */
import { SLOT_COLORS, type Meet, type Participant, type SingerSlot } from '@singersvoice/protocol';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { AudioEngine } from '../../audio/engine.ts';
import { backgroundById, backgroundSrc, backgrounds, loadBackgrounds } from '../../components/BackgroundPicker.tsx';
import { appSettings } from '../../state/settings.ts';
import { UnpackedFrame } from '../../video/alphaPack.ts';
import type { Camera } from '../../video/camera.ts';
import { LocalFeed } from '../../video/localFeed.ts';
import { PerformerMesh, type PeerState } from '../../video/peers.ts';
import type { SegmenterMode } from '../../video/segmenter.ts';
import { ShowRecorder } from '../../video/showRecorder.ts';
import { StageCompositor, type StagePerformer } from '../../video/stage.ts';
import type { MeetSession } from './meetSession.ts';

export interface RoomStage {
  feed: LocalFeed;
  compositor: StageCompositor;
  mesh: PerformerMesh | null;
  /** The saved performance of a song: the show picture with the whole mix, recorded on this device. */
  show: ShowRecorder;
  peerStates: Record<string, PeerState>;
  /** How my cut-out is made right now (model / soft-focus oval / loading / off). */
  blend: SegmenterMode;
  camOn: boolean;
  camStream: MediaStream | null;
  /** Why the camera did not open by itself (permission); the UI offers a button then. */
  camError: string | null;
  /** Open the camera from a user gesture (after a permission refusal, or on browsers that need the tap). */
  openCamera: () => Promise<void>;
  /** Performers whose video link is up / other performers on stage. */
  linked: number;
  others: number;
}

export function useRoomStage(session: MeetSession, meet: Meet, you: Participant, camera: Camera, opts: { preparing: boolean; level: () => number; engine: AudioEngine | null }): RoomStage {
  const feed = useMemo(() => new LocalFeed(), []);
  const compositor = useMemo(() => new StageCompositor('show'), []);
  const show = useMemo(() => new ShowRecorder(), []);
  // Every singer's link carries their vocal for the recording of the show (received, never played).
  const mesh = useMemo(() => (PerformerMesh.supported() ? new PerformerMesh(session, you.participantId, { wantAudio: true }) : null), [session, you.participantId]);
  const remoteVideos = useRef(new Map<string, { video: HTMLVideoElement; frame: UnpackedFrame }>());
  const [peerStates, setPeerStates] = useState<Record<string, PeerState>>({});
  const [blend, setBlend] = useState<SegmenterMode>('off');
  const [camError, setCamError] = useState<string | null>(null);
  const app = appSettings.value;
  const onStage = you.slot !== null;
  const camStream = camera.stream;
  const camOn = camera.on.value;
  const facing = camera.facing.value;

  // ---- camera follows the stage: open when I step on (if my setting says so), close when I step off ----
  /** A camera opened from a tap stays open a moment even before the slot is confirmed (no open/close flicker). */
  const holdUntil = useRef(0);
  /** One open at a time: the tap and the "now on stage" effect may both ask within the same second. */
  const opening = useRef<Promise<void> | null>(null);
  const openCamera = (): Promise<void> => {
    if (camera.on.value) return Promise.resolve();
    if (opening.current) return opening.current;
    holdUntil.current = Date.now() + 8000;
    opening.current = (async () => {
      try {
        await camera.open({ facing: app.cameraFacing, deviceId: app.cameraDeviceId || undefined });
        camera.setPreset(app.zoomPreset);
        setCamError(null);
      } catch (e) {
        setCamError(e instanceof Error ? e.message : String(e));
      } finally {
        opening.current = null;
      }
    })();
    return opening.current;
  };
  useEffect(() => {
    if (!onStage) {
      setCamError(null);
      if (opts.preparing || !camOn) return;
      const wait = holdUntil.current - Date.now();
      if (wait <= 0) {
        camera.close();
        return;
      }
      const t = setTimeout(() => camera.close(), wait);
      return () => clearTimeout(t);
    }
    if (app.cameraOn && !camOn && !opts.preparing) void openCamera();
    if (!app.cameraOn && camOn && !opts.preparing) camera.close();
  }, [onStage, app.cameraOn, camOn, opts.preparing]);

  // ---- my cut-out, framed by me; the packed stream goes to the mesh while I am on stage ----
  useEffect(() => {
    feed.onMode = (m) => setBlend(m);
    feed.attach(camOn ? camStream : null, true);
    if (camOn && camStream) {
      camera.startAutoFrame(feed.video);
      if (onStage) mesh?.setLocalStream(feed.packedStream());
    } else {
      camera.stopAutoFrame();
      mesh?.setLocalStream(null);
    }
  }, [camStream, camOn, onStage]);
  useEffect(() => feed.setFraming(app.zoomPreset, app.autoZoom), [app.zoomPreset, app.autoZoom]);
  const origin = camera.origin.value;
  useEffect(() => feed.setOrigin(origin), [origin.x, origin.y]);
  // Vocal-driven auto zoom: whoever sings comes closer, and everyone sees it (the sender frames its own stream).
  const levelRef = useRef(opts.level);
  levelRef.current = opts.level; // the audio engine only exists once the singer got ready
  useEffect(() => {
    const t = setInterval(() => feed.reportLevel(levelRef.current()), 100);
    return () => clearInterval(t);
  }, []);

  // ---- the performer mesh (video only; singers never hear each other), while I am on stage ----
  useEffect(() => {
    if (!mesh) return;
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
    mesh.onRemoteAudio = (id, stream) => show.setVocal(id, stream); // the recording's mix only — never the speakers
    (window as unknown as { __svMesh?: PerformerMesh; __svFeed?: LocalFeed }).__svMesh = mesh; // support / e2e hooks
    (window as unknown as { __svFeed?: LocalFeed }).__svFeed = feed;
    session.onLeave = () => mesh.close(); // goodbyes before the session leaves
    return () => {
      session.onLeave = null;
      void mesh.close();
      for (const r of remoteVideos.current.values()) {
        r.frame.dispose();
        r.video.srcObject = null;
        r.video.remove();
      }
      remoteVideos.current.clear();
      setPeerStates({});
    };
  }, [mesh]);
  useEffect(() => {
    if (!mesh) return;
    if (onStage) void mesh.start();
    else {
      void mesh.close();
      for (const r of remoteVideos.current.values()) {
        r.frame.dispose();
        r.video.srcObject = null;
        r.video.remove();
      }
      remoteVideos.current.clear();
      setPeerStates({});
    }
  }, [mesh, onStage]);
  useEffect(
    () => () => {
      feed.dispose();
      show.dispose();
    },
    [],
  );

  // The recording draws the same background the show view does (the meet's, as an image or looping video).
  const bgItems = backgrounds.value;
  useEffect(() => {
    void loadBackgrounds();
    const item = backgroundById(meet.backgroundId);
    show.setBackground(item ?? null, backgroundSrc(item));
  }, [meet.backgroundId, bgItems.length]);
  show.youLabel = you.displayName.split(' ')[0] || 'You';

  // My vocal (after FX) goes to publisher links only, from the moment my mic is open (I'm ready / singing).
  const micOpen = opts.engine?.micOpen.value ?? false;
  useEffect(() => {
    mesh?.setLocalAudio(micOpen && onStage ? (opts.engine?.vocalStream()?.getAudioTracks()[0] ?? null) : null);
  }, [mesh, micOpen, onStage, opts.engine]);

  const stagePerformers = meet.stage.filter((s) => s.participantId);
  const peerIds = stagePerformers.map((s) => s.participantId!).filter((id) => id !== you.participantId);
  const peerKey = peerIds.join(',');
  useEffect(() => {
    if (onStage) mesh?.setPeers(peerIds);
  }, [peerKey, onStage]);

  // Everyone on stage, left to right by slot, on one shared stage (placeholders for video I don't receive).
  // The recording gets the same people with the show view's labels (first names, no "You").
  useEffect(() => {
    const list: StagePerformer[] = stagePerformers.map((s) => {
      const me = s.participantId === you.participantId;
      const color = SLOT_COLORS[Math.max(1, Math.min(10, s.slot)) as SingerSlot];
      if (me) return { id: 'me', slot: s.slot, label: `You · S${s.slot}`, color, source: feed.source, mirror: facing === 'user', isMe: true };
      const r = remoteVideos.current.get(s.participantId!);
      return { id: s.participantId!, slot: s.slot, label: `${s.displayName.split(' ')[0] || 'Singer'} · S${s.slot}`, picture: s.picture, color, source: r ? { kind: 'frame', frame: r.frame } : { kind: 'none' } };
    });
    compositor.setPerformers(list);
    show.setPerformers(list.map((p) => ({ ...p, label: p.isMe ? 'You' : p.label.replace(/ · S\d+$/, '') })));
  }, [peerKey, stagePerformers.map((s) => `${s.slot}:${s.participantId}`).join('|'), camStream, camOn, facing, peerStates, you.participantId]);

  const others = peerIds.length;
  const linked = onStage ? peerIds.filter((id) => peerStates[id] === 'connected').length : 0;
  return { feed, compositor, mesh, show, peerStates, blend, camOn, camStream, camError, openCamera, linked, others };
}
