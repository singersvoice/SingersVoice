/**
 * Home — a search for any feature (components/FeatureSearch.tsx: a few letters list the matches, a tap goes there),
 * then the portals, each usable on its own, named as the menu names them: Tracks (with Track Maker), Studio, Live
 * Meets, Publishing (for the accounts it is open to: club owners with a year, super admins — everyone else finds the
 * Club owner card in its place), Performances.
 */
import { useEffect } from 'preact/hooks';
import { FeatureSearch } from '../components/FeatureSearch.tsx';
import { IcDrive, IcLibrary, IcMic, IcPlay, IcShare, IcUsers } from '../components/icons.tsx';
import { Page } from '../components/Shell.tsx';
import { checkControl, controlConfigured, controlStatus, refreshAccount } from '../lib/api.ts';
import { href } from '../lib/nav.ts';
import { hoursLabel } from '@singersvoice/protocol';
import { canPublish, entitlement, isDrive, ownsClub, profile, provider, role } from '../state/session.ts';

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
            {role.value === 'super_admin' ? (
              <span class="chip ok">super admin</span>
            ) : entitlement.value ? (
              <a href={href('/plans')} class={`chip ${entitlement.value.video ? 'ok' : ''}`} data-home-plan={entitlement.value.plan} title={entitlement.value.videoNote || 'Your plan — the Plans page'}>
                {entitlement.value.via === 'club' ? `${entitlement.value.clubOwner?.name ?? 'a club'}'s club` : entitlement.value.planTitle}
                {entitlement.value.videoLeftSeconds !== null && entitlement.value.videoHours > 0 ? ` · video ${hoursLabel(entitlement.value.videoLeftSeconds)} left` : entitlement.value.videoHours === 0 ? ' · voice in meets' : ''}
              </a>
            ) : role.value === 'audio' ? (
              <span class="chip">audio only</span>
            ) : null}
          </div>
        </section>

        <FeatureSearch />

        <nav class="quick portals" aria-label="Portals">
          <a href={href('/tracks')}>
            <IcLibrary />
            <b>Tracks</b>
            <span>Your Drive tracks, the public catalog (SVT DB), imports and sharing — and Track Maker, to build a track from a song</span>
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
          {canPublish.value || role.value === 'super_admin' ? (
            <a href={href('/publishing')} data-home-publishing>
              <IcShare />
              <b>Publishing</b>
              <span>Stream meets to YouTube and the in-house watch page</span>
            </a>
          ) : (
            <a href={href('/plans')} data-home-plans>
              <IcShare />
              <b>Plans</b>
              <span>{entitlement.value?.video ? `${entitlement.value.planTitle}: your picture on stage · ${hoursLabel(entitlement.value.videoLeftSeconds ?? 0)} of video left this month` : 'Your picture on stage in live meets — SVV, SVVPro, or a club of 15 with Publishing mode'}</span>
            </a>
          )}
          {ownsClub.value && role.value !== 'super_admin' && (
            <a href={href('/club')} data-home-club>
              <IcUsers />
              <b>My club</b>
              <span>The members of your club and the video hours you share</span>
            </a>
          )}
          <a href={href('/studio/performances')}>
            <IcPlay />
            <b>Performances</b>
            <span>Every saved show and take, by date and name — shared with everyone who sang, links to pass on</span>
          </a>
        </nav>

        <section class="card stack">
          <h3>How it fits together</h3>
          <p class="muted small">
            Tracks are files in each singer's Drive; publishing one shares its link through the catalog so anyone can pull it. The Studio works entirely offline. A Live Meet is a link anyone can
            join: performers take stage slots, every device starts the track at the same server instant, each singer's take stays personal in their own Drive. Publishing streams a meet out to the platforms
            for club owners (the Club owner plan — see <a href={href('/plans')}>Plans</a>). A picture on stage in a live meet comes with a plan; the voice is free.
          </p>
        </section>
      </div>
    </Page>
  );
}
