/**
 * The TV page (/tv): what the TV in the room shows — its code and a QR of it until a singer connects, then
 * the singer's stage, big: the words on top and the stage picture below (or either alone, as the singer set
 * in Settings → TV). No sign-in: the TV is a screen, the singer's phone is the account (lib/tv.ts).
 *
 * /tv/<code> on a phone is the QR's door: the app connects to that TV and goes home; the next stage shows
 * on it by itself.
 */
import { useLocation } from 'preact-iso';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { LyricsPanel } from '../components/LyricsPanel.tsx';
import { href } from '../lib/nav.ts';
import { toast } from '../lib/toast.ts';
import { TvScreenClient, tvLink } from '../lib/tv.ts';

/** The QR's picture: an SVG of the link to this TV (`/tv/<code>`), drawn once per code. */
function Qr(props: { text: string }) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    let live = true;
    void import('qrcode-generator').then((m) => {
      if (!live) return;
      type Factory = (typeNumber: number, level: 'L' | 'M' | 'Q' | 'H') => { addData(s: string): void; make(): void; createSvgTag(o: { cellSize?: number; margin?: number; scalable?: boolean }): string };
      const mod = m as unknown as Record<string, unknown>;
      const make = (typeof mod === 'function' ? mod : mod.default) as Factory;
      const q = make(0, 'M');
      q.addData(props.text);
      q.make();
      setSvg(q.createSvgTag({ cellSize: 6, margin: 2, scalable: true }));
    });
    return () => {
      live = false;
    };
  }, [props.text]);
  // The library's SVG is ours (its own markup for the text we gave it).
  return <div class="tv-qr" aria-label={`QR code: ${props.text}`} dangerouslySetInnerHTML={{ __html: svg }} />;
}

export function TvScreen() {
  const client = useMemo(() => new TvScreenClient(), []);
  useEffect(() => {
    void client.start();
    // The screen stays awake while it is a TV.
    let lock: { release: () => Promise<void> } | null = null;
    const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } };
    void nav.wakeLock?.request('screen').then((l) => (lock = l)).catch(() => undefined);
    const bye = () => client.stop();
    window.addEventListener('pagehide', bye);
    return () => {
      window.removeEventListener('pagehide', bye);
      client.stop();
      void lock?.release().catch(() => undefined);
    };
  }, [client]);
  const state = client.state.value;
  const code = client.code.value;
  const name = client.name.value;
  const stream = client.stream.value;
  const song = client.song.value;
  const look = client.look.value;
  const link = `${location.origin}${import.meta.env.BASE_URL}tv/${code}`;
  // The stage shows once something of it has come: the picture, or a song's words (a phone linked from Home has neither yet).
  const ready = state === 'linked' && (client.pictureLive.value || song !== null);
  const showPicture = ready && look !== 'lyrics';
  const showLyrics = ready && look !== 'stage';
  return (
    <main class="tv" data-tv-state={state} data-tv-look={look} data-tv-ready={ready ? '1' : '0'}>
      {!ready && (
        <section class="tv-wait">
          <div class="tv-brand">SingersVoice</div>
          {state === 'registering' || state === 'offline' ? (
            <div class="tv-line">{state === 'offline' ? 'Cannot reach SingersVoice — trying again…' : 'Getting this TV its code…'}</div>
          ) : state === 'claimed' || state === 'linked' ? (
            <div class="tv-line" data-tv-claimed>
              <b>{name}</b>'s stage is coming — open a song on your phone.
            </div>
          ) : (
            <>
              <div class="tv-line">On your phone, on the stage, tap <b>TV</b> and type this code</div>
              <div class="tv-code" data-tv-code>
                {code.split('').map((ch, i) => (
                  <span key={i}>{ch}</span>
                ))}
              </div>
              <div class="tv-line small">or scan it with your phone's camera</div>
              {code && <Qr text={link} />}
            </>
          )}
        </section>
      )}
      {ready && (
        <section class="tv-stage" data-tv-linked>
          {showLyrics && (
            <div class="tv-lyrics">
              {song ? <LyricsPanel lines={song.lines} tMs={client.tMs} mySlot={song.mySlot} plan={song.plan} countdown={client.countdown.value} showWho={song.singerCount > 1} title={song.title} /> : <div class="tv-line">{name}'s stage — the words come with the song</div>}
            </div>
          )}
          {showPicture && <TvVideo stream={stream} />}
          <div class="tv-tag">
            SingersVoice · {name}
            {song ? ` · ${song.title}` : ''}
          </div>
        </section>
      )}
    </main>
  );
}

function TvVideo(props: { stream: MediaStream | null }) {
  const [el, setEl] = useState<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (!el) return;
    el.srcObject = props.stream;
    if (props.stream) void el.play().catch(() => undefined);
  }, [el, props.stream]);
  return <video ref={setEl} class="tv-video" autoPlay muted playsInline data-tv-video />;
}

/** /tv/<code> on a phone: connect to that TV and go home. */
export function TvCodeLink(props: { code: string }) {
  const loc = useLocation();
  useEffect(() => {
    void tvLink
      .connect(props.code)
      .then(() => toast(`TV ${props.code.toUpperCase()} connected — it shows your stage as soon as you are on one`, 'ok', 6000))
      .catch((e) => toast(e instanceof Error ? e.message : String(e), 'error', 8000))
      .finally(() => loc.route(href('/home'), true));
  }, [props.code]);
  return <div class="empty">Connecting to the TV…</div>;
}
