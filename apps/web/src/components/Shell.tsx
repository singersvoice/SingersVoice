import type { ComponentChildren, JSX } from 'preact';
import { useLocation } from 'preact-iso';
import { useState } from 'preact/hooks';
import { asset, href, relPath } from '../lib/nav.ts';
import { toast } from '../lib/toast.ts';
import { canPublish, isSuperAdmin, needsReconnect, profile, reconnect } from '../state/session.ts';
import { IcHome, IcLibrary, IcMic, IcMore, IcPlay, IcSettings, IcShare, IcSliders, IcUsers, IcX } from './icons.tsx';

/** The mark, always in motion: the brand loop (two singers on their disc), the still mark where motion is turned off. */
export function Logo(props: { word?: boolean }) {
  return (
    <a class="brand" href={href('/home')} aria-label="SingersVoice home">
      <BrandLoop class="mark" />
      {props.word !== false && (
        <span class="word">
          Singers<b>Voice</b>
        </span>
      )}
    </a>
  );
}

/** The animated mark: a small silent loop (the still mark as its poster, and in its place for people who turn motion off). */
export function BrandLoop(props: { class?: string }) {
  return (
    <span class={`brandloop ${props.class ?? ''}`}>
      <video src={asset('brand/sv-loop-sm.mp4')} poster={asset('brand/poster.jpg')} muted loop autoPlay playsInline disablePictureInPicture aria-hidden="true" />
      <img src={asset('brand/sv-mark.png')} alt="" />
    </span>
  );
}

