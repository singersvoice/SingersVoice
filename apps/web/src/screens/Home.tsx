/** Home — the four portals, each usable on its own: Tracks, Studio, Live Meets, Publishing. */
import { useEffect } from 'preact/hooks';
import { IcDrive, IcLibrary, IcMic, IcShare, IcUsers } from '../components/icons.tsx';
import { Page } from '../components/Shell.tsx';
import { checkControl, controlConfigured, controlStatus, refreshAccount } from '../lib/api.ts';
import { href } from '../lib/nav.ts';
import { isDrive, privileged, profile, provider } from '../state/session.ts';

export function Home() {
  useEffect(() => {
    if (controlConfigured.value) {
      void checkControl();
      void refreshAccount();
    }
    void provider.value.ready().catch(() => undefined);
  }, []);
  const name = (profile.value?.name ?? 'Singer').split(' ')[0];
  const svc = controlStatus.value;
  return (
    <Page>
      <div class="stack" style="gap:18px">
        <section class="home-hero">
          <h1>Hi {name}, ready to sing?</h1>
          <p class="muted">{isDrive.value ? 'Everything you make lands in your Google Drive › SingersVoice.' : 'Developer preview on this device — sign in with Google for Drive storage.'}</p>
          <div class="row">
            <span class={`chip ${isDrive.value ? 'ok' : 'warn'}`}>
              <IcDrive size={14} /> {isDrive.value ? 'Drive linked' : 'device only'}
            </span>
            <span class={`chip ${svc === 'online' ? 'ok' : svc === 'unconfigured' ? '' : 'warn'}`}>SVT DB · {svc === 'online' ? 'online' : svc === 'checking' ? 'checking' : svc === 'offline' ? 'unreachable' : 'not deployed'}</span>
            {privileged.value && <span class="chip ok">privileged</span>}
          </div>
        </section>

        <nav class="quick portals" aria-label="Portals">
          <a href={href('/tracks')}>
            <IcLibrary />
            <b>Tracks</b>
            <span>Your Drive tracks, the public catalog (SVT DB), imports and sharing</span>
          </a>
          <a href={href('/studio')} class="primary">
            <IcMic />
            <b>Studio</b>
            <span>Build tracks offline, sing solo, keep takes</span>
          </a>
          <a href={href('/meets')}>
            <IcUsers />
            <b>Live Meets</b>
            <span>Shareable room, up to 10 on stage, audience chat, closes after 5 idle minutes</span>
          </a>
          <a href={href('/publishing')}>
            <IcShare />
            <b>Publishing</b>
            <span>{privileged.value ? 'Stream meets to YouTube, Facebook, Instagram, Twitch, in-house' : 'For privileged users — streaming to YouTube, Facebook, Instagram, Twitch'}</span>
          </a>
        </nav>

        <section class="card stack">
          <h3>How it fits together</h3>
          <p class="muted small">
            Tracks are files in each singer's Drive; publishing one shares its link through the catalog so anyone can pull it. The Studio works entirely offline. A Live Meet is a link anyone can
            join: performers take stage slots, every device starts the track at the same server instant, each singer's take stays personal in their own Drive. Publishing streams a meet out to the platforms
            for privileged users.
          </p>
        </section>
      </div>
    </Page>
  );
}
