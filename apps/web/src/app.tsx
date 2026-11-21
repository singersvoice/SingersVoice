import { ErrorBoundary, LocationProvider, Route, Router, useLocation } from 'preact-iso';
import { useEffect } from 'preact/hooks';
import { Toasts } from './components/ui.tsx';
import { bindRouter, href, relPath } from './lib/nav.ts';
import { activeMeetId, activeRoomInfo, enterRoom, leaveRoom } from './portals/meets/activeRoom.ts';
import { MeetRoom } from './portals/meets/MeetRoom.tsx';
import { MeetsHome } from './portals/meets/MeetsHome.tsx';
import { PublishingPortal } from './portals/publishing/PublishingPortal.tsx';
import { ShowView } from './portals/publishing/ShowView.tsx';
import { Watch } from './portals/publishing/Watch.tsx';
import { Performances } from './portals/studio/Performances.tsx';
import { Sing, SingPicker } from './portals/studio/Sing.tsx';
import { StudioHome } from './portals/studio/StudioHome.tsx';
import { TrackMaker } from './portals/studio/TrackMaker.tsx';
import { TracksPortal } from './portals/tracks/TracksPortal.tsx';
import { Home } from './screens/Home.tsx';
import { Settings } from './screens/Settings.tsx';
import { Plans } from './screens/Plans.tsx';
import { BillingReturn } from './screens/BillingReturn.tsx';
import { Club } from './screens/Club.tsx';
import { Blocked } from './screens/Blocked.tsx';
import { CouponGate } from './screens/CouponGate.tsx';
import { AdminCoupons } from './screens/AdminCoupons.tsx';
import { Admin } from './screens/Admin.tsx';
import { TvCodeLink, TvScreen } from './screens/Tv.tsx';
import { Setup, Welcome } from './screens/Welcome.tsx';
import { blockedAccount, couponNeeded, signedIn } from './state/session.ts';
import { appSettings } from './state/settings.ts';

/** Signed-in area. A deep link (e.g. a meet invite) is remembered and resumed after sign-in. */
function Guard(props: { children: preact.ComponentChildren }) {
  const loc = useLocation();
  const ok = signedIn.value;
  useEffect(() => {
    if (!ok) {
      try {
        sessionStorage.setItem('sv.afterSignIn', loc.url);
      } catch {
        /* ignore */
      }
      loc.route(href('/'), true);
    } else if (!appSettings.value.onboarded && relPath(loc.path) !== '/setup') loc.route(href('/setup'), true);
  }, [ok, loc.path]);
  if (!ok) return null;
  // Blocked for good by a super admin: the notice in place of every page; the coupon gate likewise (coupons.ts).
  if (blockedAccount.value) return <Blocked />;
  if (couponNeeded.value) return <CouponGate />;
  return <>{props.children}</>;
}

function Bind() {
  const loc = useLocation();
  useEffect(() => bindRouter(loc.route), [loc.route]);
  return null;
}

/** The /meet/:id route only points the persistent room at this meet; RoomLayer renders it. */
function MeetEntry(props: { id: string }) {
  useEffect(() => {
    if (props.id) enterRoom(props.id);
  }, [props.id]);
  return null;
}

/**
 * The room you are in, mounted once for as long as you are in it: shown on /meet/:id, hidden (but
 * running — heartbeat, camera, video) on every other page, with a pill to return or leave.
 */
function RoomLayer() {
  const loc = useLocation();
  const id = activeMeetId.value;
  const info = activeRoomInfo.value;
  const ok = signedIn.value;
  const here = Boolean(id) && relPath(loc.path) === `/meet/${id}`;
  const over = info?.state === 'ended' || info?.state === 'expired';
  const gated = couponNeeded.value;
  useEffect(() => {
    if ((!ok || gated) && id) leaveRoom(); // signed out, or the coupon gate closed: the room goes
    else if (id && !here && over) leaveRoom(); // a finished meet does not follow you around
  }, [ok, gated, id, here, over]);
  if (!id || !ok || gated) return null;
  // Keyed, room first: the pill coming and going must never re-create the room's element (a
  // re-mount would restart the session, the camera and every video link).
  return (
    <>
      <div key="room" class={`roomlayer ${here ? '' : 'hidden'}`} aria-hidden={!here} data-visible={here ? '1' : '0'}>
        <MeetRoom key={id} id={id} />
      </div>
      {!here && info && (
        <div key="pill" class="roompill" role="status" data-meet={id}>
          <span class="dot" />
          <span class="txt">
            {info.onStage ? `On stage · S${info.slot}` : 'In the meet'} · {info.title}
          </span>
          <a class="btn sm primary" href={href(`/meet/${encodeURIComponent(id)}`)}>
            Return
          </a>
          <button class="btn sm" onClick={leaveRoom}>
            Leave
          </button>
        </div>
      )}
    </>
  );
}

