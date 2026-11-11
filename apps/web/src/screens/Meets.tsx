import { MAX_PERFORMERS } from '@singersvoice/protocol';
import { useEffect, useState } from 'preact/hooks';
import { backgroundById, backgroundSrc, loadBackgrounds, BackgroundPicker } from '../components/BackgroundPicker.tsx';
import { IcChat, IcUsers } from '../components/icons.tsx';
import { Page } from '../components/Shell.tsx';
import { Field, Sheet } from '../components/ui.tsx';
import { asset, href } from '../lib/nav.ts';
import { profile } from '../state/session.ts';
import { appSettings, updateApp } from '../state/settings.ts';

const CONTROL_URL = (import.meta.env.VITE_CONTROL_URL ?? '').trim();

/**
 * Meets: live stage for up to 10 performers + unlimited audience with chat.
 * The stage layout, backgrounds and chat panel are real; going live needs the sv-control
 * service (services/control) deployed and VITE_CONTROL_URL set — until then this screen
 * previews the publishing look and links to solo rehearsal.
 */
export function Meets() {
  const app = appSettings.value;
  const [bgOpen, setBgOpen] = useState(false);
  const [performers, setPerformers] = useState(3);
  const [status, setStatus] = useState<'unconfigured' | 'checking' | 'online' | 'offline'>(CONTROL_URL ? 'checking' : 'unconfigured');

  useEffect(() => {
    void loadBackgrounds();
    if (!CONTROL_URL) return;
    const http = CONTROL_URL.replace(/^ws/, 'http');
    fetch(`${http}/health`, { mode: 'cors' })
      .then((r) => setStatus(r.ok ? 'online' : 'offline'))
      .catch(() => setStatus('offline'));
  }, []);

  const bg = backgroundById(app.backgroundId);
  const me = profile.value?.name?.split(' ')[0] ?? 'You';
  const names = [me, 'Anu', 'Ravi', 'Priya', 'Kiran', 'Meena', 'Arjun', 'Divya', 'Sai', 'Lakshmi'];

  return (
    <Page title="Meets">
      <div class="stack">
        <div class="stage-preview" style={{ backgroundImage: bg ? `url(${backgroundSrc(bg)})` : undefined }}>
          <img class="logo" src={asset('brand/sv-mark.png')} alt="SingersVoice" />
          {Array.from({ length: MAX_PERFORMERS }, (_, i) => {
            const n = MAX_PERFORMERS;
            const x = 6 + (i * 88) / (n - 1);
            const filled = i < performers;
            return (
              <div key={i} class={`perf ${filled ? '' : 'empty'}`} style={{ left: `${x}%` }} title={filled ? names[i] : 'open slot'}>
                {filled ? names[i] : ''}
              </div>
            );
          })}
          <div class="chat" aria-hidden="true">
            <div>Audience · 128 watching</div>
            <div>🎤 Anu: that harmony!</div>
            <div>👏 Ravi: encore</div>
          </div>
        </div>

        <div class="card stack">
          <div class="row between">
            <h2>Live stage</h2>
            <span class={`chip ${status === 'online' ? 'ok' : status === 'unconfigured' ? '' : 'warn'}`}>
              {status === 'online' ? 'sv-control online' : status === 'checking' ? 'checking…' : status === 'offline' ? 'sv-control unreachable' : 'sv-control not deployed'}
            </span>
          </div>
          <p class="muted small">
            Up to {MAX_PERFORMERS} performers sing to the same backing track from a shared start instant (GMT kickstart); each device records its own vocal and the session container mixes the
            stream for the audience, who watch and chat. The static app you're testing now is the client side; the control plane (services/control) and the per-meet session container come next.
          </p>
          <Field label={`Preview with ${performers} performer${performers > 1 ? 's' : ''}`}>
            <input type="range" min={1} max={MAX_PERFORMERS} value={performers} onInput={(e) => setPerformers(Number((e.currentTarget as HTMLInputElement).value))} />
          </Field>
          <div class="row">
            <button class="btn" onClick={() => setBgOpen(true)}>
              Publishing background
            </button>
            <a class="btn primary" href={href('/sing')}>
              Rehearse solo now
            </a>
            <button class="btn ghost" disabled>
              <IcUsers /> Create meet {status === 'online' ? '' : '(needs sv-control)'}
            </button>
          </div>
        </div>

        <div class="card stack">
          <h3>
            <IcChat size={18} /> Audience & chat
          </h3>
          <p class="muted small">Audience joins by link, watches the composed stream (LL-HLS or YouTube embed) and chats; chat history is kept 90 days. Performers see chat in the "others" strip without it covering the lyrics.</p>
        </div>
      </div>
      <Sheet open={bgOpen} onClose={() => setBgOpen(false)} title="Publishing background">
        <BackgroundPicker value={app.backgroundId} onChange={(id) => updateApp({ backgroundId: id })} />
      </Sheet>
    </Page>
  );
}
