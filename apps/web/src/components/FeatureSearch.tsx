/**
 * The search on Home: type a few letters of any feature — "tv", "block", "promo", "sync", "youtube" — and the
 * matches are listed with where they live; a tap, or Enter on the first (the arrow keys move the choice), goes
 * there (lib/features.ts has every feature and the words for it).
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { searchFeatures, type Feature } from '../lib/features.ts';
import { go } from '../lib/nav.ts';
import { IcSearch } from './icons.tsx';

export function FeatureSearch() {
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const [hits, setHits] = useState<Feature[]>([]);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setHits(searchFeatures(q));
    setAt(0);
  }, [q]);
  const open = (f: Feature) => {
    setQ('');
    go(f.path);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setAt((i) => Math.min(hits.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setAt((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      const f = hits[at];
      if (f) open(f);
    } else if (e.key === 'Escape') setQ('');
  };
  return (
    <section class="feature-search" data-feature-search>
      <label class="feature-search-box">
        <IcSearch size={18} />
        <input class="input" type="search" value={q} placeholder="Find anything — TV, block someone, promo code, sync, YouTube tracks…" aria-label="Find a feature" autoComplete="off" spellcheck={false} data-feature-query onInput={(e) => setQ((e.currentTarget as HTMLInputElement).value)} onKeyDown={onKey} />
      </label>
      {q.trim() && (
        <div class="feature-results" ref={list} role="listbox" aria-label="Features found" data-feature-results>
          {hits.length === 0 && (
            <div class="small muted" style="padding:8px 12px" data-feature-none>
              Nothing called that — try another word (songs, meet, plan, camera, voice, settings…).
            </div>
          )}
          {hits.map((f, i) => (
            <button type="button" class={`feature-hit ${i === at ? 'on' : ''}`} role="option" aria-selected={i === at} key={f.path + f.title} data-feature-hit={f.path} onMouseEnter={() => setAt(i)} onClick={() => open(f)}>
              <b>{f.title}</b>
              <span class="muted small">{f.where}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