function NotFound() {
  return (
    <div class="empty" style="min-height:60dvh">
      <h3>Page not found</h3>
      <a class="btn primary" href={href('/home')}>
        Home
      </a>
    </div>
  );
}

const r = (p: string) => href(p);
type P = { id?: string; code?: string };
const guarded = (el: (p: P) => preact.JSX.Element) => (p: P) => <Guard>{el(p)}</Guard>;

export function App() {
  return (
    <LocationProvider>
      <Bind />
      <ErrorBoundary onError={(e) => console.error(e)}>
        <Router>
          <Route path={r('/')} component={Welcome} />
          <Route path={r('/setup')} component={guarded(() => <Setup />)} />
          <Route path={r('/home')} component={guarded(() => <Home />)} />
          {/* Tracks portal */}
          <Route path={r('/tracks')} component={guarded(() => <TracksPortal />)} />
          <Route path={r('/library')} component={guarded(() => <TracksPortal />)} />
          {/* Studio portal (offline) */}
          <Route path={r('/studio')} component={guarded(() => <StudioHome />)} />
          <Route path={r('/studio/trackmaker')} component={guarded(() => <TrackMaker />)} />
          <Route path={r('/studio/trackmaker/:id')} component={guarded((p) => <TrackMaker id={p.id} />)} />
          <Route path={r('/studio/sing')} component={guarded(() => <SingPicker />)} />
          <Route path={r('/studio/sing/:id')} component={guarded((p) => <Sing id={p.id ?? ''} />)} />
          <Route path={r('/studio/join/:id')} component={guarded((p) => <Sing joinId={p.id ?? ''} />)} />
          <Route path={r('/studio/performances')} component={guarded(() => <Performances />)} />
          {/* Live Meets portal */}
          <Route path={r('/meets')} component={guarded(() => <MeetsHome />)} />
          <Route path={r('/meet/:id')} component={guarded((p) => <MeetEntry id={p.id ?? ''} />)} />
          {/* Publishing portal + public watch page */}
          <Route path={r('/publishing')} component={guarded(() => <PublishingPortal />)} />
          <Route path={r('/publishing/show/:id')} component={guarded((p) => <ShowView id={p.id ?? ''} />)} />
          <Route path={r('/watch/:id')} component={(p: P) => <Watch id={p.id ?? ''} />} />
          {/* The TV in the room (no sign-in); /tv/<code> on a phone connects it */}
          <Route path={r('/tv')} component={TvScreen} />
          <Route path={r('/tv/:code')} component={guarded((p) => <TvCodeLink code={p.code ?? ''} />)} />
          <Route path={r('/plans')} component={guarded(() => <Plans />)} />
          <Route path={r('/club-owner')} component={guarded(() => <Plans />)} />
          <Route path={r('/billing/return')} component={guarded(() => <BillingReturn />)} />
          <Route path={r('/club')} component={guarded(() => <Club />)} />
          <Route path={r('/admin')} component={guarded(() => <Admin />)} />
          <Route path={r('/admin/coupons')} component={guarded(() => <AdminCoupons />)} />
          <Route path={r('/settings')} component={guarded(() => <Settings />)} />
          <Route default component={NotFound} />
        </Router>
      </ErrorBoundary>
      <ErrorBoundary onError={(e) => console.error(e)}>
        <RoomLayer />
      </ErrorBoundary>
      <Toasts />
    </LocationProvider>
  );
}
