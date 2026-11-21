/**
 * Admin → Social posting: how SingersVoice is registered with X and with Meta (Facebook Pages and Instagram),
 * so singers can connect their own handles in Settings → Social and post from here. Each network gives the
 * operator an id and a secret on its developer page once SingersVoice is registered there; they are pasted
 * here (the secret is sealed on the service, never shown again, never in the repo), and the Connect buttons
 * appear for every singer at once — no deploy. The address each network needs as "the way back" is shown
 * with a Copy button. docs/SOCIAL.md has the registration click by click.
 */
import type { AdminSocialStatus } from '@singersvoice/protocol';
import { useEffect, useState } from 'preact/hooks';
import { Spinner } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { errorText, toast } from '../lib/toast.ts';

const copy = async (text: string, what: string) => {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied`, 'ok');
  } catch {
    toast(text, 'info', 8000);
  }
};

function ProviderBox(props: { provider: 'x' | 'meta'; status: AdminSocialStatus; onSaved: (s: AdminSocialStatus) => void }) {
  const { provider, status } = props;
  const cur = provider === 'x' ? status.x : status.meta;
  const id = provider === 'x' ? status.x.clientId : status.meta.appId;
  const [idIn, setIdIn] = useState(id);
  const [secretIn, setSecretIn] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setIdIn(id), [id]);
  const title = provider === 'x' ? 'X' : 'Facebook & Instagram (Meta)';
  const idName = provider === 'x' ? 'OAuth 2.0 Client ID' : 'App ID';
  const secretName = provider === 'x' ? 'Client Secret' : 'App Secret';
  const site = provider === 'x' ? 'https://developer.x.com/en/portal/dashboard' : 'https://developers.facebook.com/apps/';
  const callback = provider === 'x' ? status.callbacks.x : status.callbacks.meta;
  const on = Boolean(id && cur.secretSet);
  const save = async (clear = false) => {
    setBusy(true);
    try {
      const body = provider === 'x' ? { xClientId: clear ? '' : idIn, xClientSecret: clear ? '' : secretIn } : { metaAppId: clear ? '' : idIn, metaAppSecret: clear ? '' : secretIn };
      const s = await api.put('PUT /admin/social', '/admin/social', body);
      props.onSaved(s);
      setSecretIn('');
      toast(clear ? `${title}: switched off` : `${title}: switched on — singers see Connect in Settings → Social now`, 'ok', 6000);
    } catch (e) {
      toast(errorText(e), 'error', 8000);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="stack" style="gap:8px;padding:8px 0;border-top:1px solid var(--line, #ddd)" data-social-app={provider}>
      <div class="row between wrap" style="align-items:center">
        <b>{title}</b>
        <span class={`chip ${on ? 'ok' : 'warn'}`} data-social-app-state={on ? 'on' : 'off'}>
          {on ? (cur.fromEnv ? 'on (from the deploy)' : 'on') : 'off — singers cannot connect yet'}
        </span>
      </div>
      <div class="small muted">
        1. Open{' '}
        <a href={site} target="_blank" rel="noopener">
          {provider === 'x' ? 'developer.x.com' : 'developers.facebook.com'}
        </a>{' '}
        and register SingersVoice as an app (docs/SOCIAL.md, step by step). 2. Where it asks for the callback / redirect address, paste this one. 3. Copy the {idName} and the {secretName} it gives you into the boxes here and Save.
      </div>
      <div class="row wrap" style="gap:8px;align-items:center">
        <span class="small muted">The way back:</span>
        <code class="mono small" style="word-break:break-all" data-social-app-callback={provider}>
          {callback}
        </code>
        <button class="btn sm" onClick={() => void copy(callback, 'The callback address')} data-social-app-copy={provider}>
          Copy
        </button>
      </div>
      <div class="row wrap" style="gap:8px;align-items:flex-end">
        <div class="field" style="margin:0;flex:1;min-width:14em">
          <label>{idName}</label>
          <input class="input mono" value={idIn} placeholder={provider === 'x' ? 'e.g. Q1pZ…' : 'e.g. 1234567890'} autoComplete="off" spellcheck={false} data-social-app-id={provider} onInput={(e) => setIdIn((e.currentTarget as HTMLInputElement).value)} />
        </div>
        <div class="field" style="margin:0;flex:1;min-width:14em">
          <label>
            {secretName}
            {cur.secretSet && idIn === id ? <span class="muted"> · set (paste again only to change it)</span> : null}
          </label>
          <input class="input mono" type="password" value={secretIn} placeholder={cur.secretSet && idIn === id ? '••••••••' : 'paste it here'} autoComplete="new-password" data-social-app-secret={provider} onInput={(e) => setSecretIn((e.currentTarget as HTMLInputElement).value)} />
        </div>
        <button class="btn primary" disabled={busy || !idIn.trim() || (!secretIn && !(cur.secretSet && idIn === id))} data-social-app-save={provider} onClick={() => void save()}>
          {busy ? <Spinner /> : null} Save
        </button>
        {on && !cur.fromEnv && (
          <button class="btn danger" disabled={busy} data-social-app-clear={provider} onClick={() => confirm(`Switch posting to ${title} off for every singer?`) && void save(true)}>
            Switch off
          </button>
        )}
      </div>
    </div>
  );
}

export function AdminSocial() {
  const [status, setStatus] = useState<AdminSocialStatus | null>(null);
  useEffect(() => {
    api
      .get('GET /admin/social', '/admin/social')
      .then(setStatus)
      .catch((e) => toast(errorText(e), 'error', 8000));
  }, []);
  return (
    <section class="card stack pad-sm" id="social-apps" data-admin-social>
      <div>
        <h3 style="margin:0">Social posting</h3>
        <div class="small muted">Register SingersVoice once with X and once with Meta, paste what they give you here, and every singer can connect their own X, Facebook Page and Instagram in Settings → Social and post performances from the app. Nothing here goes to the singers' devices; the secrets are sealed on the service.</div>
      </div>
      {!status && (
        <div class="row">
          <Spinner /> Loading…
        </div>
      )}
      {status && (
        <>
          <ProviderBox provider="x" status={status} onSaved={setStatus} />
          <ProviderBox provider="meta" status={status} onSaved={setStatus} />
          {status.meta.appId && status.meta.secretSet && <div class="small faint">Meta: until the app passes Meta's review it works for the people named under the app's roles (you, testers); docs/SOCIAL.md says how to ask for the review.</div>}
        </>
      )}
    </section>
  );
}
