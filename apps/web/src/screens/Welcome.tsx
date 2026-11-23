import { useEffect, useMemo, useState } from 'preact/hooks';
import { inAppBrowser, openInBrowserUrl } from '../lib/browserEnv.ts';
import { DRIVE_TICK, DriveScopeMissingError, googleConfigured, loadGis } from '../lib/google.ts';
import { asset, go } from '../lib/nav.ts';
import { isIOS, isStandalone, persistStorage, platformName } from '../lib/platform.ts';
import { checkMediaPermissions, permissionHelp, requestMediaAccess } from '../lib/permissions.ts';
import { errorText, toast } from '../lib/toast.ts';
import { busy, continueOnDevice, isDrive, profile, provider, signInWithGoogle, signedIn, staleDeviceSession } from '../state/session.ts';
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

  // Have Google's sign-in library in hand before the first tap: the sign-in window has to open within the tap.
  useEffect(() => {
    if (googleConfigured) void loadGis().catch(() => undefined);
  }, []);
  const inApp = useMemo(() => inAppBrowser(), []);
  const openOutside = () => {
    const u = openInBrowserUrl(window.location.href);
    if (u) window.location.href = u;
  };

  // Google's screen came back without the Drive box ticked: a step to show, not an error to report.
  const [tick, setTick] = useState(false);
  const onGoogle = async () => {
    try {
      await signInWithGoogle();
      await pullSettings();
      go('/setup', true);
    } catch (e) {
      if (e instanceof DriveScopeMissingError) setTick(true);
      else toast(errorText(e), 'error', 7000);
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
        <p class="muted tagline" data-tagline>
          <b>For everyone who lives and breathes music.</b> Find your songs. Feel every lyric. Sing together and save to your Drive.
        </p>
      </div>
      <div class="actions">
        {tick && (
          <div class="callout" data-tick-drive>
            <b>One more tick.</b> On Google&rsquo;s screen, tick <i>&ldquo;{DRIVE_TICK}&rdquo;</i> &mdash; that is where your takes and tracks are kept &mdash; then Continue.
          </div>
        )}
        <button class="btn primary lg block" disabled={busy.value !== null || !googleConfigured} onClick={() => void onGoogle()}>
          {busy.value ? <Spinner /> : <IcDrive />}
          {busy.value ?? 'Continue with Google'}
        </button>
        {googleConfigured && !tick && (
          <p class="small faint" style="text-align:center;margin:0" data-drive-hint>
            On Google&rsquo;s screen, tick the Google Drive box &mdash; your takes and tracks are kept in your own Drive.
          </p>
        )}
        {inApp && (
          <div class="callout warn" style="text-align:center" data-in-app-browser>
            <b>You are inside {inApp}&rsquo;s built-in browser</b>, where Google sign-in cannot open. Open SingersVoice in your real browser:
            <div class="row" style="justify-content:center;margin-top:8px;gap:8px">
              {openInBrowserUrl(window.location.href) && (
                <button class="btn" onClick={openOutside}>
                  Open in {/iPhone|iPad|iPod/i.test(navigator.userAgent) ? 'Safari' : 'Chrome'}
                </button>
              )}
              <button
                class="btn"
                onClick={() => {
                  void navigator.clipboard?.writeText(window.location.href).then(() => toast('Link copied — paste it in Safari or Chrome', 'ok'));
                }}
              >
                Copy the link
              </button>
            </div>
            <div class="small muted" style="margin-top:6px">Or tap the ⋯ or share button and choose &ldquo;Open in browser&rdquo;.</div>
          </div>
        )}
        <p class="small muted" style="text-align:center">
          Google sign-in is required: your tracks, takes and settings are stored in <b>your</b> Google Drive (folder <span class="kbd">SingersVoice</span>), never on our servers.
        </p>
        {staleDeviceSession.value && (
          <div class="callout" style="text-align:center">
            This device was in developer preview. Google sign-in is now on — continue with Google to use the catalog, live meets and publishing. Files made in preview stay in this browser.
          </div>
        )}
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
        <p class="small faint" style="text-align:center">
          <a href={asset('privacy.html')} target="_blank" rel="noopener">
            Privacy policy
          </a>{' '}
          ·{' '}
          <a href={asset('terms.html')} target="_blank" rel="noopener">
            Terms of service
          </a>
        </p>
      </div>
    </div>
  );
}

type Check = 'idle' | 'ok' | 'warn' | 'busy';

