/**
 * The live links of a show: one button per platform the show goes to — "YouTube link", "Facebook
 * link", "Twitch link"… — that hands the publisher the page viewers open to watch (copied, or the
 * phone's share sheet), and the in-house watch page's link. A platform whose live link is not set
 * yet shows where to add it (Publishing › Destinations) instead.
 */
import { DESTINATIONS, type Destination, type DestinationKind } from '@singersvoice/protocol';
import { IcShare } from '../../components/icons.tsx';
import { shareOrCopy } from '../../lib/download.ts';
import { href } from '../../lib/nav.ts';
import { toast } from '../../lib/toast.ts';

/** The live link of each platform a show goes to: the page viewers open there, or null when the publisher has not set it. */
export function liveLinks(destinations: DestinationKind[], dests: Destination[], watchPage: string | null): { kind: DestinationKind; short: string; url: string | null }[] {
  return destinations.map((kind) => {
    const def = DESTINATIONS.find((d) => d.kind === kind);
    const short = def?.short ?? kind;
    if (kind === 'inhouse') return { kind, short, url: watchPage ? new URL(href(watchPage), location.href).toString() : null };
    return { kind, short, url: dests.find((d) => d.kind === kind)?.watchUrl || null };
  });
}

export async function giveLink(title: string, short: string, url: string): Promise<void> {
  const r = await shareOrCopy(`${title} — live on ${short}`, url, url);
  toast(r === 'copied' ? `${short} link copied — share it: ${url}` : r === 'shared' ? 'Shared' : url, r === 'failed' ? 'warn' : 'ok', 7000);
}

export function LiveLinks(props: { title: string; destinations: DestinationKind[]; dests: Destination[]; watchPage: string | null; compact?: boolean }) {
  const links = liveLinks(props.destinations, props.dests, props.watchPage);
  if (!links.length) return null;
  return (
    <div class="row livelinks" data-live-links={links.filter((l) => l.url).length} style="gap:6px;flex-wrap:wrap;align-items:center">
      {!props.compact && <span class="small muted">Live links:</span>}
      {links.map((l) =>
        l.url ? (
          <button key={l.kind} class="btn sm" aria-label={`${l.short} link`} title={`${l.url} — copies the link (or opens the share sheet)`} data-live-link={l.kind} onClick={() => void giveLink(props.title, l.short, l.url!)}>
            <IcShare size={14} /> {l.short} link
          </button>
        ) : (
          <a key={l.kind} class="chip warn" href={href('/publishing?tab=destinations')} target="_blank" rel="noopener" data-live-link-missing={l.kind} title={`Set your ${l.short} live link under Publishing › Destinations (the page viewers open to watch you)`}>
            add your {l.short} link
          </a>
        ),
      )}
    </div>
  );
}
