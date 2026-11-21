/**
 * Settings → Social: the networks connected for posting clips of saved performances from here, each on the
 * singer's own handle (protocol/social.ts). X connects on its own; Facebook and Instagram connect together
 * (one Meta sign-in: a Facebook Page the singer manages and the Instagram professional account linked to it
 * — the networks' rule, not ours: a personal profile or a personal Instagram account cannot be posted to by
 * any app, and Snapchat has no API at all, so none of those is offered). The sign-in happens on the
 * network's own page; the service keeps the tokens, never this device. Below: the box that offers a clip
 * after every take kept, the clip's starting length, and the posts made so far.
 */
import { safeHref } from '../lib/nav.ts';
import { socialTitle, type SocialNetwork, type SocialProvider, type SocialStatus } from '@singersvoice/protocol';
import { useEffect, useState } from 'preact/hooks';
import { api, controlConfigured } from '../lib/api.ts';
import { errorText, toast } from '../lib/toast.ts';
import { appSettings, updateApp } from '../state/settings.ts';
import { Field, Seg, Spinner, Switch } from './ui.tsx';

/** Where this app lives (origin + base path): the network sends the singer back to its Settings page. */
const appUrlHere = (): string => `${location.origin}${import.meta.env.BASE_URL}`;

export function SocialSettings() {
  const app = appSettings.value;
  const [status, setStatus] = useState<SocialStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = async () => {
    try {
      setStatus(await api.get('GET /social', '/social'));
    } catch (e) {
      toast(errorText(e), 'warn', 6000);
    }
  };
  useEffect(() => {
    if (!controlConfigured.value) return;
    void load();
    // Back from a network's sign-in page: say how it went, and clear the address.
    const q = new URLSearchParams(location.search);
    const back = q.get('social');
    if (back === 'x' || back === 'meta') {
      const ok = q.get('ok') === '1';
      const why = q.get('why') ?? '';
      if (ok && why === 'pick') toast('Facebook signed in — pick the Page to post to below', 'ok', 8000);
      else if (ok) toast(`${back === 'x' ? 'X' : 'Facebook and Instagram'} connected`, 'ok', 6000);
      else toast(`${back === 'x' ? 'X' : 'Facebook'} was not connected${why === 'no_page' ? ': that account manages no Facebook Page (Instagram posting needs a Page with a professional Instagram account linked)' : why ? `: ${why}` : ''}`, 'warn', 10000);
      q.delete('social');
      q.delete('ok');
      q.delete('why');
      history.replaceState(null, '', `${location.pathname}${q.toString() ? `?${q}` : ''}#social`);
      setTimeout(() => document.getElementById('social')?.scrollIntoView({ block: 'start' }), 50);
    }
  }, []);

  const connect = async (provider: SocialProvider) => {
    setBusy(provider);
    try {
      const { url } = await api.post('POST /social/:provider/connect', `/social/${provider}/connect`, { appUrl: appUrlHere() });
      location.assign(url);
    } catch (e) {
      toast(errorText(e), 'warn', 8000);
      setBusy(null);
    }
  };
  const disconnect = async (network: SocialNetwork) => {
    if (!confirm(`Disconnect ${socialTitle[network]}${network !== 'x' ? ' (Facebook and Instagram go together)' : ''}? Posts already made stay where they are.`)) return;
    setBusy(network);
    try {
      setStatus(await api.del('DELETE /social/:network', `/social/${network}`));
      toast(`${socialTitle[network]} disconnected`, 'ok');
    } catch (e) {
      toast(errorText(e), 'error', 8000);
    } finally {
      setBusy(null);
    }
  };
  const pickPage = async (pageId: string) => {
    setBusy(`page:${pageId}`);
    try {
      setStatus(await api.post('POST /social/meta/page', '/social/meta/page', { pageId }));
      toast('Facebook Page connected', 'ok');
    } catch (e) {
      toast(errorText(e), 'error', 8000);
    } finally {
      setBusy(null);
    }
  };

  const conn = (n: SocialNetwork) => status?.connections.find((c) => c.network === n) ?? null;
  const x = conn('x');
  const fb = conn('facebook');
  const ig = conn('instagram');
  return (
    <section class="card stack" id="social" data-social>
      <h2>Social</h2>
      <div class="small muted">
        Connect your networks here and any performance saved to your Drive posts to them from SingersVoice, on your own handle: pick the section (from–to), the clip is made on this device, <b>Post</b> sends it, and the link comes back. On a phone, <b>Share…</b> can also hand a clip to any app installed.
      </div>
      <div class="small faint" data-social-privacy>
        You sign in on the network's own page — SingersVoice never sees your password there. The network hands SingersVoice a key, which is sealed on the SingersVoice service (never on this device, never in your Drive), used only when you post, and deleted by Disconnect.
      </div>
      <Switch checked={app.socialOffer} onChange={(v) => updateApp({ socialOffer: v })} label="Offer to post a clip after I keep a take" hint="The clip sheet opens by itself when a take is kept; Post a clip is on every saved performance anyway." />
      <Field label="A clip starts out this long">
        <Seg<string> ariaLabel="Clip length" value={String(app.clipSeconds)} onChange={(v) => updateApp({ clipSeconds: Number(v) })} options={[{ v: '30', label: '30 s' }, { v: '60', label: '60 s' }, { v: '90', label: '90 s' }, { v: '120', label: '2 min' }]} />
      </Field>
      {!controlConfigured.value && <div class="callout warn">Connecting networks needs the SingersVoice service (VITE_CONTROL_URL). The share sheet and Download work without it.</div>}
      {controlConfigured.value && !status && (
        <div class="row">
          <Spinner /> Loading…
        </div>
      )}
      {status && (
        <div class="stack" style="gap:10px" data-social-networks>
          <div class="row wrap" style="gap:8px;align-items:center;padding:6px 0;border-top:1px solid var(--line, #ddd)" data-social-row="x">
            <b style="min-width:9em">X</b>
            {x ? (
              <>
                <span class="chip ok" data-social-handle="x">
                  {x.handle}
                </span>
                <span class="small muted">clips post as a video post on your account</span>
                <button class="btn sm" style="margin-left:auto" disabled={busy !== null} onClick={() => void disconnect('x')} data-social-disconnect="x">
                  Disconnect
                </button>
              </>
            ) : status.configured.x ? (
              <>
                <span class="small muted">a video post on your account, from here</span>
                <button class="btn sm primary" style="margin-left:auto" disabled={busy !== null} onClick={() => void connect('x')} data-social-connect="x">
                  {busy === 'x' ? <Spinner /> : null} Connect X
                </button>
              </>
            ) : (
              <span class="small faint" data-social-unconfigured="x">
                Not switched on yet — the SingersVoice admin does that on the Admin page (<i>Social posting</i>). <b>Connect X</b> appears here the moment it is.
              </span>
            )}
          </div>
          <div class="row wrap" style="gap:8px;align-items:center;padding:6px 0;border-top:1px solid var(--line, #ddd)" data-social-row="facebook">
            <b style="min-width:9em">Facebook Page</b>
            {fb ? (
              <>
                <span class="chip ok" data-social-handle="facebook">
                  {fb.handle}
                </span>
                <span class="small muted">clips post as a video on the Page</span>
                <button class="btn sm" style="margin-left:auto" disabled={busy !== null} onClick={() => void disconnect('facebook')} data-social-disconnect="facebook">
                  Disconnect
                </button>
              </>
            ) : status.configured.meta ? (
              <>
                <span class="small muted">a video on a Facebook Page you manage (a personal profile cannot be posted to by any app — Facebook's rule), and the Instagram professional account linked to it</span>
                <button class="btn sm primary" style="margin-left:auto" disabled={busy !== null} onClick={() => void connect('meta')} data-social-connect="meta">
                  {busy === 'meta' ? <Spinner /> : null} Connect Facebook &amp; Instagram
                </button>
              </>
            ) : (
              <span class="small faint" data-social-unconfigured="meta">
                Not switched on yet — the SingersVoice admin does that on the Admin page (<i>Social posting</i>). <b>Connect Facebook &amp; Instagram</b> appears here the moment it is.
              </span>
            )}
          </div>
          {status.pagesToPick.length > 0 && (
            <div class="stack" style="gap:6px" data-social-pages>
              <div class="small muted">You manage several Pages — which one posts your clips?</div>
              <div class="row wrap" style="gap:8px">
                {status.pagesToPick.map((p) => (
                  <button class="btn sm primary" key={p.pageId} disabled={busy !== null} onClick={() => void pickPage(p.pageId)} data-social-page={p.pageId}>
                    {busy === `page:${p.pageId}` ? <Spinner /> : null} {p.name}
                    {p.instagram ? ` · Instagram @${p.instagram.username}` : ''}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div class="row wrap" style="gap:8px;align-items:center;padding:6px 0;border-top:1px solid var(--line, #ddd)" data-social-row="instagram">
            <b style="min-width:9em">Instagram</b>
            {ig ? (
              <>
                <span class="chip ok" data-social-handle="instagram">
                  @{ig.handle}
                </span>
                <span class="small muted">clips post as a Reel (comes with the Facebook Page above)</span>
              </>
            ) : fb ? (
              <span class="small faint">The Page "{fb.handle}" has no Instagram professional account linked to it. Link one in Instagram → Settings → Account → Sharing to other apps, then connect Facebook again.</span>
            ) : (
              <span class="small faint">A professional (business or creator) Instagram account linked to a Facebook Page — connect Facebook &amp; Instagram above. A personal account cannot be posted to by any app (Instagram's rule): switch it to professional, free, in Instagram → Settings → Account type.</span>
            )}
          </div>
          {status.posts.length > 0 && (
            <div class="stack" style="gap:4px" data-social-posts>
              <b class="small">Posted from here</b>
              {status.posts.map((p) => (
                <div class="row wrap small" style="gap:8px;align-items:center" key={p.postId} data-social-post={p.postId} data-social-post-status={p.status}>
                  <span class="muted" style="min-width:6em">{new Date(p.createdAt).toLocaleDateString()}</span>
                  <span class={`chip ${p.status === 'posted' ? 'ok' : p.status === 'failed' ? 'warn' : ''}`}>
                    {socialTitle[p.network]} · {p.status}
                  </span>
                  <span>{p.title}</span>
                  {p.url && (
                    <a href={safeHref(p.url)} target="_blank" rel="noopener">
                      open
                    </a>
                  )}
                  {p.note && <span class="faint">{p.note}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
