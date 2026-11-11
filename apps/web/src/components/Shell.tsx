import type { ComponentChildren } from 'preact';
import { useLocation } from 'preact-iso';
import { asset, href, relPath } from '../lib/nav.ts';
import { toast } from '../lib/toast.ts';
import { needsReconnect, profile, reconnect } from '../state/session.ts';
import { IcHome, IcLibrary, IcMic, IcMore, IcUsers } from './icons.tsx';

export function Logo(props: { word?: boolean }) {
  return (
    <a class="brand" href={href('/home')} aria-label="SingersVoice home">
      <img src={asset('brand/sv-mark.png')} alt="" width="60" height="34" />
      {props.word !== false && (
        <span class="word">
          Singers<b>Voice</b>
        </span>
      )}
    </a>
  );
}

export function TopBar(props: { title?: string; right?: ComponentChildren }) {
  const p = profile.value;
  const initial = (p?.name ?? '?').trim().charAt(0).toUpperCase() || '?';
  return (
    <header class="topbar">
      <Logo word={!props.title} />
      <div class="title">{props.title ?? ''}</div>
      {props.right}
      {needsReconnect.value && p?.mode === 'drive' && (
        <button class="btn sm accent" onClick={() => void reconnect().catch((e) => toast(String(e), 'error'))}>
          Reconnect Drive
        </button>
      )}
      <a href={href('/settings')} class="avatar" aria-label="Settings">
        {p?.picture ? <img src={p.picture} alt="" referrerpolicy="no-referrer" /> : initial}
      </a>
    </header>
  );
}

const NAV = [
  { to: '/home', label: 'Home', Icon: IcHome },
  { to: '/tracks', label: 'Tracks', Icon: IcLibrary },
  { to: '/studio', label: 'Studio', Icon: IcMic, primary: true },
  { to: '/meets', label: 'Meets', Icon: IcUsers },
  { to: '/settings', label: 'More', Icon: IcMore },
];

export function NavBar() {
  const { path } = useLocation();
  const rel = relPath(path);
  return (
    <nav class="navbar" aria-label="Primary">
      {NAV.map((n) => {
        const active = rel === n.to || rel.startsWith(`${n.to}/`) || (n.to === '/meets' && rel.startsWith('/meet/')) || (n.to === '/settings' && rel.startsWith('/publishing'));
        return (
          <a key={n.to} href={href(n.to)} class={`${active ? 'active' : ''} ${n.primary ? 'primary' : ''}`} aria-current={active ? 'page' : undefined}>
            <span class="ico">
              <n.Icon />
            </span>
            <span>{n.label}</span>
          </a>
        );
      })}
    </nav>
  );
}

export function Page(props: { title?: string; right?: ComponentChildren; full?: boolean; children: ComponentChildren; nav?: boolean }) {
  return (
    <div class={`shell ${props.nav === false ? 'nonav' : ''}`}>
      <TopBar title={props.title} right={props.right} />
      <main class={`content ${props.full ? 'full' : ''}`}>{props.children}</main>
      {props.nav !== false && <NavBar />}
    </div>
  );
}
