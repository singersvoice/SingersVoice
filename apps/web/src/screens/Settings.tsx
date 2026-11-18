import { hoursLabel, roleTitle } from '@singersvoice/protocol';
import { useEffect, useState } from 'preact/hooks';
import { BackgroundPicker } from '../components/BackgroundPicker.tsx';
import { FxPanel } from '../components/FxPanel.tsx';
import { IcDrive } from '../components/icons.tsx';
import { dbLabel, INSTRUMENT_LEVELS } from '../components/MicStatus.tsx';
import { Page } from '../components/Shell.tsx';
import { SongPrefsCard } from '../components/SongPrefs.tsx';
import { Field, Seg, Switch } from '../components/ui.tsx';
import { DriveScopeMissingError, googleConfigured, loadGis } from '../lib/google.ts';
import { idb, STORES } from '../lib/idb.ts';
import { asset, go, href } from '../lib/nav.ts';
import { bytes, isStandalone, platformName } from '../lib/platform.ts';
import { errorText, toast } from '../lib/toast.ts';
import { canPublish, entitlement, isDrive, isSuperAdmin, ownsClub, profile, provider, role, signInWithGoogle, signOut, withProvider } from '../state/session.ts';
import { checkControl, controlStatus, controlUrl, controlVersion, refreshAccount, setControlUrl } from '../lib/api.ts';
import { appSettings, audioSettings, pullSettings, updateApp, updateAudio } from '../state/settings.ts';

interface Version {
  version: string;
  commit: string;
  builtAt: string;
}

export function Settings() {
  useEffect(() => {
    if (googleConfigured) void loadGis().catch(() => undefined); // the sign-in window must open within the tap
  }, []);
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
      toast(errorText(e), e instanceof DriveScopeMissingError ? 'warn' : 'error', 9000); // the Drive box left unticked is a step, not a failure
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
          {!isSuperAdmin.value && (
            <div class="row wrap" data-settings-standing>
              {entitlement.value && (
                <span class={`chip ${entitlement.value.video ? 'ok' : ''}`} data-settings-plan={entitlement.value.plan}>
                  {entitlement.value.via === 'club' ? `${entitlement.value.clubOwner?.name ?? 'a club'}'s club` : entitlement.value.planTitle}
                  {entitlement.value.videoHours > 0 ? ` · video ${hoursLabel(entitlement.value.videoLeftSeconds ?? 0)} left` : ' · voice in meets'}
                </span>
              )}
              <a class="btn sm" href={href('/plans')} data-plans-link>
                Plans
              </a>
              {ownsClub.value && (
                <a class="btn sm" href={href('/club')} data-club-link>
                  My club
                </a>
              )}
              {canPublish.value && (
                <a class="btn sm" href={href('/publishing')}>
                  Publishing portal
                </a>
              )}
            </div>
          )}
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

        {isSuperAdmin.value && (
          <section class="card stack" data-live-services>
            <h2>Live services (SVT DB)</h2>
            <div class="row wrap">
              <span class={`chip ${controlStatus.value === 'online' ? 'ok' : controlStatus.value === 'unconfigured' ? '' : 'warn'}`}>
                {controlStatus.value === 'online' ? `online${controlVersion.value ? ` · v${controlVersion.value}` : ''}` : controlStatus.value === 'checking' ? 'checking…' : controlStatus.value === 'offline' ? 'unreachable' : 'not configured'}
              </span>
              <span class="chip ok">{roleTitle(role.value)}</span>
              <a class="btn sm" href={href('/admin')}>
                Admin
              </a>
              <a class="btn sm" href={href('/publishing')}>
                Publishing portal
              </a>
            </div>
            <Field label="Service URL" hint="Set at build time by VITE_CONTROL_URL; override on this device to test another deployment (leave empty to reset). Singers never see this section.">
              <input class="input mono" value={controlUrl.value} placeholder="https://sv-control.<account>.workers.dev" data-service-url onChange={(e) => setControlUrl((e.currentTarget as HTMLInputElement).value)} />
            </Field>
            <p class="small muted">The catalog, live meets and publishing talk to the SingersVoice service. Audio, video and track files never go through it — they live in each singer's Drive.</p>
          </section>
        )}

        <SongPrefsCard />

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
          <Switch checked={app.instrumentOn} onChange={(v) => updateApp({ instrumentOn: v })} label="Instrument" hint="A second input — a guitar, keys, a violin on a USB audio interface — mixed into your sound on stage, in the recording and on the stream. Not on iPhone or iPad (one capture per page)." />
          {app.instrumentOn && (
            <Field label="Instrument input (USB interface)" hint="Plug the interface in first; it is listed with the microphones.">
              <select class="input" value={app.instrumentDeviceId} data-instrument-input onChange={(e) => updateApp({ instrumentDeviceId: (e.currentTarget as HTMLSelectElement).value })}>
                <option value="">Pick the USB input…</option>
                {mics.map((m) => (
                  <option key={m.deviceId} value={m.deviceId}>
                    {m.label || `Input ${m.deviceId.slice(0, 6)}`}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {app.instrumentOn && (
            <Field label="Instrument level">
              <select class="input" value={String(app.instrumentDb)} data-instrument-level onChange={(e) => updateApp({ instrumentDb: Number((e.currentTarget as HTMLSelectElement).value) })}>
                {INSTRUMENT_LEVELS.map((db) => (
                  <option key={db} value={String(db)}>
                    {dbLabel(db)}
                  </option>
                ))}
              </select>
            </Field>
          )}
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
          <Switch checked={app.cameraOn && role.value !== 'audio'} onChange={(v) => updateApp({ cameraOn: v })} label={role.value === 'audio' ? 'Camera on stage (your account is audio only — the SingersVoice admin can change that)' : entitlement.value && !entitlement.value.video && role.value !== 'super_admin' ? 'Camera on stage (in live meets your plan gives the voice alone — the Studio keeps the camera; see Plans)' : 'Camera on stage'} disabled={role.value === 'audio'} />
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
          <div class="muted small">On every stage you are framed the same way as every other singer — head the same size, at the same place — however near or far you sit from the camera; the stage tells you when to sit back or come closer.</div>
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
