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
import { meetIsOpen, SLOT_COLORS, type Meet, type Participant, type PerformanceSinger, type SingerSlot } from '@singersvoice/protocol';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { AudioEngine } from '../../audio/engine.ts';
import { backgroundById, backgroundSrc, backgrounds, loadBackgrounds } from '../../components/BackgroundPicker.tsx';
import { needsReconnect } from '../../state/session.ts';
import { appSettings } from '../../state/settings.ts';
import { UnpackedFrame } from '../../video/alphaPack.ts';
import type { Camera } from '../../video/camera.ts';
import { LocalFeed, type FeedHealth } from '../../video/localFeed.ts';
import { MeetRecorder, stageSound } from '../../video/meetRecorder.ts';
import { PerformerMesh, type PeerState } from '../../video/peers.ts';
import type { SegmenterMode } from '../../video/segmenter.ts';
import { ShowRecorder } from '../../video/showRecorder.ts';
import { StageCompositor, type StagePerformer } from '../../video/stage.ts';
import { registerMeetFilm } from './liveTake.ts';
import type { MeetSession } from './meetSession.ts';

export interface RoomStage {
  feed: LocalFeed;
  compositor: StageCompositor;
  mesh: PerformerMesh | null;
  /** The saved performance of a song: the show picture with the whole mix, recorded on this device. */
  show: ShowRecorder;
  /** The film of the whole meet (runs on the host's device while the host is on stage; see video/meetRecorder.ts). */
  film: MeetRecorder;
  peerStates: Record<string, PeerState>;
  /** How my cut-out is made right now (model / soft-focus oval / loading / off). */
  blend: SegmenterMode;
  /** The stage frame's word on my distance to the camera: 'close' — sit back; 'far' — come closer; null — fine. */
  distance: 'close' | 'far' | null;
  camOn: boolean;
  camStream: MediaStream | null;
  /** Why the camera did not open by itself (permission); the UI offers a button then. */
  camError: string | null;
  /** Open the camera from a user gesture (after a permission refusal, or on browsers that need the tap). */
  openCamera: () => Promise<void>;
  /** The camera's health (localFeed.ts): anything but 'ok' and the stage restarts it once by itself; the strip offers a button after that. */
  camHealth: FeedHealth;
  /** The camera again, from a tap (after it froze or went dark). */
  restartCamera: () => Promise<void>;
  /** Performers whose video link is up / other performers on stage. */
  linked: number;
  others: number;
  /** Other performers whose picture arrives but has not moved for a while (their camera froze on their device), by participant id. */
  still: string[];
  /** My camera, in words (frame rate, the cut-out, a picture standing still), refreshed every second while it is on. */
  cameraLine: string;
  /** Make the video link to a performer again from scratch (a plain Reconnect for a picture that stands still). */
  reconnect: (id: string) => void;
}

