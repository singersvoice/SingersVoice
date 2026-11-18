/**
 * The bookmark star on a song's row — one tap keeps the song (filled), one more drops it (outlined); the
 * same state everywhere the song shows (lib/bookmarks.ts). A row that has no bookmark to offer yet (a
 * track of my own Drive, registered on the first tap) hands a `resolve` instead of an `input` — or
 * both: the input says whether the star is filled, and what is kept comes from `resolve` (the
 * database's record of the song, with its language), so a bookmark says as much as is known.
 */
import type { BookmarkInput } from '@singersvoice/protocol';
import { useState } from 'preact/hooks';
import { bookmarks, isBookmarked, toggleBookmark } from '../lib/bookmarks.ts';
import { controlConfigured } from '../lib/api.ts';
import { errorText, toast } from '../lib/toast.ts';
import { IcStar } from './icons.tsx';
import { Spinner } from './ui.tsx';

export function BookmarkButton(props: { input?: BookmarkInput | null; resolve?: () => Promise<BookmarkInput | null>; size?: number; label?: string }) {
  const [busy, setBusy] = useState(false);
  void bookmarks.value; // a change of any bookmark redraws the star
  const input = props.input ?? null;
  const on = input ? isBookmarked(input.kind, input.ref) : false;
  if (!controlConfigured.value) return null;
  const tap = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const what = on ? input : ((await props.resolve?.()) ?? input);
      if (!what) return toast('Bookmarks need Google Drive and the SingersVoice service', 'warn');
      const kept = await toggleBookmark(what);
      toast(kept ? `"${what.title}" bookmarked` : `"${what.title}" removed from your bookmarks`, 'ok', 2500);
    } catch (e) {
      toast(errorText(e), 'error', 6000);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" class={`btn icon sm bookmark ${on ? 'on' : ''}`} aria-pressed={on} aria-label={props.label ?? (on ? 'Remove bookmark' : 'Bookmark')} title={on ? 'Bookmarked — tap to remove' : 'Bookmark'} disabled={busy} onClick={() => void tap()} data-bookmark={input ? `${input.kind}:${input.ref}` : ''} data-bookmarked={on ? '1' : '0'}>
      {busy ? <Spinner /> : <IcStar size={props.size ?? 18} filled={on} />}
    </button>
  );
}