export function Setup() {
  /** The camera and the microphone, asked for together — one prompt — and what the browser said. */
  const [media, setMedia] = useState<Check>('idle');
  const [mediaNote, setMediaNote] = useState<string>('');
  const [store, setStore] = useState<Check>('idle');
  const [links, setLinks] = useState<{ root?: string; tracks?: string }>({});
  const [folderError, setFolderError] = useState<string | null>(null);

  // The SingersVoice folder in Drive: made (or found) now; a refusal shows on its step with a Retry, never as an error of the sign-in.
  const folders = async () => {
    setFolderError(null);
    try {
      await provider.value.ready();
      setLinks(provider.value.links());
    } catch (e) {
      setFolderError(errorText(e));
    }
  };
  useEffect(() => {
    if (!signedIn.value) {
      go('/', true);
      return;
    }
    void (async () => {
      await folders();
      setStore((await persistStorage()) ? 'ok' : 'warn');
    })();
  }, []);

  // The browser's own word on the two, where it gives one: already allowed is shown as done — nothing is asked twice.
  useEffect(() => {
    void checkMediaPermissions().then((p) => {
      if (p.camera === 'granted' && p.microphone === 'granted') {
        setMedia('ok');
        setMediaNote('Already allowed in this browser.');
      } else if (p.microphone === 'denied' || p.camera === 'denied') {
        setMedia('warn');
        setMediaNote(`${p.microphone === 'denied' ? 'The microphone' : 'The camera'} is blocked in this browser. ${permissionHelp(p.microphone === 'denied' ? 'microphone' : 'camera')}`);
      }
    });
  }, []);
  const allow = async (withCamera: boolean) => {
    setMedia('busy');
    const r = await requestMediaAccess({ camera: withCamera });
    updateApp({ mediaAskedAt: new Date().toISOString() });
    if (r.microphone === 'granted' && (r.camera === 'granted' || r.camera === 'skipped')) {
      setMedia('ok');
      setMediaNote(`${r.microphoneLabel || 'Microphone'}${r.camera === 'granted' ? ` · ${r.cameraLabel || 'camera'}` : ' (no camera asked)'} — allowed. ${isIOS && !isStandalone ? 'On iPhone, Safari asks once per visit unless SingersVoice is added to the Home Screen or its Website Settings say Allow.' : 'This browser remembers the answer.'}`);
    } else if (r.microphone === 'granted') {
      setMedia('ok');
      setMediaNote(r.camera === 'none' ? 'Microphone allowed · no camera on this device (singing with the voice alone).' : `Microphone allowed · the camera was refused — singing without video until it is allowed. ${permissionHelp('camera')}`);
    } else {
      setMedia('warn');
      setMediaNote(r.microphone === 'none' ? 'No microphone was found on this device.' : `The microphone was refused — SingersVoice cannot hear you until it is allowed. ${permissionHelp('microphone')}`);
      toast('Microphone permission was denied', 'warn', 6000);
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
          <div class={`step ${isDrive.value && links.root ? 'ok' : folderError ? 'warn' : ''}`} data-drive-folders={links.root ? 'ok' : folderError ? 'error' : 'busy'}>
            <div class="n">{isDrive.value && links.root ? <IcCheck size={18} /> : '2'}</div>
            <div>
              <b>SingersVoice folder in Drive</b>
              <div class="small muted">
                {isDrive.value
                  ? links.root
                    ? 'Tracks, Performances/Live, Performances/Offline, Temp, Config, Backgrounds, Exports'
                    : folderError
                      ? `Not made yet (${folderError}) — tap Retry`
                      : 'Creating folders…'
                  : 'Skipped in device mode (IndexedDB on this device).'}
              </div>
            </div>
            {links.root && (
              <a class="btn sm" href={links.root} target="_blank" rel="noopener">
                Open
              </a>
            )}
            {!links.root && folderError && (
              <button class="btn sm" onClick={() => void folders()} data-drive-folders-retry>
                Retry
              </button>
            )}
          </div>
          <div class={`step ${media}`} data-media-step={media}>
            <div class="n">{media === 'ok' ? <IcCheck size={18} /> : '3'}</div>
            <div>
              <b>Camera &amp; microphone</b>
              <div class="small muted">{mediaNote || 'One tap, one question from the browser — for both at once. The microphone is needed to sing; the camera puts you on the stage. Allowed once, the browser remembers.'}</div>
            </div>
            <div class="row" style="gap:6px;flex-wrap:wrap;justify-content:flex-end">
              <button class="btn sm primary" onClick={() => void allow(true)} disabled={media === 'busy'} data-allow-media>
                {media === 'busy' ? <Spinner /> : <IcCamera size={18} />} {media === 'ok' ? 'Ask again' : 'Allow both'}
              </button>
              {media !== 'ok' && (
                <button class="btn sm" onClick={() => void allow(false)} disabled={media === 'busy'} data-allow-mic>
                  <IcMic size={18} /> Mic only
                </button>
              )}
            </div>
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
            <div class="n">{store === 'ok' ? <IcCheck size={18} /> : '5'}</div>
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
