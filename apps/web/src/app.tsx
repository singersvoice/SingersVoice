import { ErrorBoundary, LocationProvider, Route, Router, useLocation } from 'preact-iso';
import { useEffect } from 'preact/hooks';
import { Toasts } from './components/ui.tsx';
import { bindRouter, href, relPath } from './lib/nav.ts';
import { Home } from './screens/Home.tsx';
import { Library } from './screens/Library.tsx';
import { Meets } from './screens/Meets.tsx';
import { Performances } from './screens/Performances.tsx';
import { Settings } from './screens/Settings.tsx';
import { Sing, SingPicker } from './screens/Sing.tsx';
import { TrackMaker } from './screens/TrackMaker.tsx';
import { Setup, Welcome } from './screens/Welcome.tsx';
import { signedIn } from './state/session.ts';
import { appSettings } from './state/settings.ts';

function Guard(props: { children: preact.ComponentChildren }) {
  const loc = useLocation();
  const ok = signedIn.value;
  useEffect(() => {
    if (!ok) loc.route(href('/'), true);
    else if (!appSettings.value.onboarded && relPath(loc.path) !== '/setup') loc.route(href('/setup'), true);
  }, [ok, loc.path]);
  if (!ok) return null;
  return <>{props.children}</>;
}

function Bind() {
  const loc = useLocation();
  useEffect(() => bindRouter(loc.route), [loc.route]);
  return null;
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

export function App() {
  return (
    <LocationProvider>
      <Bind />
      <ErrorBoundary onError={(e) => console.error(e)}>
        <Router>
          <Route path={r('/')} component={Welcome} />
          <Route path={r('/setup')} component={() => <Guard><Setup /></Guard>} />
          <Route path={r('/home')} component={() => <Guard><Home /></Guard>} />
          <Route path={r('/library')} component={() => <Guard><Library /></Guard>} />
          <Route path={r('/trackmaker')} component={() => <Guard><TrackMaker /></Guard>} />
          <Route path={r('/trackmaker/:id')} component={(p: { id?: string }) => <Guard><TrackMaker id={p.id} /></Guard>} />
          <Route path={r('/sing')} component={() => <Guard><SingPicker /></Guard>} />
          <Route path={r('/sing/:id')} component={(p: { id?: string }) => <Guard><Sing id={p.id ?? ''} /></Guard>} />
          <Route path={r('/performances')} component={() => <Guard><Performances /></Guard>} />
          <Route path={r('/meets')} component={() => <Guard><Meets /></Guard>} />
          <Route path={r('/settings')} component={() => <Guard><Settings /></Guard>} />
          <Route default component={NotFound} />
        </Router>
      </ErrorBoundary>
      <Toasts />
    </LocationProvider>
  );
}
