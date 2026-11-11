import { useEffect, useState } from 'preact/hooks';
import { googleConfigured } from '../lib/google.ts';
import { asset, go } from '../lib/nav.ts';
import { persistStorage, platformName } from '../lib/platform.ts';
import { errorText, toast } from '../lib/toast.ts';
import { busy, continueOnDevice, isDrive, profile, provider, signInWithGoogle, signedIn } from '../state/session.ts';
import { appSettings, pullSettings, updateApp } from '../state/settings.ts';
import { IcCamera, IcCheck, IcDrive, IcHeadphones, IcMic } from '../components/icons.tsx';
import { Logo } from '../components/Shell.tsx';
import { Spinner } from '../components/ui.tsx';

export function Welcome() {
  useEffect(() => {
    if (!signedIn.value) return;
    let next = appSettings.value.onboarded ? '/home' : '/setup';
    try {
      const saved = sessionStorage.getItem('sv.afterSignIn');
      if (saved && appSettings.value.onboarded) {
        sessionStorage.removeItem('sv.afterSignIn');
        window.location.replace(saved);
        return;
      }
    } catch {
      /* ignore */
    }
    go(next, true);
  }, [signedIn.value]);

  const onGoogle = async () => {
    try {
      await signInWithGoogle();
      await pullSettings();
      go('/setup', true);
    } catch (e) {
      toast(errorText(e), 'error', 7000);
    }
  };

  return (
    <div class="welcome">
      <div class="hero">
        <Logo word={false} />
        <div class="loop">
          <video src={asset('brand/sv-loop.mp4')} poster={asset('brand/poster.jpg')} muted loop autoPlay playsInline aria-hidden="true" />
        </div>
        <h1>
          Singers<span style="color:var(--accent)">Voice</span>
        </h1>
        <p class="muted">Lyrics-first karaoke. Sing solo now, sing together on stage next — every take lands in your own Google Drive.</p>
      </div>
      <div class="actions">
        <button class="btn primary lg block" disabled={busy.value !== null || !googleConfigured} onClick={() => void onGoogle()}>
          {busy.value ? <Spinner /> : <IcDrive />}
          {busy.value ?? 'Continue with Google'}
        </button>
        <p class="small muted" style="text-align:center">
          Google sign-in is required: your tracks, takes and settings are stored in <b>your</b> Google Drive (folder <span class="kbd">SingersVoice</span>), never on our servers.
        </p>
        {!googleConfigured && (
          <>
            <button class="btn lg block" onClick={() => (continueOnDevice(), go('/setup', true))}>
              Developer preview on this {platformName === 'Web' ? 'browser' : platformName} (no Google client configured)
            </button>
            <p class="small faint" style="text-align:center">
              This build has no VITE_GOOGLE_CLIENT_ID. Files stay in this browser until it is set — see docs/GOOGLE_OAUTH.md.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

type Check = 'idle' | 'ok' | 'warn' | 'busy';

export function Setup() {
  const [mic, setMic] = useState<Check>('idle');
  const [cam, setCam] = useState<Check>('idle');
  const [store, setStore] = useState<Check>('idle');
  const [links, setLinks] = useState<{ root?: string; tracks?: string }>({});

  useEffect(() => {
    if (!signedIn.value) {
      go('/', true);
      return;
    }
    void (async () => {
      try {
        await provider.value.ready();
        setLinks(provider.value.links());
      } catch (e) {
        toast(errorText(e), 'error');
      }
      setStore((await persistStorage()) ? 'ok' : 'warn');
    })();
  }, []);

  const testMic = async () => {
    setMic('busy');
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      setMic('ok');
    } catch {
      setMic('warn');
      toast('Microphone permission was denied — allow it in the browser site settings', 'warn', 6000);
    }
  };
  const testCam = async () => {
    setCam('busy');
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
      s.getTracks().forEach((t) => t.stop());
      setCam('ok');
    } catch {
      setCam('warn');
    }
  };
  const finish = () => {
    updateApp({ onboarded: true });
    go('/home', true);
  };

  const p = profile.value;
  return (
    <div class="welcome">
      <div class="hero" style="align-content:start;text-align:left;justify-items:stretch">
        <Logo />
        <h1>Let's set up your stage</h1>
        <div class="steps">
          <div class={`step ${isDrive.value ? 'ok' : 'warn'}`}>
            <div class="n">{isDrive.value ? <IcCheck size={18} /> : '1'}</div>
            <div>
              <b>{isDrive.value ? `Signed in as ${p?.name}` : 'Using this device only'}</b>
              <div class="small muted">{isDrive.value ? p?.email : 'Link Google later from Settings to keep takes in Drive.'}</div>
            </div>
            <IcDrive />
          </div>
          <div class={`step ${isDrive.value && links.root ? 'ok' : ''}`}>
            <div class="n">{isDrive.value && links.root ? <IcCheck size={18} /> : '2'}</div>
            <div>
              <b>SingersVoice folder in Drive</b>
              <div class="small muted">
                {isDrive.value
                  ? links.root
                    ? 'Tracks, Performances/Live, Performances/Offline, Temp, Config, Backgrounds, Exports'
                    : 'Creating folders…'
                  : 'Skipped in device mode (IndexedDB on this device).'}
              </div>
            </div>
            {links.root && (
              <a class="btn sm" href={links.root} target="_blank" rel="noopener">
                Open
              </a>
            )}
          </div>
          <div class={`step ${mic}`}>
            <div class="n">{mic === 'ok' ? <IcCheck size={18} /> : '3'}</div>
            <div>
              <b>Microphone</b>
              <div class="small muted">Needed to sing. Echo cancellation stays off for a clean vocal.</div>
            </div>
            <button class="btn sm" onClick={() => void testMic()} disabled={mic === 'busy'}>
              {mic === 'busy' ? <Spinner /> : <IcMic size={18} />} Test
            </button>
          </div>
          <div class={`step ${cam}`}>
            <div class="n">{cam === 'ok' ? <IcCheck size={18} /> : '4'}</div>
            <div>
              <b>Camera (optional)</b>
              <div class="small muted">Small self-view tile; lyrics keep the stage.</div>
            </div>
            <button class="btn sm" onClick={() => void testCam()} disabled={cam === 'busy'}>
              {cam === 'busy' ? <Spinner /> : <IcCamera size={18} />} Test
            </button>
          </div>
          <div class="step">
            <div class="n">
              <IcHeadphones size={18} />
            </div>
            <div>
              <b>Wear headphones</b>
              <div class="small muted">Keeps the backing track out of your vocal recording. Wired = lowest latency.</div>
            </div>
          </div>
          <div class={`step ${store}`}>
            <div class="n">{store === 'ok' ? <IcCheck size={18} /> : '6'}</div>
            <div>
              <b>Local storage protected</b>
              <div class="small muted">{store === 'ok' ? 'The browser will keep your in-progress takes.' : store === 'warn' ? 'Not granted — install the app to your home screen for durable storage.' : 'Checking…'}</div>
            </div>
          </div>
        </div>
      </div>
      <div class="actions">
        <button class="btn primary lg block" onClick={finish}>
          Go to my stage
        </button>
      </div>
    </div>
  );
}
