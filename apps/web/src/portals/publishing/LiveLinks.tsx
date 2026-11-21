/**
 * The live links of a show, one per platform the show goes to, each written out in full with a
 * Copy button (the phone's share sheet where there is one) — the page viewers open to watch:
 * YouTube's (the broadcast the app made for this very show, else the channel's standing live
 * link), Facebook's, Twitch's… and the in-house watch page's. A platform whose live link is not
 * set yet shows where to add it (Publishing › Destinations) instead. After the show, the YouTube
 * link is the video's: it stays.
 */
import { DESTINATIONS, type Destination, type DestinationKind } from '@singersvoice/protocol';
import { IcShare } from '../../components/icons.tsx';
import { shareOrCopy } from '../../lib/download.ts';
import { href, safeHref } from '../../lib/nav.ts';
import { toast } from '../../lib/toast.ts';

/**
 * The live link of each platform a show goes to: the page of this very show where the app made it (a YouTube
 * broadcast of its own, `links`), else the platform's standing link the publisher set, or null when there is none.
 */
export function liveLinks(destinations: DestinationKind[], dests: Destination[], watchPage: string | null, links?: Partial<Record<DestinationKind, string>>): { kind: DestinationKind; short: string; url: string | null }[] {
  return destinations.map((kind) => {
    const def = DESTINATIONS.find((d) => d.kind === kind);
    const short = def?.short ?? kind;
    if (kind === 'inhouse') return { kind, short, url: watchPage ? new URL(href(watchPage), location.href).toString() : null };
    return { kind, short, url: links?.[kind] || dests.find((d) => d.kind === kind)?.watchUrl || null };
  });
}

export async function giveLink(title: string, short: string, url: string): Promise<void> {
  const r = await shareOrCopy(`${title} — live on ${short}`, url, url);
  toast(r === 'copied' ? `${short} link copied — share it: ${url}` : r === 'shared' ? 'Shared' : url, r === 'failed' ? 'warn' : 'ok', 7000);
}

export function LiveLinks(props: {
  title: string;
  destinations: DestinationKind[];
  dests: Destination[];
  watchPage: string | null;
  links?: Partial<Record<DestinationKind, string>>;
  compact?: boolean;
  /** The show is over: only the links that still lead somewhere (the YouTube video), said so. */
  over?: boolean;
}) {
  let links = liveLinks(props.destinations, props.dests, props.watchPage, props.links);
  if (props.over) links = links.filter((l) => l.kind === 'youtube' && props.links?.youtube);
  if (!links.length) return null;
  return (
    <div class="livelinks" data-live-links={links.filter((l) => l.url).length}>
      {!props.compact && <span class="small muted">{props.over ? 'The show is over — the video stays at this link:' : 'Share with your viewers:'}</span>}
      {links.map((l) =>
        l.url ? (
          <span key={l.kind} class="livelink" data-live-link-row={l.kind}>
            <b class="small">{l.short}</b>
            <a class="url mono small" href={safeHref(l.url)} target="_blank" rel="noopener" data-live-url={l.kind} title={`Open the ${l.short} page viewers watch on`}>
              {l.url}
            </a>
            <button class="btn sm" aria-label={`${l.short} link`} title="Copies the link (or opens the share sheet)" data-live-link={l.kind} onClick={() => void giveLink(props.title, l.short, l.url!)}>
              <IcShare size={14} /> Copy
            </button>
          </span>
        ) : (
          <a key={l.kind} class="chip warn" href={href('/publishing?tab=destinations')} target="_blank" rel="noopener" data-live-link-missing={l.kind} title={`Set your ${l.short} live link under Publishing › Destinations (the page viewers open to watch you)`}>
            add your {l.short} link
          </a>
        ),
      )}
    </div>
  );
}
