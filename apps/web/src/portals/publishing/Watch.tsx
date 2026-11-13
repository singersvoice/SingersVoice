/**
 * In-house watch portal (/watch/:id) — public, no sign-in. A stage show, never a karaoke screen:
 * no lyrics here (those belong to the singers on stage). When the publisher's show view is on air,
 * the show itself plays — every singer on the stage background, the track and their voices blended
 * (HLS, a few seconds behind). Otherwise the stage background and line-up, with **Hear the stage**:
 * the host's mix a couple of seconds behind. Plus the chat (read-only here; sign in and join the
 * meet to talk).
 */
import { formatMs, SLOT_COLORS, type SingerSlot, type WatchResponse } from '@singersvoice/protocol';
import { useEffect, useRef, useState } from 'preact/hooks';
import { getEngine } from '../../audio/engine.ts';
import { MixPlayer, mixPlaySupported } from '../../audio/mixPlayer.ts';
import { StageBackground } from '../../components/BackgroundPicker.tsx';
import { IcHeadphones, IcUsers } from '../../components/icons.tsx';
import { LiveShow, useLiveStatus, type LiveShowState } from '../../components/LiveShow.tsx';
import { Logo } from '../../components/Shell.tsx';
import { Spinner } from '../../components/ui.tsx';
import { api, controlConfigured, serverNow, syncClock } from '../../lib/api.ts';
import { asset, href } from '../../lib/nav.ts';
import { signedIn } from '../../state/session.ts';

export function Watch(props: { id: string }) {
  const [data, setData] = useState<WatchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tMs, setTMs] = useState(0);
  const liveStatus = useLiveStatus(props.id);
  const [show, setShow] = useState<LiveShowState>({ live: false, audio: false, playing: false });

  useEffect(() => {
    if (!controlConfigured.value) return;
    let stopped = false;
    void syncClock(3);
    const poll = async () => {
      try {
        const r = await api.get('GET /watch/:id', `/watch/${encodeURIComponent(props.id)}`);
        if (!stopped) setData(r);
      } catch (e) {
        if (!stopped) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void poll();
    const t = setInterval(() => void poll(), 4000);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [props.id]);

  // Hear the stage: the host's mix, fetched a second at a time (a tap starts the sound — browsers want a gesture).
  // While the show plays with its own sound, the mix stays off: the show is the sound.
  const [listen, setListen] = useState(false);
  const mixRef = useRef<MixPlayer | null>(null);
  const [mix, setMix] = useState<{ hearing: boolean; silent: boolean; behindS: number; seq: number }>({ hearing: false, silent: false, behindS: 0, seq: 0 });
  const showHasSound = show.playing && show.audio;
  useEffect(() => {
    if (!listen || showHasSound || !mixPlaySupported()) return;
    const e = getEngine();
    void e.resume();
    const mp = new MixPlayer(e.ctx, e.master, async (since) => api.get('GET /watch/:id/mix', `/watch/${encodeURIComponent(props.id)}/mix?since=${since}`));
    mixRef.current = mp;
    mp.start();
    const t = setInterval(() => setMix({ ...mp.state.value }), 500);
    return () => {
      clearInterval(t);
      mp.stop();
      mixRef.current = null;
    };
  }, [listen, showHasSound, props.id]);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const heard = mixRef.current?.positionMs() ?? null;
      const ks = data?.meet.kickstartEpochMs ?? null;
      setTMs(heard ?? (ks === null ? 0 : serverNow() - ks)); // what you read follows what you hear
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [data?.meet.kickstartEpochMs]);

  const m = data?.meet;
  return (
    <div class="shell nonav">
      <header class="topbar">
        <Logo />
        <div class="title">{m?.title ?? 'SingersVoice live'}</div>
        {!signedIn.value ? (
          <a class="btn sm primary" href={href('/')}>
            Sign in to join
          </a>
        ) : (
          <a class="btn sm" href={href(`/meet/${encodeURIComponent(props.id)}`)}>
            Join the meet
          </a>
        )}
      </header>
      <main class="content">
        {!controlConfigured.value && <div class="callout warn">The watch portal needs the SingersVoice service.</div>}
        {error && <div class="callout danger">{error}</div>}
        {!m && !error && controlConfigured.value && (
          <div class="row">
            <Spinner /> Loading…
          </div>
        )}
        {m && (
          <div class="stack">
            <div class="watch-stage">
              <StageBackground id={m.backgroundId} />
              <img class="logo" src={asset('brand/sv-mark.png')} alt="" />
              <LiveShow meetId={props.id} status={liveStatus} onState={setShow}>
                <div class="watch-center">
                  <div class="stack" style="text-align:center;justify-items:center">
                    <span class={`chip ${m.state === 'live' ? 'ok' : ''}`}>{m.state}</span>
                    <p class="muted">
                      {m.state === 'live' || m.state === 'countdown'
                        ? `${m.trackTitle ? `${m.trackTitle} — ` : ''}the show appears here once the publisher goes live; meanwhile, hear the stage below.`
                        : m.state === 'lobby'
                          ? 'The singers are picking the next song.'
                          : 'This meet has ended.'}
                    </p>
                  </div>
                </div>
              </LiveShow>
              <div class="watch-lineup">
                {m.stage.filter((s) => s.participantId).map((s) => (
                  <span key={s.slot} class="chip" style={{ borderColor: SLOT_COLORS[s.slot as SingerSlot] }}>
                    S{s.slot} {s.displayName}
                  </span>
                ))}
                <span class="chip">
                  <IcUsers size={14} /> {m.audienceCount}
                </span>
              </div>
            </div>
            <div class="row between">
              <div class="small muted">
                Host {m.hostName} · {m.trackTitle || 'no track'} {m.kickstartEpochMs !== null && m.state === 'live' ? `· ${formatMs(Math.max(0, tMs))}` : ''}
              </div>
              {showHasSound ? (
                <span class="chip ok">The show's own sound</span>
              ) : (
                mixPlaySupported() && (
                  <button class={`btn sm ${listen ? 'on' : 'primary'}`} aria-pressed={listen} data-mix-hearing={mix.hearing ? '1' : '0'} data-mix-seq={mix.seq} onClick={() => setListen((l) => !l)}>
                    <IcHeadphones size={14} /> {listen ? (mix.hearing ? `Hearing the stage · ${mix.behindS.toFixed(1)} s behind` : mix.silent ? 'No sound from the stage yet' : 'Tuning in…') : 'Hear the stage'}
                  </button>
                )
              )}
            </div>
            <section class="card stack">
              <h3>Chat</h3>
              <div class="chat-log">
                {!data?.chat.length && <div class="muted small">Quiet so far.</div>}
                {data?.chat.map((c) => (
                  <div key={c.seq} class="chat-msg">
                    <b>{c.displayName}</b> <div>{c.text}</div>
                  </div>
                ))}
              </div>
              <div class="small faint">Sign in and join the meet to chat.</div>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