export function useRoomStage(session: MeetSession, meet: Meet, you: Participant, camera: Camera, opts: { preparing: boolean; engine: AudioEngine | null; restartCamera: () => Promise<void> }): RoomStage {
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
    if (camOn && camStream && onStage) mesh?.setLocalStream(feed.packedStream());
    else if (!camOn || !camStream) mesh?.setLocalStream(null);
  }, [camStream, camOn, onStage]);
  // The stage frame's word on my distance to the camera (sit back / come closer), for the stage strip.
  const [distance, setDistance] = useState<'close' | 'far' | null>(null);
  useEffect(() => {
    feed.onNote = setDistance;
    return () => {
      feed.onNote = null;
    };
  }, []);
  // Another performer's picture standing still (frames arriving, nothing moving: their camera froze on their device): said on the strip, with Reconnect.
  const [still, setStill] = useState<string[]>([]);
  useEffect(() => {
    compositor.onStill = setStill;
    return () => {
      compositor.onStill = null;
    };
  }, [compositor]);
  const reconnect = (id: string) => mesh?.remake(id);
  // My camera's own line on the strip, once a second while it is on: what it does is never a guess.
  const [cameraLine, setCameraLine] = useState('');
  useEffect(() => {
    if (!camOn || !onStage) {
      setCameraLine('');
      return;
    }
    const t = setInterval(() => setCameraLine(feed.cameraLine), 1000);
    return () => clearInterval(t);
  }, [camOn, onStage, feed]);
  // ---- the camera's health: a camera the browser muted or ended, or one frozen on a picture, is restarted — once by itself, then from a tap ----
  const [camHealth, setCamHealth] = useState<FeedHealth>('ok');
  const restarting = useRef<Promise<void> | null>(null);
  const autoRestartAt = useRef(0);
  const latest = useRef(opts); // the newest engine/camera pairing, for a restart fired from an older closure
  latest.current = opts;
  const restartCamera = (): Promise<void> => {
    if (restarting.current) return restarting.current;
    restarting.current = latest.current
      .restartCamera()
      .then(() => setCamError(null))
      .catch((e) => setCamError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        restarting.current = null;
      });
    return restarting.current;
  };
  useEffect(() => {
    feed.onHealth = (h) => {
      setCamHealth(h);
      if (h === 'ok' || !onStage || !camOn) return;
      // one restart by itself per minute: a camera that stays frozen gets the button, not a loop of prompts
      if (Date.now() - autoRestartAt.current < 60_000) return;
      autoRestartAt.current = Date.now();
      void restartCamera();
    };
    return () => {
      feed.onHealth = null;
    };
  }, [onStage, camOn]);

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
    mesh.onRemoteAudio = (id, stream) => show.setVocal(id, stream); // the mix always; the speakers only between songs (talk-back)
    // Instant: what one singer changes (the background, the song, the transport) reaches the others and the show view
    // over the mesh at once — they fetch the new state now — and what they change reaches this device the same way.
    mesh.onMessage = (_from, m) => {
      if (m.type === 'changed') session.poke();
    };
    session.onActed = () => {
      (window as unknown as { __svSaid?: number }).__svSaid = mesh.say({ type: 'changed' }); // support / e2e: how many peers were told
    };
    (window as unknown as { __svMesh?: PerformerMesh; __svFeed?: LocalFeed }).__svMesh = mesh; // support / e2e hooks
    (window as unknown as { __svFeed?: LocalFeed }).__svFeed = feed;
    session.onLeave = () => mesh.close(); // goodbyes before the session leaves
    return () => {
      session.onLeave = null;
      session.onActed = null;
      mesh.onMessage = null;
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
  // The mix balance this device records and relays at: the singer's Track / Vocal controls.
  useEffect(() => show.setBalance(app.trackDb, app.vocalDb), [app.trackDb, app.vocalDb]);
  // The host's device sends the mix to the audience (nobody on stage ever hears it).
  show.broadcast = you.userId === meet.hostUserId ? (b) => session.sendMix(b) : null;

  // My vocal (after FX) goes out over the mesh from the moment my mic is open on stage: to the other
  // singers (heard between songs only — talk-back), to the host's mix (the audience) and to a publisher.
  const micOpen = opts.engine?.micOpen.value ?? false;
  useEffect(() => {
    mesh?.setLocalAudio(micOpen && onStage ? (opts.engine?.vocalStream()?.getAudioTracks()[0] ?? null) : null);
  }, [mesh, micOpen, onStage, opts.engine]);
  // Talk-back: the singers on stage hear each other until the countdown; from then to the end of the
  // song nobody on stage hears anyone (Solo foldback). The host's device keeps ONE mix going for the
  // audience the whole time it is on stage with the mic open — the talk between songs, the count-in,
  // the song (whose recording hooks onto the same bus) — so what the audience hears never breaks off
  // at a song's start: a torn-down bus used to leave them a silence of a count-in and a restart.
  const songRunning = meet.state === 'countdown' || meet.state === 'live';
  const host = you.userId === meet.hostUserId;
  useEffect(() => {
    show.setHearOthers(onStage && !songRunning);
  }, [show, onStage, songRunning]);
  useEffect(() => {
    const engine = opts.engine;
    if (!host || !onStage || !micOpen || !engine) return;
    show.startTalk(engine);
    return () => show.stopTalk();
  }, [show, host, onStage, micOpen, opts.engine]);

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

  // ---- the film of the meet (the host's device): the whole meet as one video in the host's Drive ----
  const film = useMemo(() => new MeetRecorder(show), [show]);
  useEffect(() => {
    (window as unknown as { __svStage?: unknown }).__svStage = { show, engine: opts.engine, film }; // support / e2e: the mix this device builds, the film of the meet
  }, [show, opts.engine, film]);
  const filmWanted = app.recordMeet;
  const meetOpen = meetIsOpen(meet);
  /** Everyone who stood on stage while the film ran (the manifest names them). */
  const filmSingers = useRef(new Map<number, PerformanceSinger>());
  useEffect(() => {
    if (!film.recording) return;
    for (const s of stagePerformers) filmSingers.current.set(s.slot, { slot: s.slot, displayName: s.displayName });
  }, [film.recording, stagePerformers.map((s) => `${s.slot}:${s.participantId}`).join('|')]);
  const driveLinked = !needsReconnect.value; // a Drive session that lapsed and came back starts the film then
  useEffect(() => {
    const engine = opts.engine;
    if (!host || !onStage || !engine || !filmWanted || !meetOpen || !driveLinked) return;
    filmSingers.current = new Map(stagePerformers.map((s) => [s.slot, { slot: s.slot, displayName: s.displayName }]));
    void film.start(stageSound(engine, show), { meetId: meet.meetId, title: meet.title, hostName: meet.hostName, singers: () => [...filmSingers.current.values()].sort((a, b) => a.slot - b.slot) });
  }, [film, host, onStage, opts.engine, filmWanted, meetOpen, driveLinked]);
  const endFilm = () => {
    const singers = [...filmSingers.current.values()].sort((a, b) => a.slot - b.slot);
    void film.stop().then((saved) => saved && registerMeetFilm({ saved, meet: { meetId: meet.meetId, title: meet.title, hostName: meet.hostName }, singers, session }));
  };
  useEffect(() => {
    if (!meetOpen || !onStage || !filmWanted) endFilm();
  }, [meetOpen, onStage, filmWanted]);
  useEffect(() => () => endFilm(), [film]);

  const others = peerIds.length;
  const linked = onStage ? peerIds.filter((id) => peerStates[id] === 'connected').length : 0;
  return { feed, compositor, mesh, show, film, peerStates, blend, distance, camOn, camStream, camError, openCamera, camHealth, restartCamera, linked, others, still, reconnect, cameraLine };
}
