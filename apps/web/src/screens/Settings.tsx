import { useEffect, useState } from 'preact/hooks';
import { BackgroundPicker } from '../components/BackgroundPicker.tsx';
import { FxPanel } from '../components/FxPanel.tsx';
import { IcDrive } from '../components/icons.tsx';
import { Page } from '../components/Shell.tsx';
import { Field, Seg, Switch } from '../components/ui.tsx';
import { googleConfigured } from '../lib/google.ts';
import { idb, STORES } from '../lib/idb.ts';
import { asset, go, href } from '../lib/nav.ts';
import { bytes, isStandalone, platformName } from '../lib/platform.ts';
import { errorText, toast } from '../lib/toast.ts';
import { isDrive, privileged, profile, provider, signInWithGoogle, signOut, withProvider } from '../state/session.ts';
import { checkControl, controlStatus, controlUrl, controlVersion, refreshAccount, setControlUrl } from '../lib/api.ts';
import { appSettings, audioSettings, pullSettings, updateApp, updateAudio } from '../state/settings.ts';

interface Version {
  version: string;
  commit: string;
  builtAt: string;
}

export function Settings() {
  const app = appSettings.value;
  const audio = audioSettings.value;
  const p = profile.value;
  const [quota, setQuota] = useState<{ used: number; total: number } | null>(null);
  const [links, setLinks] = useState(provider.value.links());
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [cams, setCams] = useState<MediaDeviceInfo[]>([]);
  const [version, setVersion] = useState<Version | null>(null);

  useEffect(() => {
    void withProvider(async (pr) => {
      await pr.ready();
      setLinks(pr.links());
      setQuota(await pr.quota());
    }).catch(() => undefined);
    void navigator.mediaDevices?.enumerateDevices?.().then((d) => {
      setMics(d.filter((x) => x.kind === 'audioinput'));
      setCams(d.filter((x) => x.kind === 'videoinput'));
    });
    void checkControl().then(() => refreshAccount());
    fetch(asset('version.json'))
      .then((r) => (r.ok ? (r.json() as Promise<Version>) : null))
      .then((v) => v && setVersion(v))
      .catch(() => undefined);
    if (location.hash === '#backgrounds') document.getElementById('backgrounds')?.scrollIntoView();
  }, []);

  const link = async () => {
    try {
      await signInWithGoogle();
      await pullSettings();
      toast('Google Drive linked', 'ok');
      setLinks(provider.value.links());
    } catch (e) {
      toast(errorText(e), 'error', 7000);
    }
  };
  const out = async () => {
    await signOut();
    go('/', true);
  };
  const wipe = async () => {
    if (!confirm('Remove all tracks, takes and settings stored on this device? Drive files are not touched.')) return;
    for (const s of Object.values(STORES)) await idb.clear(s);
    localStorage.clear();
    sessionStorage.clear();
    location.reload();
  };

  return (
    <Page title="Settings">
      <div class="stack" style="gap:18px">
        <section class="card stack">
          <h2>Account & Google Drive</h2>
          <div class="row">
            <div class="avatar">{p?.picture ? <img src={p.picture} alt="" referrerpolicy="no-referrer" /> : (p?.name ?? '?').charAt(0)}</div>
            <div>
              <b>{p?.name ?? 'Not signed in'}</b>
              <div class="small muted">{isDrive.value ? p?.email : 'Device mode — files live in this browser'}</div>
            </div>
          </div>
          {isDrive.value ? (
            <>
              <div class="row">
                {links.root && (
                  <a class="btn sm" href={links.root} target="_blank" rel="noopener">
                    <IcDrive size={16} /> SingersVoice folder
                  </a>
                )}
                {links.tracks && (
                  <a class="btn sm" href={links.tracks} target="_blank" rel="noopener">
                    Tracks
                  </a>
                )}
                {links.performances && (
                  <a class="btn sm" href={links.performances} target="_blank" rel="noopener">
                    Performances
                  </a>
                )}
              </div>
              {quota && (
                <div class="small muted">
                  Drive storage: {bytes(quota.used)} of {quota.total ? bytes(quota.total) : 'unlimited'} used
                </div>
              )}
              <button class="btn danger" onClick={() => void out()}>
                Sign out (revokes Drive access token)
              </button>
            </>
          ) : (
            <>
              {quota && (
                <div class="small muted">
                  Device storage: {bytes(quota.used)} of {bytes(quota.total)}
                </div>
              )}
              <button class="btn primary" disabled={!googleConfigured} onClick={() => void link()}>
                <IcDrive /> Link Google Drive
              </button>
              {!googleConfigured && <div class="small faint">Needs VITE_GOOGLE_CLIENT_ID at build time — see docs/GOOGLE_OAUTH.md.</div>}
            </>
          )}
        </section>

        <section class="card stack">
          <h2>Live services (SVT DB)</h2>
          <div class="row">
            <span class={`chip ${controlStatus.value === 'online' ? 'ok' : controlStatus.value === 'unconfigured' ? '' : 'warn'}`}>
              {controlStatus.value === 'online' ? `online${controlVersion.value ? ` · v${controlVersion.value}` : ''}` : controlStatus.value === 'checking' ? 'checking…' : controlStatus.value === 'offline' ? 'unreachable' : 'not configured'}
            </span>
            {privileged.value && <span class="chip ok">privileged (Publishing)</span>}
            <a class="btn sm" href={href('/publishing')}>
              Publishing portal
            </a>
          </div>
          <Field label="Service URL" hint="Set at build time by VITE_CONTROL_URL; override here to test another deployment (leave empty to reset).">
            <input class="input mono" value={controlUrl.value} placeholder="https://sv-control.<account>.workers.dev" onChange={(e) => setControlUrl((e.currentTarget as HTMLInputElement).value)} />
          </Field>
          <p class="small muted">The catalog, live meets and publishing talk to this service. Your audio, video and track files never go through it — they live in your Drive.</p>
        </section>

        <section class="card stack">
          <h2>Display</h2>
          <Field label="Lyrics text size">
            <Seg<string>
              value={String(app.textScale)}
              onChange={(v) => updateApp({ textScale: Number(v) })}
              options={[
                { v: '1', label: 'A' },
                { v: '1.3', label: 'A+' },
                { v: '1.6', label: 'A++' },
                { v: '2', label: 'Max' },
              ]}
            />
          </Field>
          <Switch checked={app.highContrastLyrics} onChange={(v) => updateApp({ highContrastLyrics: v })} label="High-contrast lyrics" />
          <Switch checked={app.countIn} onChange={(v) => updateApp({ countIn: v })} label="3-2-1 count-in before the song" />
          <Switch checked={app.showCueDeck} onChange={(v) => updateApp({ showCueDeck: v })} label="Cue deck (my next lines)" />
        </section>

        <section class="card stack">
          <h2>Audio</h2>
          <Field label="Microphone">
            <select class="input" value={app.audioInputId} onChange={(e) => updateApp({ audioInputId: (e.currentTarget as HTMLSelectElement).value })}>
              <option value="">System default</option>
              {mics.map((m) => (
                <option key={m.deviceId} value={m.deviceId}>
                  {m.label || `Microphone ${m.deviceId.slice(0, 6)}`}
                </option>
              ))}
            </select>
          </Field>
          <Switch checked={app.echoCancellation} onChange={(v) => updateApp({ echoCancellation: v })} label="Echo cancellation" hint="Off = cleanest vocal (use headphones). On = speakers without headphones, lower quality." />
          <Switch checked={audio.monitor} onChange={(v) => updateAudio({ monitor: v })} label="Hear myself while singing" hint="Headphones only." />
          <Field label={`Backing level in your ears ${Math.round(audio.backingGain * 100)}%`} hint="Only what you hear while singing. The show, the recording and the audience get the track at its own balance (Track / Vocal volume on the stage).">
            <input type="range" min={0} max={1} step={0.01} value={audio.backingGain} onInput={(e) => updateAudio({ backingGain: Number((e.currentTarget as HTMLInputElement).value) })} />
          </Field>
        </section>

        <section class="card stack">
          <h2>VoxForge voice</h2>
          <p class="small muted">Saved automatically to {isDrive.value ? 'Drive › SingersVoice › Config › audio_plugin_settings.json' : 'this device'}.</p>
          <FxPanel value={audio} onChange={updateAudio} />
        </section>

        <section class="card stack">
          <h2>Camera</h2>
          <Switch checked={app.cameraOn} onChange={(v) => updateApp({ cameraOn: v })} label="Camera on stage" />
          <Field label="Camera device">
            <select class="input" value={app.cameraDeviceId} onChange={(e) => updateApp({ cameraDeviceId: (e.currentTarget as HTMLSelectElement).value })}>
              <option value="">Auto (front camera)</option>
              {cams.map((c) => (
                <option key={c.deviceId} value={c.deviceId}>
                  {c.label || `Camera ${c.deviceId.slice(0, 6)}`}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Framing" hint="Chest keeps you head-to-chest from wherever you sit (the default); Wide is the whole camera frame; Mid and Close crop in around the face. This exact picture is you on every stage.">
            <Seg<'chest' | 'wide' | 'mid' | 'close'>
              value={app.zoomPreset}
              onChange={(v) => updateApp({ zoomPreset: v })}
              options={[
                { v: 'chest', label: 'Chest' },
                { v: 'wide', label: 'Wide' },
                { v: 'mid', label: 'Mid' },
                { v: 'close', label: 'Close' },
              ]}
            />
          </Field>
          <Switch checked={app.autoZoom} onChange={(v) => updateApp({ autoZoom: v })} label="Auto zoom while singing" hint="Eases a little closer while you sing and back out when you're silent — on everyone's screen." />
          <Switch checked={app.cutout} onChange={(v) => updateApp({ cutout: v })} label="Person cut-out" hint="Segmentation model, loaded on demand." />
        </section>

        <section class="card stack" id="backgrounds">
          <h2>Stage & publishing backgrounds</h2>
          <BackgroundPicker value={app.backgroundId} onChange={(id) => updateApp({ backgroundId: id })} />
        </section>

        <section class="card stack">
          <h2>About</h2>
          <div class="small muted">
            SingersVoice v2 · {platformName}
            {isStandalone ? ' · installed app' : ' · browser'} {version && `· build ${version.version} (${version.commit || 'local'})`}
          </div>
          <div class="small muted">Restore point RP1 = branch <span class="kbd">restore/RP1</span> in the GitHub repo.</div>
          <button class="btn danger sm" onClick={() => void wipe()}>
            Reset this device's data
          </button>
        </section>
      </div>
    </Page>
  );
}