/** The brand, mid size, in a corner of every screen — a watermark in motion, never in the way (no pointer events; not in any recording: a page element, not the stage). */
export function BrandWatermark() {
  return (
    <div class="watermark" aria-hidden="true">
      <BrandLoop />
    </div>
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

/**
 * The portals, named the same everywhere — the Home cards, the side menu on a wide screen, the tab
 * bar on a phone: Home · Tracks (with Track Maker under it) · Studio · Live Meets · Publishing ·
 * Performances · Settings. A phone's bar holds the first four and More, which opens the rest.
 *
 * Who sees what (`when`): Publishing is listed for the accounts it is open to — club owners with an
 * active year and super admins — and nobody else; Admin for super admins alone; the Club owner page
 * (become one, pay for a year, renew) for everyone who is not a super admin. The service enforces
 * the same on every request; the menu only keeps what an account cannot use out of its way.
 */
type NavWhen = 'super_admin' | 'publish' | 'not_super_admin';
export interface NavItem {
  to: string;
  label: string;
  Icon: (p: { size?: number }) => JSX.Element;
  primary?: boolean;
  /** Paths that light this entry besides its own. */
  also?: string[];
  /** Shown to these accounts only (everyone when unset). */
  when?: NavWhen;
  /** Entries listed under this one on a wide screen (`when`: shown to those accounts only). */
  children?: { to: string; label: string; when?: NavWhen }[];
}
export const NAV: NavItem[] = [
  { to: '/home', label: 'Home', Icon: IcHome },
  { to: '/tracks', label: 'Tracks', Icon: IcLibrary, also: ['/library', '/studio/trackmaker'], children: [{ to: '/studio/trackmaker', label: 'Track Maker' }] },
  { to: '/studio', label: 'Studio', Icon: IcMic, primary: true },
  { to: '/meets', label: 'Live Meets', Icon: IcUsers, also: ['/meet/'] },
  { to: '/publishing', label: 'Publishing', Icon: IcShare, also: ['/watch/'], when: 'publish' },
  { to: '/studio/performances', label: 'Performances', Icon: IcPlay },
  {
    to: '/settings',
    label: 'Settings',
    Icon: IcSettings,
    also: ['/plans', '/club-owner', '/setup', '/admin'],
    children: [
      { to: '/club-owner', label: 'Club owner', when: 'not_super_admin' },
      { to: '/admin', label: 'Admin', when: 'super_admin' },
    ],
  },
];
/** On a phone: the first four portals and More. */
const PHONE_TABS = 4;

/** Is an entry for this account? */
export const navAllowed = (when: NavWhen | undefined): boolean => (when === 'super_admin' ? isSuperAdmin.value : when === 'not_super_admin' ? !isSuperAdmin.value : when === 'publish' ? canPublish.value || isSuperAdmin.value : true);
/** The portals this account sees. */
export const visibleNav = (): NavItem[] => NAV.filter((n) => navAllowed(n.when));

const isActive = (rel: string, n: { to: string; also?: string[] }): boolean => {
  const hit = (p: string) => rel === p || rel.startsWith(p.endsWith('/') ? p : `${p}/`);
  if (n.to === '/studio') return hit('/studio') && !rel.startsWith('/studio/performances') && !rel.startsWith('/studio/trackmaker');
  return hit(n.to) || (n.also ?? []).some(hit);
};

/** The entries under a portal this account sees. */
const visibleChildren = (n: NavItem) => (n.children ?? []).filter((c) => navAllowed(c.when));

export function NavBar() {
  const { path } = useLocation();
  const rel = relPath(path);
  const [more, setMore] = useState(false);
  const nav = visibleNav();
  const rest = nav.slice(PHONE_TABS);
  const moreActive = rest.some((n) => isActive(rel, n));
  // The More panel sits beside the bar, not inside it: the bar is its own stacking layer, and the panel must float above toasts.
  return (
    <>
      <nav class="navbar" aria-label="Primary">
        {nav.map((n, i) => {
          const active = isActive(rel, n);
          const children = visibleChildren(n);
          const childActive = children.find((c) => rel === c.to || rel.startsWith(`${c.to}/`));
          return (
            <span key={n.to} class={`navitem ${i >= PHONE_TABS ? 'wide-only' : ''}`}>
              <a href={href(n.to)} class={`${active && !childActive ? 'active' : ''} ${n.primary ? 'primary' : ''}`} aria-current={active && !childActive ? 'page' : undefined}>
                <span class="ico">
                  <n.Icon />
                </span>
                <span>{n.label}</span>
              </a>
              {children.map((c) => (
                <a key={c.to} href={href(c.to)} class={`sub ${childActive?.to === c.to ? 'active' : ''}`} aria-current={childActive?.to === c.to ? 'page' : undefined}>
                  <span class="ico" />
                  <span>{c.label}</span>
                </a>
              ))}
            </span>
          );
        })}
        <span class="navitem phone-only">
          <button type="button" class={`more ${moreActive ? 'active' : ''}`} aria-label="More" aria-expanded={more} onClick={() => setMore((o) => !o)}>
            <span class="ico">
              <IcMore />
            </span>
            <span>More</span>
          </button>
        </span>
      </nav>
      {more && (
        <div class="navmore" role="dialog" aria-label="More">
          <div class="row between">
            <b>More</b>
            <button type="button" class="btn icon sm" aria-label="Close" onClick={() => setMore(false)}>
              <IcX size={16} />
            </button>
          </div>
          {rest.map((n) => (
            <a key={n.to} href={href(n.to)} class={isActive(rel, n) ? 'active' : ''} onClick={() => setMore(false)}>
              <n.Icon size={18} /> {n.label}
            </a>
          ))}
          {nav.flatMap((n) => visibleChildren(n)).map((c) => (
            <a key={c.to} href={href(c.to)} class={rel.startsWith(c.to) ? 'active' : ''} onClick={() => setMore(false)}>
              <IcSliders size={18} /> {c.label}
            </a>
          ))}
        </div>
      )}
    </>
  );
}

export function Page(props: { title?: string; right?: ComponentChildren; full?: boolean; children: ComponentChildren; nav?: boolean }) {
  return (
    <div class={`shell ${props.nav === false ? 'nonav' : ''}`}>
      <TopBar title={props.title} right={props.right} />
      <main class={`content ${props.full ? 'full' : ''}`}>{props.children}</main>
      {props.nav !== false && <NavBar />}
      <BrandWatermark />
    </div>
  );
}
